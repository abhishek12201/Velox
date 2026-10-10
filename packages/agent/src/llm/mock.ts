import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './types.js';
import { scenarios, unknownScenarioMessage } from './scenarios.js';

interface Offer {
  id: string;
  name?: string;
  price_per_pax?: number;
  price_per_night?: number;
  price_per_head?: number;
  [key: string]: unknown;
}

function lastUserText(messages: LlmMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function toolResponses(messages: LlmMessage[]): Array<{ name: string; value: Record<string, unknown> }> {
  return messages.flatMap((message) => {
    if (message.role !== 'tool' || !message.name) return [];
    const value: unknown = JSON.parse(message.content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? [{ name: message.name, value: value as Record<string, unknown> }]
      : [];
  });
}

function offersFrom(responses: Array<{ name: string; value: Record<string, unknown> }>, suffix: string): Offer[] {
  const response = responses.find(({ name }) => name.endsWith(suffix));
  const offers = response?.value.offers;
  if (!Array.isArray(offers)) return [];
  return offers.filter((offer): offer is Offer =>
    Boolean(offer) && typeof offer === 'object' && typeof (offer as Offer).id === 'string',
  );
}

function cheapest(offers: Offer[], priceField: 'price_per_pax' | 'price_per_night' | 'price_per_head'): Offer | undefined {
  return [...offers].sort((left, right) =>
    Number(left[priceField] ?? Number.MAX_SAFE_INTEGER) - Number(right[priceField] ?? Number.MAX_SAFE_INTEGER),
  )[0];
}

function inputFor(name: string, tools: ToolDefinition[], input: Record<string, unknown>): ToolUseBlock {
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`Scenario requires unavailable tool ${name}`);
  }
  return { type: 'tool_use', id: `mock-${name}`, name, input };
}

function callsForGoa(responses: Array<{ name: string; value: Record<string, unknown> }>, tools: ToolDefinition[]): ToolUseBlock[] | undefined {
  const searched = ['search_flights', 'search_stays', 'search_places']
    .every((toolName) => responses.some(({ name }) => name.endsWith(toolName)));

  if (!searched) {
    const departure = '2026-06-30';
    const checkout = '2026-07-02';
    return [
      inputFor('air__search_flights', tools, {
        origin: 'BLR', destination: 'GOX', date: departure, pax: 1, max_price: 12_000,
      }),
      inputFor('stay__search_stays', tools, {
        area: 'north', checkin: departure, checkout, guests: 1, max_per_night: 3_000,
      }),
      inputFor('local__search_places', tools, {
        area: 'north', kind: 'food', max_per_head: 1_000,
      }),
    ];
  }

  const flight = cheapest(offersFrom(responses, 'search_flights'), 'price_per_pax');
  const stay = cheapest(offersFrom(responses, 'search_stays'), 'price_per_night');
  const place = cheapest(offersFrom(responses, 'search_places'), 'price_per_head');

  if (!flight || !stay || !place) {
    return undefined;
  }

  const departure = '2026-06-30';
  const checkout = '2026-07-02';
  const holdResponses = ['hold_flight', 'hold_stay', 'hold_table']
    .map((toolName) => responses.some(({ name }) => name.endsWith(toolName)));
  if (holdResponses.some((present) => !present)) {
    return [
      inputFor('air__hold_flight', tools, {
        offer_id: flight.id, pax: 1, idem_key: `goa-flight-${flight.id}`,
      }),
      inputFor('stay__hold_stay', tools, {
        offer_id: stay.id, checkin: departure, checkout, guests: 1, idem_key: `goa-stay-${stay.id}`,
      }),
      inputFor('local__hold_table', tools, {
        offer_id: place.id, when: `${departure}T19:00:00.000Z`, party: 1, idem_key: `goa-food-${place.id}`,
      }),
    ];
  }

  const holds = responses
    .filter(({ name }) => ['hold_flight', 'hold_stay', 'hold_table'].some((toolName) => name.endsWith(toolName)))
    .map(({ value }) => value.hold_id)
    .filter((holdId): holdId is string => typeof holdId === 'string');
  return [inputFor('internal__propose_itinerary', tools, {
    title: 'Weekend in Goa', hold_ids: holds, budget: 20_000, total: 1,
  })];
}

export class ScenarioProvider implements LlmProvider {
  async converse(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<{ blocks: Array<{ type: 'text'; text: string } | ToolUseBlock>; stop: string; usage: { inputTokens: number; outputTokens: number } }> {
    if (!input.system.includes('Current time: ')) {
      throw new Error('Mock provider system prompt is missing the current time');
    }
    const matched = scenarios.find((scenario) => scenario.match.test(lastUserText(input.messages)));
    if (!matched) {
      const text = input.messages.some((message) => message.role === 'tool' && message.name?.endsWith('internal__propose_itinerary'))
        ? 'Your itinerary is ready.'
        : unknownScenarioMessage;
      return { blocks: [{ type: 'text', text }], stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 1 } };
    }

    const responses = toolResponses(input.messages);
    if (responses.some(({ name }) => name.endsWith('internal__propose_itinerary'))) {
      return { blocks: [{ type: 'text', text: 'Your itinerary is ready.' }], stop: 'end_turn', usage: { inputTokens: 0, outputTokens: 1 } };
    }
    const calls = callsForGoa(responses, input.tools);
    if (!calls?.length) {
      return {
        blocks: [{ type: 'text', text: 'I could not find matching options for this trip.' }],
        stop: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 1 },
      };
    }
    if (calls[0]?.name === 'internal__propose_itinerary') {
      return { blocks: calls, stop: 'tool_use', usage: { inputTokens: 0, outputTokens: 1 } };
    }
    return { blocks: calls, stop: 'tool_use', usage: { inputTokens: 0, outputTokens: calls.length } };
  }
}
