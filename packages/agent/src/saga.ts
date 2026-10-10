import { randomUUID } from 'node:crypto';
import { signConfirm, type Card } from '@velox/core';
import type { LlmProvider } from './llm/types.js';
import type { Registry } from './mcp/registry.js';
import type { AgentSession, LoopEvent } from './loop.js';
import { runLoop } from './loop.js';
import { invokeInternalTool } from './internal.js';

const confirmTools = {
  air: 'air__confirm_flight',
  stay: 'stay__confirm_stay',
  local: 'local__confirm_table',
} as const;

type SessionHold = NonNullable<ReturnType<AgentSession['ledger']['holds']['get']>>;
type ConfirmationResult = {
  hold: SessionHold;
  tool?: string;
  result: Record<string, unknown>;
  error?: string;
  failureReason?: string;
};

function itineraryCard(session: AgentSession, planId: string): Extract<Card, { kind: 'itinerary' }> | undefined {
  return session.ledger.cards.get(planId);
}

function updateCardStatus(card: Extract<Card, { kind: 'itinerary' }>, status: 'confirmed' | 'failed' | 'rolled_back'): Extract<Card, { kind: 'itinerary' }> {
  return {
    ...card,
    status,
    days: card.days.map((day) => ({
      ...day,
      items: day.items.map((item) => ({ ...item, status })),
    })),
  };
}

function structuredError(value: Record<string, unknown>): string | undefined {
  if (typeof value.code === 'string') return value.code;
  if (value.structuredContent && typeof value.structuredContent === 'object') {
    const code = (value.structuredContent as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function reholdSamePlan(
  session: AgentSession,
  planId: string,
  registry: Registry,
): Promise<{ planId: string; card: Extract<Card, { kind: 'itinerary' }> } | undefined> {
  const plan = session.ledger.plans.get(planId);
  if (!plan) return undefined;
  const oldHolds = plan.hold_ids.map((holdId) => session.ledger.holds.get(holdId));
  if (oldHolds.some((hold) => !hold)) return undefined;
  const flightOffer = oldHolds.map((hold) => hold && session.ledger.offers.get(hold.offer_id))
    .find((offer) => typeof offer?.depart === 'string');
  const departure = typeof flightOffer?.depart === 'string' ? flightOffer.depart.slice(0, 10) : undefined;
  if (!departure) return undefined;
  const checkout = new Date(Date.parse(`${departure}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  const reheld: Array<{ tool: string; id: string; input: Record<string, unknown>; value: Record<string, unknown> }> = [];
  for (const hold of oldHolds) {
    if (!hold) return undefined;
    const offer = session.ledger.offers.get(hold.offer_id);
    if (!offer) return undefined;
    const base = { offer_id: hold.offer_id, idem_key: `${planId}:rehold:${hold.hold_id}` };
    const tool = hold.server === 'air' ? 'air__hold_flight'
      : hold.server === 'stay' ? 'stay__hold_stay'
        : 'local__hold_table';
    const args = hold.server === 'air'
      ? { ...base, pax: hold.qty }
      : hold.server === 'stay'
        ? { ...base, checkin: departure, checkout, guests: hold.qty }
        : { ...base, when: `${departure}T19:00:00.000Z`, party: hold.qty };
    const value = await registry.invoke(tool, args, session.asOf);
    if (structuredError(value) || typeof value.hold_id !== 'string' || typeof value.amount !== 'number' || typeof value.expires_at !== 'string') {
      return undefined;
    }
    const newHold = {
      hold_id: value.hold_id,
      server: hold.server,
      offer_id: hold.offer_id,
      amount: value.amount,
      qty: typeof value.qty === 'number' ? value.qty : hold.qty,
      expires_at: value.expires_at,
      state: 'held' as const,
    };
    session.ledger.holds.set(newHold.hold_id, newHold);
    reheld.push({ tool, id: `rehold-${newHold.hold_id}`, input: args, value });
  }
  session.messages.push({
    role: 'assistant',
    content: JSON.stringify({
      tool_calls: reheld.map(({ tool, id, input }) => ({ id, name: tool, input })),
    }),
  });
  for (const { tool, id, value } of reheld) {
    session.messages.push({ role: 'tool', name: tool, tool_call_id: id, content: JSON.stringify(value) });
  }
  const proposed = invokeInternalTool('internal__propose_itinerary', {
    title: 'Weekend in Goa',
    hold_ids: reheld.map(({ value }) => value.hold_id),
    budget: plan.budget,
  }, session.ledger, session.id, session.asOf);
  const nextPlan = proposed.result.plan;
  const nextCard = proposed.result.card;
  if (
    proposed.result.ok !== true ||
    !nextPlan || typeof nextPlan !== 'object' ||
    typeof (nextPlan as { plan_id?: unknown }).plan_id !== 'string' ||
    !nextCard || typeof nextCard !== 'object' || (nextCard as Card).kind !== 'itinerary'
  ) return undefined;
  const card = nextCard as Extract<Card, { kind: 'itinerary' }>;
  return { planId: (nextPlan as { plan_id: string }).plan_id, card };
}

export async function confirmPlan(
  session: AgentSession,
  planId: string,
  provider: LlmProvider,
  registry: Registry,
): Promise<LoopEvent[]> {
  let plan = session.ledger.plans.get(planId);
  const initialCard = itineraryCard(session, planId);
  if (!plan || !initialCard) throw new Error('The requested itinerary is not available in this session');
  let card = initialCard;
  if (card.status !== 'proposed') throw new Error(`Itinerary cannot be confirmed from status ${card.status}`);
  const events: LoopEvent[] = [];
  const secret = process.env.VELOX_CONFIRM_SECRET ?? 'dev-secret';

  for (let recovery = 0; recovery <= 2; recovery += 1) {
    const holds = plan.hold_ids.map((holdId) => session.ledger.holds.get(holdId));
    if (holds.some((hold) => !hold)) throw new Error('The itinerary references a hold missing from its session ledger');
    const settled = await Promise.allSettled(holds.map(async (hold) => {
      if (!hold) throw new Error('Missing hold');
      const tool = confirmTools[hold.server as keyof typeof confirmTools];
      if (!tool) throw new Error(`Cannot confirm a hold from ${hold.server}`);
      const token = signConfirm(secret, hold.hold_id, planId);
      const result = await registry.invokeApp(tool, {
        hold_id: hold.hold_id,
        token,
        plan_id: planId,
        idem_key: `${planId}:${hold.hold_id}`,
      }, session.asOf);
      return { hold, tool, result, error: structuredError(result) };
    }));
    const results: ConfirmationResult[] = settled.flatMap((item, index): ConfirmationResult[] => {
      const hold = holds[index];
      if (!hold) return [];
      if (item.status === 'fulfilled') {
        return [{ ...item.value, failureReason: undefined }];
      }
      const failureReason = item.reason instanceof Error ? item.reason.message : String(item.reason);
      return [{
        hold,
        tool: confirmTools[hold.server as keyof typeof confirmTools],
        result: {},
        error: 'CONFIRMATION_ERROR',
        failureReason,
      }];
    });
    const failed = results.filter((result) => result.error);
    if (!failed.length) {
      const startDate = session.ledger.offers.get(holds[0]?.offer_id ?? '')?.depart;
      const endDate = session.ledger.offers.get(holds[1]?.offer_id ?? '')?.depart;
      const save = await registry.invokeApp('vault__save_trip', {
        title: card.title,
        plan_json: JSON.stringify({
          party: holds.reduce((largest, hold) => Math.max(largest, hold?.qty ?? 1), 1),
          start: typeof startDate === 'string' ? startDate.slice(0, 10) : plan.created.slice(0, 10),
          end: typeof endDate === 'string' ? endDate.slice(0, 10) : plan.created.slice(0, 10),
          total: plan.total,
        }),
      }, session.asOf);
      if (structuredError(save)) throw new Error(`Could not save confirmed itinerary: ${structuredError(save)}`);
      card = updateCardStatus(card, 'confirmed');
      session.ledger.cards.set(planId, card);
      events.push({ type: 'card', card });
      return events;
    }

    const failedById = new Map(failed.map((result) => [result.hold.hold_id, result.failureReason ?? result.error]));
    const compensation = await Promise.all(results.map(async (result) => {
      const confirmed = !result.error;
      const tool = confirmed ? `${result.hold.server}__cancel_booking` : `${result.hold.server}__release_hold`;
      const value = tool.endsWith('__release_hold')
        ? await registry.invoke(tool, { hold_id: result.hold.hold_id }, session.asOf)
        : await registry.invokeApp(tool, { hold_id: result.hold.hold_id }, session.asOf);
      return { ...result, compensationTool: tool, compensation: value, confirmed };
    }));
    session.messages.push({
      role: 'assistant',
      content: JSON.stringify({
        tool_calls: compensation.map((item) => ({
          id: `saga-${item.hold.hold_id}`,
          name: item.compensationTool,
          input: { hold_id: item.hold.hold_id },
        })),
      }),
    });
    for (const item of compensation) {
      const state = typeof item.compensation.state === 'string'
        ? item.compensation.state as typeof item.hold.state
        : item.confirmed ? 'cancelled' : 'released';
      session.ledger.holds.set(item.hold.hold_id, { ...item.hold, state });
      session.messages.push({
        role: 'tool',
        name: item.compensationTool,
        tool_call_id: `saga-${item.hold.hold_id}`,
        content: JSON.stringify(item.compensation),
      });
    }
    card = updateCardStatus(card, 'rolled_back');
    session.ledger.cards.set(planId, card);
    events.push({ type: 'card', card });
    const failure = failed[0];
    const failedHold = failure?.hold;
    const failedOffer = failedHold ? session.ledger.offers.get(failedHold.offer_id) : undefined;
    let recoveryDetail = `Confirmation failed on ${failedHold?.server ?? 'booking'}: ${failedById.get(failedHold?.hold_id ?? '')}. Nothing was charged; compensating holds and replanning without ${failedHold?.offer_id ?? 'the unavailable offer'}.`;
    events.push({
      type: 'recovery',
      step: recovery + 1,
      detail: `${recoveryDetail} ${String(failedOffer?.name ?? '')}`.trim(),
    });
    session.messages.push({
      role: 'user',
      content: `Confirmation failed. Re-plan within the same budget without ${failedHold?.offer_id ?? 'the unavailable offer'}.`,
    });
    if (recovery === 2) {
      card = updateCardStatus(card, 'failed');
      session.ledger.cards.set(planId, card);
      events.push({ type: 'error', message: 'Confirmation failed after two recovery attempts' });
      return events;
    }

    const expired = failed.some((result) => result.error === 'HOLD_EXPIRED');
    const samePlan = expired ? await reholdSamePlan(session, planId, registry) : undefined;
    if (samePlan) {
      planId = samePlan.planId;
      card = samePlan.card;
      plan = session.ledger.plans.get(planId);
      if (!plan) throw new Error('Re-held plan was not recorded in the session ledger');
      session.ledger.cards.set(planId, card);
      events.push({ type: 'recovery', step: recovery + 1, detail: 'Expired holds were reacquired for the same offers.' });
      events.push({ type: 'card', card });
      continue;
    }
    if (expired) recoveryDetail += ' Same-offer re-hold was unavailable; selecting alternatives.';
    const replanned = await runLoop(session, provider, registry);
    events.push(...replanned);
    const nextPlan = [...session.ledger.plans.values()].at(-1);
    const nextCard = nextPlan ? session.ledger.cards.get(nextPlan.plan_id) : undefined;
    if (!nextPlan || !nextCard || nextPlan.plan_id === planId) {
      card = updateCardStatus(card, 'failed');
      session.ledger.cards.set(planId, card);
      events.push({ type: 'error', message: 'The agent could not create a replacement itinerary' });
      return events;
    }
    planId = nextPlan.plan_id;
    card = nextCard;
    plan = nextPlan;
  }
  return events;
}
