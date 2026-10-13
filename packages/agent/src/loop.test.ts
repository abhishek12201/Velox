import { expect, test } from 'vitest';
import type { AgentSession } from './loop.js';
import { runLoop } from './loop.js';
import { invokeInternalTool } from './internal.js';
import type { LlmProvider } from './llm/types.js';
import type { Registry } from './mcp/registry.js';

const asOf = '2026-10-13T00:00:00.000Z';

function session(holdIds: string[], amount = 100): AgentSession {
  const holds = new Map(holdIds.map((holdId) => [holdId, {
    hold_id: holdId,
    server: 'local' as const,
    offer_id: `offer-${holdId}`,
    amount,
    qty: 1,
    expires_at: '2026-10-14T00:00:00.000Z',
    state: 'held' as const,
  }]));
  const offers = new Map(holdIds.map((holdId) => [`offer-${holdId}`, { name: `Activity ${holdId}` }]));
  return {
    id: 'session-test',
    asOf,
    turnId: 0,
    messages: [{ role: 'user', content: 'Plan a trip' }],
    ledger: { holds, offers, plans: new Map(), cards: new Map(), swaps: new Map() },
  };
}

const registry = {
  tools: [],
  async invoke() {
    return { profile: [] };
  },
  async invokeApp() {
    throw new Error('App-only tools are unavailable in this test');
  },
  async setChaos() {},
  async close() {},
} satisfies Registry;

test('a successful proposal ends the turn with one card then one code-built say', async () => {
  const current = session(['hold-1'], 250);
  let providerCalls = 0;
  const provider: LlmProvider = {
    async converse() {
      providerCalls += 1;
      return {
        blocks: [
          { type: 'text', text: 'This provider text must not precede the proposal card.' },
          {
            type: 'tool_use',
            id: 'proposal-1',
            name: 'internal__propose_itinerary',
            input: { title: 'Weekend', hold_ids: ['hold-1'], budget: 500 },
          },
        ],
        stop: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  const events = await runLoop(current, provider, registry);
  expect(providerCalls).toBe(1);
  expect(events.map((event) => event.type)).toEqual(['call', 'result', 'card', 'say']);
  expect(events.filter((event) => event.type === 'card')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'say')).toEqual([
    { type: 'say', text: 'Your Weekend plan is ready: 1 item, INR 250 of INR 500.' },
  ]);
  const duplicate = invokeInternalTool('internal__propose_itinerary', {
    title: 'Weekend',
    hold_ids: ['hold-1'],
    budget: 500,
  }, current.ledger, current.id, current.asOf);
  expect(duplicate.result).toMatchObject({ ok: true, duplicate: true });
  expect(duplicate.card).toBeUndefined();
});

test('the fourth proposal call is rejected with stop-and-answer guidance', async () => {
  const current = session(['hold-1', 'hold-2', 'hold-3', 'hold-4']);
  let providerCalls = 0;
  const provider: LlmProvider = {
    async converse() {
      providerCalls += 1;
      if (providerCalls <= 4) {
        return {
          blocks: [{
            type: 'tool_use',
            id: `proposal-${providerCalls}`,
            name: 'internal__propose_itinerary',
            input: { title: 'Weekend', hold_ids: [`hold-${providerCalls}`], budget: 0 },
          }],
          stop: 'tool_use',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      return { blocks: [{ type: 'text', text: 'I will answer in text.' }], stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };

  const events = await runLoop(current, provider, registry);
  expect(providerCalls).toBe(5);
  expect(events.filter((event) => event.type === 'result')).toHaveLength(4);
  const finalResult = events.filter((event) => event.type === 'result').at(-1);
  expect(finalResult?.ok).toBe(false);
  const finalToolMessage = current.messages.filter((message) => message.role === 'tool').at(-1);
  expect(finalToolMessage?.content).toContain('Proposal limit reached; stop proposing and answer in text.');
  expect(events.some((event) => event.type === 'error' && /step limit/i.test(String(event.message)))).toBe(false);
  expect(events.at(-1)).toEqual({ type: 'say', text: 'I will answer in text.' });
});
