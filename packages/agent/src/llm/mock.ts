import { comfortPlan, cheapestPlan, flightsFor } from '@velox/core';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './types.js';
import { scenarios, unknownScenarioMessage } from './scenarios.js';

interface Offer {
  id: string;
  kind?: string;
  price_per_pax?: number;
  price_per_night?: number;
  price_per_head?: number;
  [key: string]: unknown;
}

interface ToolResponse {
  name: string;
  args: Record<string, unknown>;
  value: Record<string, unknown>;
}

function lastUserText(messages: LlmMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function toolResponses(messages: LlmMessage[]): ToolResponse[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      let decoded: unknown;
      try {
        decoded = JSON.parse(message.content);
      } catch {
        continue;
      }
      const toolCalls = decoded && typeof decoded === 'object' ? (decoded as { tool_calls?: unknown }).tool_calls : undefined;
      if (Array.isArray(toolCalls)) {
        for (const item of toolCalls) {
          if (!item || typeof item !== 'object') continue;
          const call = item as { id?: unknown; name?: unknown; input?: unknown };
          if (typeof call.id === 'string' && typeof call.name === 'string' && call.input && typeof call.input === 'object') {
            calls.set(call.id, { name: call.name, args: call.input as Record<string, unknown> });
          }
        }
      }
    } else if (message.role === 'tool' && message.name) {
      let value: unknown;
      try {
        value = JSON.parse(message.content);
      } catch {
        continue;
      }
      const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
      if (value && typeof value === 'object' && !Array.isArray(value) && call) {
        calls.set(message.tool_call_id as string, call);
        (message as LlmMessage & { response?: Record<string, unknown> }).response = value as Record<string, unknown>;
      }
    }
  }
  return messages.flatMap((message) => {
    if (message.role !== 'tool' || !message.name || !message.tool_call_id) return [];
    const call = calls.get(message.tool_call_id);
    if (!call) return [];
    const raw = (message as LlmMessage & { response?: Record<string, unknown> }).response;
    if (!raw) return [];
    return [{ ...call, name: message.name, value: raw }];
  });
}

function offerList(responses: ToolResponse[], predicate: (response: ToolResponse) => boolean): Offer[] {
  const offers = responses.find(predicate)?.value.offers;
  return Array.isArray(offers)
    ? offers.filter((offer): offer is Offer => Boolean(offer) && typeof offer === 'object' && typeof (offer as Offer).id === 'string')
    : [];
}

function pickPrice(offers: Offer[], field: 'price_per_pax' | 'price_per_night' | 'price_per_head', high: boolean, preferredId?: string): Offer | undefined {
  if (preferredId) {
    const preferred = offers.find((offer) => offer.id === preferredId);
    if (preferred) return preferred;
  }
  return [...offers].sort((left, right) =>
    (Number(left[field]) - Number(right[field])) * (high ? -1 : 1),
  )[0];
}

function inputFor(name: string, tools: ToolDefinition[], input: Record<string, unknown>, suffix: string): ToolUseBlock {
  if (!tools.some((tool) => tool.name === name)) throw new Error(`Scenario requires unavailable tool ${name}`);
  return { type: 'tool_use', id: `mock-${suffix}`, name, input };
}

function datesFrom(asOf: string): { departure: string; returnDate: string; checkout: string } {
  const now = new Date(asOf);
  if (!Number.isFinite(now.getTime())) throw new Error('Mock provider requires a valid virtual clock');
  const daysToFriday = (5 - now.getUTCDay() + 7) % 7 || 7;
  const departure = new Date(now.getTime() + daysToFriday * 86400000).toISOString().slice(0, 10);
  const sunday = new Date(Date.parse(`${departure}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  return { departure, returnDate: sunday, checkout: sunday };
}

function result(
  blocks: Array<{ type: 'text'; text: string } | ToolUseBlock>,
  outputTokens = blocks.length,
): Awaited<ReturnType<LlmProvider['converse']>> {
  return { blocks, stop: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { inputTokens: 0, outputTokens } };
}

export class ScenarioProvider implements LlmProvider {
  async converse(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<Awaited<ReturnType<LlmProvider['converse']>>> {
    const asOf = input.system.match(/Current time: ([^\n]+)/)?.[1];
    if (!asOf) throw new Error('Mock provider system prompt is missing the current time');
    const userTexts = input.messages.filter((message) => message.role === 'user').map((message) => message.content);
    const text = lastUserText(input.messages);
    const responses = toolResponses(input.messages);
    if (userTexts.some((userText) => /S8|unauthorized confirmation/i.test(userText))) {
      const refusal = toolResponses(input.messages).find((response) =>
        response.name === 'air__confirm_flight' && typeof response.value.message === 'string',
      );
      if (refusal) return result([{ type: 'text', text: 'I cannot confirm a booking; only the confirmation flow can do that.' }], 1);
      return result([{
        type: 'tool_use',
        id: 'mock-forbidden-confirm',
        name: 'air__confirm_flight',
        input: { hold_id: 'synthetic-hold', token: 'synthetic-token', plan_id: 'synthetic-plan' },
      }]);
    }

    const preferenceText = userTexts.find((userText) => /hate flights before 7\s*(?:am|a\.m\.)/i.test(userText));
    const rememberedPreference = responses.find((response) =>
      response.name === 'vault__remember' && response.args.key === 'avoid_departure_before',
    );
    if (preferenceText && !rememberedPreference) {
      return result([inputFor('vault__remember', input.tools, {
        key: 'avoid_departure_before',
        value: '07:00',
        source: 'stated',
        evidence: preferenceText,
      }, 'remember-departure-time')]);
    }

    const matched = scenarios.find((scenario) => userTexts.some((userText) => scenario.match.test(userText)));
    if (!matched) {
      if (preferenceText && rememberedPreference) {
        return result([{ type: 'text', text: 'Understood. I will avoid flights before 07:00.' }], 1);
      }
      return result([{ type: 'text', text: unknownScenarioMessage }], 1);
    }
    const excludedOffers = new Set(userTexts.flatMap((userText) =>
      [...userText.matchAll(/without ([\w-]+)/gi)].map((match) => match[1]).filter((id): id is string => Boolean(id)),
    ));
    const dates = datesFrom(asOf);
    const recovery = input.messages.some((message) => message.role === 'user' && message.content.includes('Confirmation failed'));
    const overBudgetProposal = responses.find((item) => item.name === 'internal__propose_itinerary' && item.value.ok === false);
    const hasReleasedOverBudgetHolds = responses.some((response) =>
      response.name.endsWith('__release_hold') && response.value.state === 'released',
    );
    const failedProposal = overBudgetProposal && !hasReleasedOverBudgetHolds ? overBudgetProposal : undefined;
    const replanCheaper = Boolean(overBudgetProposal) || recovery;
    const memoryScenario = matched.id === 'goa-memory';
    const party = memoryScenario ? 2 : 1;
    let memoryProfile: Array<{ key: string; value: string }> = [];
    let previousTrip: { party: number; total: number } | undefined;
    if (memoryScenario) {
      const profileResponse = responses.find((response) => response.name === 'vault__get_profile');
      const tripsResponse = responses.find((response) => response.name === 'vault__list_trips');
      const memoryCalls = [
        ...(!profileResponse ? [inputFor('vault__get_profile', input.tools, {}, 'memory-profile')] : []),
        ...(!tripsResponse ? [inputFor('vault__list_trips', input.tools, { limit: 5 }, 'memory-trips')] : []),
      ];
      if (memoryCalls.length) return result(memoryCalls);
      const profile = profileResponse?.value.profile;
      if (Array.isArray(profile)) {
        memoryProfile = profile.filter((entry): entry is { key: string; value: string } =>
          Boolean(entry) && typeof entry === 'object' &&
          typeof (entry as { key?: unknown }).key === 'string' &&
          typeof (entry as { value?: unknown }).value === 'string',
        );
      }
      const trips = tripsResponse?.value.trips;
      const firstTrip = Array.isArray(trips) ? trips[0] : undefined;
      if (firstTrip && typeof firstTrip === 'object') {
        const trip = firstTrip as { party?: unknown; total?: unknown };
        if (Number.isInteger(trip.party) && typeof trip.total === 'number') {
          previousTrip = { party: trip.party as number, total: trip.total };
        }
      }
    }
    const avoidDepartureBefore = memoryProfile.find((entry) => entry.key === 'avoid_departure_before')?.value === '07:00' ||
      input.system.includes('avoid_departure_before=07:00');
    const previousBudget = previousTrip
      ? Math.ceil(previousTrip.total * party / previousTrip.party)
      : matched.budget * party;
    const budget = memoryScenario ? previousBudget : matched.budget;
    const searchSpecifications = [
      { name: 'air__search_flights', args: { origin: 'BLR', destination: 'GOX', date: dates.departure, pax: party, ...(avoidDepartureBefore ? { depart_after: '07:00' } : {}) } },
      { name: 'air__search_flights', args: { origin: 'GOX', destination: 'BLR', date: dates.returnDate, pax: party, ...(avoidDepartureBefore ? { depart_after: '07:00' } : {}) } },
      { name: 'stay__search_stays', args: { area: 'north', checkin: dates.departure, checkout: dates.checkout, guests: party } },
      { name: 'local__search_places', args: { area: 'north', kind: 'food' } },
      { name: 'local__search_places', args: { area: 'north', kind: 'activity' } },
    ];
    const hasSearch = (spec: typeof searchSpecifications[number]) => responses.some((response) =>
      response.name === spec.name && Object.entries(spec.args).every(([key, value]) => response.args[key] === value),
    );
    const missingSearches = searchSpecifications.filter((spec) => !hasSearch(spec));
    if (missingSearches.length) {
      return result(missingSearches.map((spec, index) => inputFor(spec.name, input.tools, spec.args, `search-${responses.length}-${index}`)));
    }

    const outbound = offerList(responses, (response) => response.name === 'air__search_flights' && response.args.origin === 'BLR').filter((offer) => !excludedOffers.has(offer.id));
    const returning = offerList(responses, (response) => response.name === 'air__search_flights' && response.args.origin === 'GOX').filter((offer) => !excludedOffers.has(offer.id));
    const stays = offerList(responses, (response) => response.name === 'stay__search_stays').filter((offer) => !excludedOffers.has(offer.id));
    const foods = offerList(responses, (response) => response.name === 'local__search_places' && response.args.kind === 'food').filter((offer) => !excludedOffers.has(offer.id));
    const activities = offerList(responses, (response) => response.name === 'local__search_places' && response.args.kind === 'activity').filter((offer) => !excludedOffers.has(offer.id));
    const expensive = matched.id === 'goa-comfort' && !replanCheaper;
    const plan = expensive ? comfortPlan(party, 2, dates.departure, asOf) : cheapestPlan(party, 2, dates.departure, asOf);
    const premium = 'premiumFood' in plan;
    const preferredFoodId = premium ? plan.premiumFood.id : plan.cheapFood.id;
    const preferredActivityId = premium ? plan.premiumActivity.id : plan.cheapActivity.id;
    const selected = [
      pickPrice(outbound, 'price_per_pax', expensive, plan.flight.id),
      pickPrice(returning, 'price_per_pax', expensive),
      pickPrice(stays, 'price_per_night', expensive, plan.stay.id),
      pickPrice(foods, 'price_per_head', expensive, preferredFoodId),
      pickPrice(foods.filter((offer) => offer.id !== preferredFoodId), 'price_per_head', expensive),
      pickPrice(activities, 'price_per_head', expensive, preferredActivityId),
    ];
    if (selected.some((offer) => !offer)) return result([{ type: 'text', text: 'I could not find all trip options.' }], 1);

    const holdSpecs = [
      { tool: 'air__hold_flight', offer: selected[0] as Offer, args: { pax: party } },
      { tool: 'air__hold_flight', offer: selected[1] as Offer, args: { pax: party } },
      { tool: 'stay__hold_stay', offer: selected[2] as Offer, args: { checkin: dates.departure, checkout: dates.checkout, guests: party } },
      ...selected.slice(3, 5).map((offer, index) => ({
        tool: 'local__hold_table',
        offer: offer as Offer,
        args: { when: `${dates.departure}T${index === 0 ? '19:00' : '20:00'}:00.000Z`, party },
      })),
      { tool: 'local__hold_table', offer: selected[5] as Offer, args: { when: `${dates.returnDate}T10:00:00.000Z`, party } },
    ];
    const activeHolds = responses.filter((response) =>
      response.value.state === 'held' && typeof response.value.hold_id === 'string' &&
      ['air__hold_flight', 'stay__hold_stay', 'local__hold_table'].includes(response.name),
    );
    const releasedIds = new Set(responses.filter((response) => response.value.state !== 'held')
      .map((response) => response.value.hold_id).filter((id): id is string => typeof id === 'string'));
    if (failedProposal) {
      const activeToRelease = activeHolds.filter((response) => !releasedIds.has(response.value.hold_id as string));
      if (activeToRelease.length) {
        return result(activeToRelease.flatMap((response, index) => {
          const server = response.name.split('__')[0];
          return [inputFor(`${server}__release_hold`, input.tools, { hold_id: response.value.hold_id }, `release-overbudget-${index}`)];
        }));
      }
    }
    const heldOffers = new Set(activeHolds.filter((response) => !releasedIds.has(response.value.hold_id as string))
      .map((response) => response.value.offer_id));
    const missingHolds = holdSpecs.filter((spec) => !heldOffers.has(spec.offer.id));
    if (missingHolds.length) {
      return result([
        ...(overBudgetProposal && hasReleasedOverBudgetHolds ? [{ type: 'text' as const, text: 'I swapped to lower-priced flights, lodging, and activities to fit your budget.' }] : []),
        ...missingHolds.map((spec, index) => inputFor(spec.tool, input.tools, {
          ...spec.args,
          offer_id: spec.offer.id,
          ...(spec.tool === 'air__hold_flight' ? {} : {}),
          idem_key: `scenario-${matched.id}-${responses.length}-${index}-${spec.offer.id}`,
        }, `hold-${responses.length}-${index}`)),
      ]);
    }

    const proposed = responses.filter((response) => response.name === 'internal__propose_itinerary').length;
    if (recovery || !responses.some((response) => response.name === 'internal__propose_itinerary' && response.value.ok === true)) {
      const holdIds = activeHolds.filter((response) => !releasedIds.has(response.value.hold_id as string))
        .map((response) => response.value.hold_id).filter((id): id is string => typeof id === 'string');
      if (holdIds.length !== holdSpecs.length) {
        return result(holdSpecs.map((spec, index) => inputFor(spec.tool, input.tools, {
          ...spec.args, offer_id: spec.offer.id, idem_key: `scenario-${matched.id}-retry-${proposed}-${index}`,
        }, `rehold-${proposed}-${index}`)));
      }
      if (failedProposal) {
        return result(holdIds.flatMap((holdId, index) => {
          const hold = activeHolds.find((response) => response.value.hold_id === holdId);
          const server = hold?.name.split('__')[0];
          return server ? [inputFor(`${server}__release_hold`, input.tools, { hold_id: holdId }, `release-${proposed}-${index}`)] : [];
        }));
      }
      return result([inputFor('internal__propose_itinerary', input.tools, {
        title: 'Weekend in Goa',
        hold_ids: holdIds,
        budget,
      }, `propose-${proposed}`)]);
    }
    return result([{ type: 'text', text: 'Your round-trip weekend itinerary is ready.' }], 1);
  }
}
