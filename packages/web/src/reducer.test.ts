import { describe, expect, test } from 'vitest';
import type { Card, SseEvent } from '@velox/core';
import { agentReducer, initialAgentState } from './reducer.js';

const itinerary: Extract<Card, { kind: 'itinerary' }> = {
  kind: 'itinerary',
  plan_id: 'plan-1',
  title: 'Weekend trip',
  days: [{ label: 'Friday', items: [{ title: 'Flight', kind: 'air', amount: 2500, status: 'held' }] }],
  total: 2500,
  budget: 20000,
  remaining: 17500,
  expires_at: '2026-06-01T01:00:00.000Z',
  status: 'proposed',
  speech: 'Your itinerary is ready.',
};

describe('agent event reducer', () => {
  test.each([
    [{ type: 'say', text: 'Hello' }, (state) => expect(state.feed.at(-1)).toMatchObject({ kind: 'say', text: 'Hello' })],
    [{ type: 'call', id: 'call-1', server: 'air', tool: 'search', args: {}, ts: '2026-06-01T00:00:00.000Z' }, (state) => expect(state.trace[0]?.[0]?.call.tool).toBe('search')],
    [{ type: 'result', id: 'call-1', ms: 12, ok: true, summary: '1 offer' }, (state) => expect(state.trace[0]?.[0]?.result?.summary).toBe('1 offer')],
    [{ type: 'result', id: 'call-1', ms: 12, ok: false, summary: 'SOLD_OUT: food_1 already booked', code: 'SOLD_OUT', message: 'food_1 already booked' }, (state) => expect(state.trace[0]?.[0]?.result).toMatchObject({ ok: false, code: 'SOLD_OUT', message: 'food_1 already booked' })],
    [{ type: 'card', card: itinerary }, (state) => expect(state.feed.at(-1)).toMatchObject({ kind: 'card', card: itinerary })],
    [{ type: 'chip', text: 'Remembered a preference' }, (state) => expect(state.memoryChips).toContain('Remembered a preference')],
    [{ type: 'recovery', step: 1, detail: 'The stay was rebooked.' }, (state) => expect(state.feed.at(-1)).toMatchObject({ kind: 'recovery', step: 1 })],
    [{ type: 'nudge', card: { id: 'nudge-1', kind: 'nudge', text: 'Rain is likely.', action_label: 'Accept swap', speech: 'I found an alternative.' } }, (state) => expect(state.feed.at(-1)).toMatchObject({ kind: 'card', card: { kind: 'nudge' } })],
    [{ type: 'clock', now: '2026-06-05T08:00:00.000Z' }, (state) => expect(state.clock).toBe('2026-06-05T08:00:00.000Z')],
    [{ type: 'error', message: 'Booking failed.' }, (state) => expect(state.error).toBe('Booking failed.')],
    [{ type: 'done' }, (state) => expect(state.loading).toBe(false)],
  ] as Array<[SseEvent, (state: ReturnType<typeof agentReducer>) => void]>)('reduces %s events', (event, assertState) => {
    const starting = event.type === 'result'
      ? agentReducer(initialAgentState, {
        type: 'event',
        event: { type: 'call', id: 'call-1', server: 'air', tool: 'search', args: {}, ts: '2026-06-01T00:00:00.000Z' },
      })
      : event.type === 'done'
        ? { ...initialAgentState, loading: true }
        : initialAgentState;
    const state = agentReducer(starting, { type: 'event', event });
    assertState(state);
  });
});
