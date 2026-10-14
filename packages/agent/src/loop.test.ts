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
          blocks: [
            { type: 'tool_use', id: `profile-${providerCalls}`, name: 'vault__get_profile', input: {} },
            {
              type: 'tool_use',
              id: `proposal-${providerCalls}`,
              name: 'internal__propose_itinerary',
              input: { title: 'Weekend', hold_ids: [`hold-${providerCalls}`], budget: providerCalls - 1 },
            },
          ],
          stop: 'tool_use',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      return { blocks: [{ type: 'text', text: 'I will answer in text.' }], stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };

  const events = await runLoop(current, provider, registry);
  expect(providerCalls).toBe(5);
  expect(events.filter((event) => event.type === 'result')).toHaveLength(8);
  const finalResult = events.find((event) => event.type === 'result' && event.id === 'proposal-4');
  expect(finalResult?.ok).toBe(false);
  const finalToolMessage = current.messages.filter((message) => message.role === 'tool').at(-1);
  expect(finalToolMessage?.content).toContain('Proposal limit reached; stop proposing and answer in text.');
  expect(events.some((event) => event.type === 'error' && /step limit/i.test(String(event.message)))).toBe(false);
  expect(events.at(-1)).toEqual({ type: 'say', text: 'I will answer in text.' });
});

test('repeated failed calls are skipped and two all-failed steps release this turn holds', async () => {
  const current = session([]);
  let providerCalls = 0;
  let failedSearchCalls = 0;
  let releaseCalls = 0;
  const provider: LlmProvider = {
    async converse() {
      providerCalls += 1;
      const calls = providerCalls === 1
        ? [
          { type: 'tool_use' as const, id: 'hold-once', name: 'local__hold_table', input: { offer_id: 'offer-new' } },
          { type: 'tool_use' as const, id: 'failure-one', name: 'local__search_places', input: { offer_id: 'bad-one' } },
        ]
        : providerCalls === 2
          ? [
            { type: 'tool_use' as const, id: 'failure-one-repeat', name: 'local__search_places', input: { offer_id: 'bad-one' } },
            { type: 'tool_use' as const, id: 'failure-two', name: 'local__search_places', input: { offer_id: 'bad-two' } },
          ]
          : [
            { type: 'tool_use' as const, id: 'failure-one-again', name: 'local__search_places', input: { offer_id: 'bad-one' } },
            { type: 'tool_use' as const, id: 'failure-two-again', name: 'local__search_places', input: { offer_id: 'bad-two' } },
          ];
      return { blocks: calls, stop: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const testRegistry: Registry = {
    ...registry,
    async invoke(name, args) {
      if (name === 'local__hold_table') {
        const hold = {
          hold_id: 'turn-hold',
          offer_id: String(args.offer_id),
          amount: 100,
          qty: 1,
          expires_at: '2026-10-14T00:00:00.000Z',
          state: 'held' as const,
        };
        current.ledger.holds.set(hold.hold_id, { ...hold, server: 'local' });
        current.ledger.offers.set(hold.offer_id, { name: hold.offer_id });
        return hold;
      }
      if (name === 'local__release_hold') {
        releaseCalls += 1;
        return { hold_id: String(args.hold_id), state: 'released' };
      }
      if (name === 'vault__get_profile') return { profile: [] };
      failedSearchCalls += 1;
      return { isError: true, code: 'NOT_FOUND', message: 'Offer was not found' };
    },
  };

  const events = await runLoop(current, provider, testRegistry);
  expect(providerCalls).toBe(3);
  expect(failedSearchCalls).toBe(2);
  expect(releaseCalls).toBe(1);
  expect(current.ledger.holds.get('turn-hold')?.state).toBe('released');
  expect(events.at(-1)).toEqual({
    type: 'say',
    text: 'I could not secure a replacement plan. Nothing was charged.',
  });
  expect(current.messages.some((message) =>
    message.role === 'tool' && message.content.includes('choose different offers or answer in text'),
  )).toBe(true);
  expect(events.some((event) => event.type === 'error' && /step limit/i.test(String(event.message)))).toBe(false);
});
