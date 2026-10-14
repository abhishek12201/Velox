import { randomUUID } from 'node:crypto';
import type { Card, Hold } from '@velox/core';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './llm/types.js';
import type { Registry } from './mcp/registry.js';
import { internalTools, invokeInternalTool, type SessionLedger } from './internal.js';
import { systemPrompt } from './prompt.js';

export interface AgentSession {
  id: string;
  asOf: string;
  turnId: number;
  messages: LlmMessage[];
  ledger: SessionLedger;
}

export interface LoopEvent {
  type: 'say' | 'call' | 'result' | 'card' | 'chip' | 'error' | 'recovery' | 'clock' | 'nudge';
  [key: string]: unknown;
}

interface ToolCallResult {
  call: ToolUseBlock;
  response: Record<string, unknown>;
  ok: boolean;
  elapsedMs: number;
  card?: Card;
  chip?: string;
  proposalResult?: 'created' | 'duplicate';
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
    for (const key of ['id', 'name', 'kind', 'flight_no', 'price_per_pax', 'price_per_night', 'price_per_head', 'depart', 'arrive', 'area', 'outdoor', 'tags']) {
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function releaseTurnHolds(
  session: AgentSession,
  holdsAtStart: Set<string>,
  registry: Registry,
  events: LoopEvent[],
): Promise<void> {
  for (const hold of session.ledger.holds.values()) {
    if (holdsAtStart.has(hold.hold_id) || hold.state !== 'held') continue;
    const tool = `${hold.server}__release_hold`;
    try {
      const result = await registry.invoke(tool, { hold_id: hold.hold_id }, session.asOf);
      if (result.state !== 'released') {
        events.push({ type: 'error', message: `Could not release hold ${hold.hold_id}: ${String(result.message ?? result.code ?? 'unexpected result')}` });
        continue;
      }
      session.ledger.holds.set(hold.hold_id, { ...hold, state: 'released' });
    } catch (error) {
      events.push({
        type: 'error',
        message: `Could not release hold ${hold.hold_id}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

async function executeTool(
  call: ToolUseBlock,
  registry: Registry,
  session: AgentSession,
  turnId: number,
): Promise<ToolCallResult> {
  const started = Date.now();
  try {
    if (call.name.startsWith('internal__')) {
      const result = invokeInternalTool(call.name, call.input, session.ledger, session.id, session.asOf);
      const proposalResult = call.name === 'internal__propose_itinerary' && result.result.ok === true
        ? result.result.duplicate === true ? 'duplicate' : 'created'
        : undefined;
      return {
        call,
        response: result.result,
        ok: result.result.ok !== false,
        elapsedMs: Date.now() - started,
        card: result.card,
        chip: result.chip,
        proposalResult,
      };
    }
    const response = await registry.invoke(call.name, call.input, session.asOf, {
      sessionId: session.id,
      turnId,
      toolCallId: call.id,
    });
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

function compactProfile(value: Record<string, unknown>): string {
  const profile = value.profile;
  if (!Array.isArray(profile)) throw new Error('Vault get_profile returned an invalid profile');
  const encoder = new TextEncoder();
  let context = '';
  for (const entry of profile) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Vault get_profile returned an invalid profile entry');
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.key !== 'string' || typeof record.value !== 'string' ||
      (record.source !== 'stated' && record.source !== 'inferred') ||
      typeof record.evidence !== 'string'
    ) throw new Error('Vault get_profile returned an invalid profile entry');
    const item = `${record.key}=${record.value} (${record.source}; ${record.evidence})`;
    const remaining = 240 - encoder.encode(context).length;
    if (remaining <= 0) break;
    const segment = `${context ? ' ' : ''}${item}`;
    let bytes = 0;
    let truncated = '';
    for (const character of segment) {
      const size = encoder.encode(character).length;
      if (bytes + size > remaining) break;
      truncated += character;
      bytes += size;
    }
    context += truncated;
    if (truncated.length < segment.length) break;
  }
  return context;
}

function mergeRememberedProfile(profile: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
  const current = profile.profile;
  const entry = readStructuredValue(value);
  if (
    !Array.isArray(current) ||
    typeof entry.key !== 'string' || typeof entry.value !== 'string' ||
    (entry.source !== 'stated' && entry.source !== 'inferred') ||
    typeof entry.evidence !== 'string'
  ) throw new Error('Vault remember returned an invalid profile entry');
  const existing = current.filter((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>).key !== entry.key,
  );
  return { ...profile, profile: [...existing, entry] };
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
  const holdsAtStart = new Set(session.ledger.holds.keys());
  const failedCalls = new Set<string>();
  let profile = await registry.invoke('vault__get_profile', {}, session.asOf);
  let system = systemPrompt(session.asOf, compactProfile(profile));
  let proposalCalls = 0;
  let replannedForBudget = false;
  let consecutiveFailedSteps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const turnId = ++session.turnId;
    const answer = await provider.converse({
      system,
      messages: session.messages,
      tools: availableTools,
      maxTokens,
    });
    const toolCalls = answer.blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    if (toolCalls.length === 0) {
      for (const block of answer.blocks) {
        if (block.type === 'text' && block.text) events.push({ type: 'say', text: block.text });
      }
      return events;
    }

    const calls = toolCalls.map((call) => ({
      type: 'tool_use' as const,
      id: call.id || randomUUID(),
      name: call.name,
      input: call.input,
    }));
    session.messages.push({
      role: 'assistant',
      content: JSON.stringify({ tool_calls: calls }),
    });

    for (const call of calls) {
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
    const results: ToolCallResult[] = await Promise.all(calls.map((call) => {
      const failureKey = `${call.name}:${stableJson(call.input)}`;
      if (failedCalls.has(failureKey)) {
        return Promise.resolve({
          call,
          response: {
            isError: true,
            message: 'This tool call already failed in this turn; choose different offers or answer in text.',
          },
          ok: false,
          elapsedMs: 0,
        } satisfies ToolCallResult);
      }
      if (call.name !== 'internal__propose_itinerary') {
        return executeTool(call, registry, session, turnId);
      }
      proposalCalls += 1;
      if (proposalCalls <= 3) return executeTool(call, registry, session, turnId);
      return Promise.resolve({
        call,
        response: { ok: false, isError: true, message: 'Proposal limit reached; stop proposing and answer in text.' },
        ok: false,
        elapsedMs: 0,
      } satisfies ToolCallResult);
    }));
    let createdProposal: Extract<Card, { kind: 'itinerary' }> | undefined;
    let duplicateProposal = false;
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
      if (result.card) {
        events.push({ type: 'card', card: result.card });
        if (result.proposalResult === 'created' && result.card.kind === 'itinerary') {
          createdProposal = result.card;
        }
      }
      if (result.proposalResult === 'duplicate') duplicateProposal = true;
      if (result.call.name === 'internal__propose_itinerary' &&
        typeof result.response.over_by === 'number') replannedForBudget = true;
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
        const text = key === 'avoid_departure_before' && value === '07:00'
          ? 'Remembered: avoids flights before 07:00'
          : `Remembered: ${String(key)}=${String(value)}`;
        events.push({ type: 'chip', text });
        profile = mergeRememberedProfile(profile, result.response);
        system = systemPrompt(session.asOf, compactProfile(profile));
      }
    }
    for (const result of results) {
      if (!result.ok) failedCalls.add(`${result.call.name}:${stableJson(result.call.input)}`);
    }
    if (createdProposal) {
      const itemCount = createdProposal.days.reduce((count, day) => count + day.items.length, 0);
      events.push({
        type: 'say',
        text: `Your ${createdProposal.title} plan is ready: ${itemCount} item${itemCount === 1 ? '' : 's'}, INR ${createdProposal.total} of INR ${createdProposal.budget}.${replannedForBudget ? ' I swapped in lower-priced options to fit your budget.' : ''}`,
      });
      return events;
    }
    if (duplicateProposal) return events;
    if (results.length > 0 && results.every((result) => !result.ok)) {
      consecutiveFailedSteps += 1;
    } else {
      consecutiveFailedSteps = 0;
    }
    if (consecutiveFailedSteps >= 2) {
      await releaseTurnHolds(session, holdsAtStart, registry, events);
      events.push({ type: 'say', text: 'I could not secure a replacement plan. Nothing was charged.' });
      return events;
    }
  }
  events.push({ type: 'error', message: `Agent reached the ${maxSteps}-step limit before completing the response` });
  return events;
}
