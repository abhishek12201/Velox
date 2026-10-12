import { randomUUID } from 'node:crypto';
import { forecast } from '@velox/core';
import type { Plan, Nudge } from '@velox/core';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './llm/types.js';
import type { AgentSession, LoopEvent } from './loop.js';
import type { Registry } from './mcp/registry.js';
import { invokeInternalTool, internalTools } from './internal.js';

interface Swap {
  oldHoldId: string;
  newHoldId: string;
  tripPlanId: string;
  day: string;
  reason: string;
}

interface HeldActivity {
  hold_id: string;
  offer_id: string;
  amount: number;
  qty: number;
  expires_at: string;
}

export class TripScheduler {
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly sessions: () => AgentSession[],
    private readonly registry: Registry,
    private readonly provider: LlmProvider,
    private currentTime: string,
  ) {}

  private async holdIndoorAlternative(
    session: AgentSession,
    area: string,
    day: string,
    maxUnit: number,
    qty: number,
  ): Promise<{ hold: HeldActivity; offer: Record<string, unknown> } | undefined> {
    const tools: ToolDefinition[] = [
      ...this.registry.tools
        .filter((tool) => tool.server === 'local' && tool.audience === 'llm' &&
          ['search_places', 'hold_table'].includes(tool.remoteName))
        .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      internalTools[0] as ToolDefinition,
    ];
    const messages: LlmMessage[] = [{
      role: 'user',
      content: `__S6_INDOOR_SWAP__${JSON.stringify({ area, day, maxUnit, qty })}`,
    }];
    for (let step = 0; step < 4; step += 1) {
      const answer = await this.provider.converse({
        system: `Current time: ${this.currentTime}\nChoose an indoor activity at or below INR ${maxUnit} per person.`,
        messages,
        tools,
        maxTokens: 500,
      });
      const calls = answer.blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use');
      if (!calls.length) break;
      const mapped = calls.map((call) => ({ id: call.id || randomUUID(), name: call.name, input: call.input }));
      messages.push({ role: 'assistant', content: JSON.stringify({ tool_calls: mapped }) });
      for (const call of calls) {
        if (!tools.some((tool) => tool.name === call.name)) throw new Error(`S6 planner attempted an unavailable tool: ${call.name}`);
        let value: Record<string, unknown>;
        if (call.name.startsWith('internal__')) {
          value = invokeInternalTool(call.name, call.input, session.ledger, session.id, this.currentTime).result;
        } else {
          value = await this.registry.invoke(call.name, call.input, this.currentTime);
          if (Array.isArray(value.offers)) {
            for (const offer of value.offers) {
              if (offer && typeof offer === 'object' && typeof (offer as Record<string, unknown>).id === 'string') {
                session.ledger.offers.set((offer as Record<string, unknown>).id as string, offer as Record<string, unknown>);
              }
            }
          }
          if (
            typeof value.hold_id === 'string' && typeof value.offer_id === 'string' &&
            typeof value.amount === 'number' && typeof value.qty === 'number' &&
            typeof value.expires_at === 'string' && value.state === 'held'
          ) {
            session.ledger.holds.set(value.hold_id, {
              hold_id: value.hold_id,
              server: 'local',
              offer_id: value.offer_id,
              amount: value.amount,
              qty: value.qty,
              expires_at: value.expires_at,
              state: 'held',
            });
          }
        }
        messages.push({ role: 'tool', name: call.name, tool_call_id: call.id, content: JSON.stringify(value) });
        if (call.name === 'local__hold_table' && value.state === 'held' && typeof value.hold_id === 'string') {
          const offerId = value.offer_id;
          const amount = value.amount;
          const count = value.qty;
          const expiresAt = value.expires_at;
          if (typeof offerId !== 'string' || typeof amount !== 'number' ||
            typeof count !== 'number' || typeof expiresAt !== 'string') continue;
          const offer = session.ledger.offers.get(offerId);
          const hold: HeldActivity = {
            hold_id: value.hold_id,
            offer_id: offerId,
            amount,
            qty: count,
            expires_at: expiresAt,
          };
          return offer ? { hold, offer } : undefined;
        }
      }
    }
    return undefined;
  }

  setNow(value: string): void {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error('Clock value must be a valid ISO timestamp');
    this.currentTime = new Date(parsed).toISOString();
    for (const session of this.sessions()) session.asOf = this.currentTime;
  }

  now(): string {
    return this.currentTime;
  }

  start(onEvents: (sessionId: string, events: LoopEvent[]) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().then((eventsBySession) => {
        for (const [sessionId, events] of eventsBySession) onEvents(sessionId, events);
      }).catch((error: unknown) => {
        console.error('Scheduler tick failed', error);
      });
    }, 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<Map<string, LoopEvent[]>> {
    const emitted = new Map<string, LoopEvent[]>();
    const now = Date.parse(this.currentTime);
    for (const session of this.sessions()) {
      for (const [tripPlanId, plan] of session.ledger.plans) {
        const card = session.ledger.cards.get(tripPlanId);
        if (plan.kind !== 'trip' || card?.status !== 'confirmed') continue;
        const holds = plan.hold_ids.map((id) => session.ledger.holds.get(id)).filter((hold) => hold?.state === 'confirmed');
        const flight = holds.map((hold) => hold && session.ledger.offers.get(hold.offer_id))
          .find((offer) => typeof offer?.depart === 'string');
        if (!flight || typeof flight.depart !== 'string') continue;
        const departureAt = Date.parse(flight.depart);
        if (departureAt < now || departureAt - now > 36 * 60 * 60 * 1000) continue;
        const date = flight.depart.slice(0, 10);
        const day = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        const outdoor = holds.find((hold) => {
          if (!hold || hold.server !== 'local') return false;
          const offer = session.ledger.offers.get(hold.offer_id);
          return offer?.kind === 'activity' && offer.outdoor === true;
        });
        if (!outdoor) continue;
        const oldOffer = session.ledger.offers.get(outdoor.offer_id);
        const area = oldOffer?.area;
        if (area !== 'north' && area !== 'south' && area !== 'central') continue;
        const key = `${tripPlanId}:${day}:weather`;
        if (this.sent.has(key)) continue;
        const weather = forecast(area, day, this.currentTime);
        if (!weather.rain) continue;
        const weatherResult = await this.registry.invoke('local__get_forecast', {
          area, date_from: day, date_to: day,
        }, this.currentTime);
        const forecastDays = weatherResult.forecast;
        if (!Array.isArray(forecastDays) || !forecastDays.some((entry) =>
          entry && typeof entry === 'object' && (entry as Record<string, unknown>).condition === 'rain',
        )) continue;
        const oldUnit = Number(oldOffer?.price_per_head);
        const qty = outdoor.qty;
        const alternative = await this.holdIndoorAlternative(session, area, day, oldUnit, qty);
        if (!alternative) continue;
        const { hold: holdResult, offer: replacement } = alternative;
        const newHold = {
          hold_id: holdResult.hold_id,
          server: 'local' as const,
          offer_id: String(replacement.id),
          amount: holdResult.amount,
          qty: typeof holdResult.qty === 'number' ? holdResult.qty : qty,
          expires_at: holdResult.expires_at,
          state: 'held' as const,
        };
        session.ledger.offers.set(String(replacement.id), replacement);
        session.ledger.holds.set(newHold.hold_id, newHold);
        const planId = randomUUID();
        const swapPlan: Plan = {
          plan_id: planId,
          session_id: session.id,
          kind: 'swap',
          hold_ids: [newHold.hold_id],
          total: newHold.amount,
          budget: newHold.amount,
          created: this.currentTime,
        };
        session.ledger.plans.set(planId, swapPlan);
        const swap: Swap = { oldHoldId: outdoor.hold_id, newHoldId: newHold.hold_id, tripPlanId, day, reason: 'weather' };
        session.ledger.swaps.set(planId, swap);
        const delta = newHold.amount - outdoor.amount;
        const change = delta > 0
          ? `costs INR ${delta} more`
          : delta < 0
            ? `saves INR ${Math.abs(delta)}`
            : 'costs the same';
        const nudge: Nudge = {
          id: randomUUID(),
          kind: 'nudge',
          text: `Rain is forecast for ${day}. Replace ${String(oldOffer?.name)} with ${String(replacement.name)}; the change ${change}.`,
          action_label: 'Accept swap',
          plan_id: planId,
          speech: `Rain is forecast; I found an indoor alternative that ${change}.`,
        };
        this.sent.add(key);
        emitted.set(session.id, [...(emitted.get(session.id) ?? []), { type: 'nudge', card: nudge }]);
      }
    }
    return emitted;
  }
}
