import { randomUUID } from 'node:crypto';
import type { Card, Hold } from '@velox/core';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './llm/types.js';
import type { Registry } from './mcp/registry.js';
import { internalTools, invokeInternalTool, type SessionLedger } from './internal.js';
import { systemPrompt } from './prompt.js';

export interface AgentSession {
  id: string;
  asOf: string;
  messages: LlmMessage[];
  ledger: SessionLedger;
}

export interface LoopEvent {
  type: 'say' | 'call' | 'result' | 'card' | 'chip' | 'error';
  [key: string]: unknown;
}

interface ToolCallResult {
  call: ToolUseBlock;
  response: Record<string, unknown>;
  ok: boolean;
  elapsedMs: number;
  card?: Card;
  chip?: string;
}

function readStructuredValue(value: Record<string, unknown>): Record<string, unknown> {
  if (value.structuredContent && typeof value.structuredContent === 'object' && !Array.isArray(value.structuredContent)) {
    return value.structuredContent as Record<string, unknown>;
  }
  return value;
}

function rememberResult(call: ToolUseBlock, result: Record<string, unknown>, ledger: SessionLedger): void {
  const structured = readStructuredValue(result);
  if (Array.isArray(structured.offers)) {
    for (const offer of structured.offers) {
      if (offer && typeof offer === 'object' && typeof (offer as Record<string, unknown>).id === 'string') {
        const record = offer as Record<string, unknown>;
        ledger.offers.set(record.id as string, record);
      }
    }
  }
  if (
    typeof structured.hold_id === 'string' &&
    typeof structured.offer_id === 'string' &&
    typeof structured.amount === 'number' &&
    typeof structured.qty === 'number' &&
    typeof structured.expires_at === 'string' &&
    typeof structured.state === 'string'
  ) {
    const hold: Hold = {
      hold_id: structured.hold_id,
      offer_id: structured.offer_id,
      amount: structured.amount,
      qty: structured.qty,
      expires_at: structured.expires_at,
      state: structured.state as Hold['state'],
      server: call.name.split('__')[0] as Hold['server'],
    };
    ledger.holds.set(hold.hold_id, hold);
  }
}

function compactResult(result: Record<string, unknown>): Record<string, unknown> {
  const structured = readStructuredValue(result);
  if (!Array.isArray(structured.offers)) return structured;
  const offers = structured.offers.slice(0, 6).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const offer = entry as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    for (const key of ['id', 'name', 'flight_no', 'price_per_pax', 'price_per_night', 'price_per_head', 'depart', 'arrive', 'area', 'tags']) {
      if (offer[key] !== undefined) compact[key] = offer[key];
    }
    return compact;
  });
  return { ...structured, offers };
}

function summary(result: Record<string, unknown>): string {
  const structured = readStructuredValue(result);
  if (Array.isArray(structured.offers)) return `${structured.offers.length} offers`;
  if (typeof structured.amount === 'number') return `held INR ${structured.amount}`;
  if (structured.ok === false && typeof structured.over_by === 'number') return `over budget by INR ${structured.over_by}`;
  if (structured.card && typeof structured.card === 'object') {
    const card = structured.card as Record<string, unknown>;
    return typeof card.total === 'number' ? `itinerary total INR ${card.total}` : 'options shown';
  }
  return structured.isError === true ? 'tool returned an error' : 'completed';
}

async function executeTool(
  call: ToolUseBlock,
  registry: Registry,
  session: AgentSession,
): Promise<ToolCallResult> {
  const started = Date.now();
  try {
    if (call.name.startsWith('internal__')) {
      const result = invokeInternalTool(call.name, call.input, session.ledger, session.id, session.asOf);
      return { call, response: result.result, ok: true, elapsedMs: Date.now() - started, card: result.card, chip: result.chip };
    }
    const response = await registry.invoke(call.name, call.input, session.asOf);
    rememberResult(call, response, session.ledger);
    const ok = response.isError !== true;
    return { call, response: compactResult(response), ok, elapsedMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { call, response: { isError: true, message }, ok: false, elapsedMs: Date.now() - started };
  }
}

function toolDefinitions(registryTools: Registry['tools']): ToolDefinition[] {
  return [...registryTools.filter((tool) => tool.audience !== 'app'), ...internalTools];
}

export async function runLoop(
  session: AgentSession,
  provider: LlmProvider,
  registry: Registry,
  options: { maxSteps?: number; maxTokens?: number } = {},
): Promise<LoopEvent[]> {
  const maxSteps = options.maxSteps ?? Number(process.env.VELOX_MAX_STEPS ?? 12);
  const maxTokens = options.maxTokens ?? Number(process.env.VELOX_MAX_TOKENS ?? 1500);
  const availableTools = toolDefinitions(registry.tools);
  const events: LoopEvent[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    const answer = await provider.converse({
      system: systemPrompt(session.asOf),
      messages: session.messages,
      tools: availableTools,
      maxTokens,
    });
    const toolCalls = answer.blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    for (const block of answer.blocks) {
      if (block.type === 'text' && block.text) events.push({ type: 'say', text: block.text });
    }
    if (toolCalls.length === 0) return events;

    const calls = toolCalls.map((call) => ({
      id: call.id || randomUUID(),
      name: call.name,
      input: call.input,
    }));
    session.messages.push({
      role: 'assistant',
      content: JSON.stringify({ tool_calls: calls }),
    });

    for (const call of toolCalls) {
      const server = call.name.split('__')[0] ?? 'unknown';
      const tool = call.name.split('__').slice(1).join('__');
      events.push({
        type: 'call',
        id: call.id,
        server,
        tool,
        args: call.name.startsWith('internal__') ? call.input : { ...call.input, as_of: session.asOf },
        ts: new Date().toISOString(),
      });
    }
    const results = await Promise.all(toolCalls.map((call) => executeTool(call, registry, session)));
    for (const result of results) {
      const server = result.call.name.split('__')[0] ?? 'unknown';
      const tool = result.call.name.split('__').slice(1).join('__');
      events.push({
        type: 'result',
        id: result.call.id,
        ms: result.elapsedMs,
        ok: result.ok,
        summary: summary(result.response),
      });
      if (result.card) events.push({ type: 'card', card: result.card });
      if (result.chip) events.push({ type: 'chip', text: result.chip });
      session.messages.push({
        role: 'tool',
        name: result.call.name,
        tool_call_id: result.call.id,
        content: JSON.stringify(result.response),
      });
      if (server === 'vault' && tool === 'remember' && result.ok) {
        const key = result.call.input.key;
        const value = result.call.input.value;
        events.push({ type: 'chip', text: `Remembered ${String(key)}: ${String(value)}` });
      }
    }
  }
  events.push({ type: 'error', message: `Agent reached the ${maxSteps}-step limit before completing the response` });
  return events;
}
