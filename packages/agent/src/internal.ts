import { randomUUID } from 'node:crypto';
import type { Card, Hold, Plan } from '@velox/core';
import type { ToolDefinition } from './llm/types.js';

export interface SessionLedger {
  offers: Map<string, Record<string, unknown>>;
  holds: Map<string, Hold>;
  plans: Map<string, Plan>;
  cards: Map<string, Extract<Card, { kind: 'itinerary' }>>;
  lastCarousel?: Card;
  swaps: Map<string, { oldHoldId: string; newHoldId: string; tripPlanId: string; day: string; reason: string }>;
}

export interface InternalToolResult {
  result: Record<string, unknown>;
  card?: Card;
  chip?: string;
}

export const internalTools: ToolDefinition[] = [
  {
    name: 'internal__show_options',
    description: 'Show a concise carousel from up to five offers already returned by search tools.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        offer_ids: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
      required: ['title', 'offer_ids'],
    },
  },
  {
    name: 'internal__propose_itinerary',
    description: 'Propose an itinerary from valid held offers and compute its total in code.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        hold_ids: { type: 'array', items: { type: 'string' } },
        budget: { type: 'integer', minimum: 0 },
      },
      required: ['title', 'hold_ids', 'budget'],
    },
  },
];

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function makeCarousel(title: string, offerIds: string[], ledger: SessionLedger): Card {
  const items = offerIds.slice(0, 5).flatMap((offerId) => {
    const offer = ledger.offers.get(offerId);
    if (!offer) return [];
    const price = [offer.price_per_pax, offer.price_per_night, offer.price_per_head]
      .find((value): value is number => typeof value === 'number');
    const location = [offer.from, offer.to, offer.area].filter((value): value is string => typeof value === 'string').join(' → ');
    return [{
      id: offerId,
      title: String(offer.name ?? offer.flight_no ?? offerId),
      ...(location ? { subtitle: location } : {}),
      ...(price === undefined ? {} : { price }),
      badges: Array.isArray(offer.tags) ? offer.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      offer_id: offerId,
    }];
  });
  if (items.length === 0) throw new Error('No matching ledger offers are available to show');
  return {
    kind: 'carousel',
    id: randomUUID(),
    title,
    items,
    speech: `Here are ${items.length} options.`,
  };
}

function makeItinerary(
  title: string,
  holdIds: string[],
  budget: number,
  ledger: SessionLedger,
  sessionId: string,
  asOf: string,
): { result: Record<string, unknown>; card?: Card } {
  if (!Number.isInteger(budget) || budget < 0) throw new Error('budget must be a non-negative integer');
  if (new Set(holdIds).size !== holdIds.length) throw new Error('hold_ids must not contain duplicates');
  const holds = holdIds.map((holdId) => {
    const hold = ledger.holds.get(holdId);
    if (!hold) throw new Error('Every proposed hold must exist in this session');
    return hold;
  });
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error('as_of must be a valid ISO timestamp');
  if (holds.some((hold) => hold.state !== 'held' || Date.parse(hold.expires_at) <= now)) {
    throw new Error('Every proposed hold must be held and unexpired');
  }
  const total = holds.reduce((sum, hold) => sum + hold.amount, 0);
  if (total > budget) return { result: { ok: false, over_by: total - budget } };

  const plan: Plan = {
    plan_id: randomUUID(),
    session_id: sessionId,
      kind: 'trip',
    hold_ids: holdIds,
    total,
    budget,
    created: asOf,
  };
  const items = holds.map((hold) => {
    const offer = ledger.offers.get(hold.offer_id);
    const title = String(offer?.name ?? offer?.flight_no ?? hold.offer_id);
    return {
      title,
      kind: hold.server,
      amount: hold.amount,
      hold_id: hold.hold_id,
      status: hold.state,
    };
  });
  const card: Card = {
    kind: 'itinerary',
    plan_id: plan.plan_id,
    title,
    days: [{ label: 'Trip', items }],
    total,
    budget,
    remaining: budget - total,
    expires_at: holds.reduce((earliest, hold) => hold.expires_at < earliest ? hold.expires_at : earliest, holds[0]?.expires_at ?? asOf),
    status: 'proposed',
    speech: `Your itinerary totals INR ${total}, within your INR ${budget} budget.`,
  };
  ledger.plans.set(plan.plan_id, plan);
  ledger.cards.set(plan.plan_id, card);
  return { result: { ok: true, plan, card }, card };
}

export function invokeInternalTool(
  name: string,
  input: Record<string, unknown>,
  ledger: SessionLedger,
  sessionId: string,
  asOf: string,
): InternalToolResult {
  if (name === 'internal__show_options') {
    const card = makeCarousel(requireString(input.title, 'title'), requireStrings(input.offer_ids, 'offer_ids'), ledger);
    ledger.lastCarousel = card;
    return { result: { card }, card };
  }
  if (name === 'internal__propose_itinerary') {
    const budget = input.budget;
    if (typeof budget !== 'number') throw new Error('budget must be a number');
    const proposal = makeItinerary(
      requireString(input.title, 'title'),
      requireStrings(input.hold_ids, 'hold_ids'),
      budget,
      ledger,
      sessionId,
      asOf,
    );
    return { ...proposal, result: proposal.result };
  }
  throw new Error(`Unknown internal tool: ${name}`);
}
