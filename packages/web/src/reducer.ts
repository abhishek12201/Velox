import type { Card, SseEvent } from '@velox/core';

export type FeedItem =
  | { kind: 'say'; id: string; role: 'assistant' | 'user'; text: string }
  | { kind: 'card'; card: Card }
  | { kind: 'chip'; text: string }
  | { kind: 'recovery'; step: number; detail: string }
  | { kind: 'error'; message: string };

export interface TraceEntry {
  call: Extract<SseEvent, { type: 'call' }>;
  result?: Extract<SseEvent, { type: 'result' }>;
}

export interface AgentState {
  feed: FeedItem[];
  trace: TraceEntry[][];
  memoryChips: string[];
  clock?: string;
  loading: boolean;
  connection: 'connecting' | 'connected' | 'reconnecting';
  error?: string;
  carouselIndex: number;
}

export type AgentAction =
  | { type: 'event'; event: SseEvent }
  | { type: 'user'; text: string }
  | { type: 'loading'; value: boolean }
  | { type: 'connection'; value: AgentState['connection'] }
  | { type: 'error'; message?: string }
  | { type: 'carousel'; index: number }
  | { type: 'reset' };

export const initialAgentState: AgentState = {
  feed: [],
  trace: [],
  memoryChips: [],
  loading: false,
  connection: 'connecting',
  carouselIndex: 0,
};

function cardKey(card: Card): string {
  if (card.kind === 'itinerary') return `itinerary:${card.plan_id}`;
  if (card.kind === 'nudge') return `nudge:${card.id}`;
  return `carousel:${card.id}`;
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  if (action.type === 'reset') return { ...initialAgentState, feed: [] };
  if (action.type === 'user') {
    return {
      ...state,
      error: undefined,
      feed: [...state.feed, { kind: 'say', id: crypto.randomUUID(), role: 'user', text: action.text }],
    };
  }
  if (action.type === 'loading') return { ...state, loading: action.value };
  if (action.type === 'connection') return { ...state, connection: action.value };
  if (action.type === 'error') return { ...state, error: action.message };
  if (action.type === 'carousel') return { ...state, carouselIndex: action.index };

  const event = action.event;
  switch (event.type) {
    case 'say':
      return { ...state, feed: [...state.feed, { kind: 'say', id: crypto.randomUUID(), role: 'assistant', text: event.text }] };
    case 'call': {
      const trace = [...state.trace];
      const last = trace.at(-1);
      if (last && last.every((entry) => entry.result)) {
        trace.push([{ call: event }]);
      } else if (last) {
        trace[trace.length - 1] = [...last, { call: event }];
      } else {
        trace.push([{ call: event }]);
      }
      return { ...state, trace };
    }
    case 'result': {
      const trace = state.trace.map((group) => group.map((entry) =>
        entry.call.id === event.id ? { ...entry, result: event } : entry,
      ));
      return { ...state, trace };
    }
    case 'card': {
      const key = cardKey(event.card);
      const existing = state.feed.findIndex((item) => item.kind === 'card' && cardKey(item.card) === key);
      const feed = [...state.feed];
      if (existing >= 0) feed[existing] = { kind: 'card', card: event.card };
      else feed.push({ kind: 'card', card: event.card });
      return { ...state, feed };
    }
    case 'chip':
      return {
        ...state,
        memoryChips: [...state.memoryChips, event.text],
        feed: [...state.feed, { kind: 'chip', text: event.text }],
      };
    case 'recovery':
      return { ...state, feed: [...state.feed, { kind: 'recovery', step: event.step, detail: event.detail }] };
    case 'nudge': {
      const card = event.card;
      const key = cardKey(card);
      const existing = state.feed.findIndex((item) => item.kind === 'card' && cardKey(item.card) === key);
      const feed = [...state.feed];
      if (existing >= 0) feed[existing] = { kind: 'card', card };
      else feed.push({ kind: 'card', card });
      return { ...state, feed };
    }
    case 'clock':
      return { ...state, clock: event.now };
    case 'error':
      return { ...state, error: event.message, feed: [...state.feed, { kind: 'error', message: event.message }] };
    case 'done':
      return { ...state, loading: false };
  }
}
