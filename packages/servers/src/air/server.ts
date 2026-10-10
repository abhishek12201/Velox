import crypto from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flightsFor, type FlightOffer } from '@velox/core';
import { HoldStore } from '../kit/store.js';
import { makeError } from '../kit/errors.js';
import { signConfirm, verifyConfirm } from '@velox/core';

export const MCP_PROTOCOL_VERSION = '2025-11-25';

const flightOutputSchema = z.object({
  offers: z.array(z.object({
    id: z.string(),
    kind: z.literal('flight'),
    from: z.string(),
    to: z.string(),
    depart: z.string(),
    arrive: z.string(),
    carrier: z.string(),
    flight_no: z.string(),
    price_per_pax: z.number().int(),
    stops: z.literal(0),
  })),
});

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function createAirServer(basePort = Number(process.env.PORT ?? 0), dataDir = process.env.VELOX_DATA_DIR ?? join(process.cwd(), 'data', `air-${crypto.randomUUID().slice(0, 8)}`)) {
  const store = new HoldStore('air', dataDir);
  const server = new McpServer({
    name: 'air',
    version: '1.0.0',
  }, {
    capabilities: {},
  });

  server.registerTool('search_flights', {
    description: 'Search flight options between two airports for a date and budget. Returns the best available flights sorted by price.',
    inputSchema: {
      origin: z.string().describe('Origin airport code'),
      destination: z.string().describe('Destination airport code'),
      date: z.string().describe('Travel date in ISO YYYY-MM-DD format'),
      pax: z.number().int().default(1).describe('Passengers'),
      max_price: z.number().int().optional().describe('Optional maximum spend per passenger'),
      depart_after: z.string().optional().describe('Optional earliest departure time in ISO local time'),
      depart_before: z.string().optional().describe('Optional latest departure time in ISO local time'),
      as_of: z.string().optional().describe('Hidden as_of timestamp used to price offers'),
    },
    outputSchema: flightOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ origin, destination, date, pax = 1, max_price, depart_after, depart_before, as_of }: any): Promise<any> => {
    const asOf = as_of ?? new Date().toISOString();
    const offers = flightsFor(origin, destination, date, asOf)
      .filter((offer) => offer.price_per_pax <= (max_price ?? Number.MAX_SAFE_INTEGER))
      .filter((offer) => !depart_after || offer.depart >= `${date}T${depart_after}`)
      .filter((offer) => !depart_before || offer.depart <= `${date}T${depart_before}`)
      .slice(0, 8)
      .map((offer) => ({ ...offer, price_per_pax: offer.price_per_pax * pax }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ offers }) }],
      structuredContent: { offers },
    };
  });

  server.registerTool('hold_flight', {
    description: 'Hold a flight offer for a short time window before confirmation. Reusing the same idem_key returns the original hold.',
    inputSchema: {
      offer_id: z.string().describe('Flight offer id'),
      pax: z.number().int().gte(1).default(1),
      idempotency_key: z.string().optional(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      hold_id: z.string(),
      offer_id: z.string(),
      amount: z.number().int(),
      qty: z.number().int(),
      state: z.literal('held'),
      expires_at: z.string(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ offer_id, pax = 1, idempotency_key, as_of }: any): Promise<any> => {
    const idemKey = idempotency_key ?? `flight:${offer_id}:${pax}:${as_of ?? Date.now()}`;
    const cached = store.getIdempotent<Record<string, unknown>>(idemKey);
    if (cached) {
      return {
        content: [{ type: 'text', text: JSON.stringify(cached) }],
        structuredContent: cached,
      };
    }
    const allFlights = flightsFor('BLR', 'GOX', '2026-06-30', as_of ?? new Date().toISOString());
    const offer = allFlights.find((entry) => entry.id === offer_id) ?? null;
    if (!offer) {
      return makeError('NOT_FOUND', `Flight offer ${offer_id} was not found`, true);
    }
    const holdId = `hold_${crypto.randomUUID().replace(/-/g, '')}`;
    const record = store.createHold(holdId, 'air', offer_id, offer.price_per_pax * pax, pax);
    store.upsertIdempotent(idemKey, {
      hold_id: record.hold_id,
      offer_id: record.offer_id,
      amount: record.amount,
      qty: record.qty,
      state: record.state,
      expires_at: record.expires_at,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ hold_id: record.hold_id, offer_id: record.offer_id, amount: record.amount, qty: record.qty, state: record.state, expires_at: record.expires_at }) }],
      structuredContent: { hold_id: record.hold_id, offer_id: record.offer_id, amount: record.amount, qty: record.qty, state: record.state, expires_at: record.expires_at },
    };
  });

  server.registerTool('release_hold', {
    description: 'Release a held flight reservation and clear it from the hold list.',
    inputSchema: {
      hold_id: z.string(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      hold_id: z.string(),
      state: z.literal('released'),
      offer_id: z.string(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ hold_id }: any): Promise<any> => {
    const hold = store.readHold(hold_id);
    if (!hold) {
      return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    }
    const released = store.releaseHold(hold_id) ?? hold;
    return {
      content: [{ type: 'text', text: JSON.stringify({ hold_id: released.hold_id, state: 'released', offer_id: released.offer_id }) }],
      structuredContent: { hold_id: released.hold_id, state: 'released', offer_id: released.offer_id },
    };
  });

  server.registerTool('confirm_flight', {
    description: 'Confirm a held flight using a valid HMAC token and plan id. The tool is app-only and should never be shown to the LLM.',
    inputSchema: {
      hold_id: z.string(),
      token: z.string(),
      plan_id: z.string(),
      idem_key: z.string().optional(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      hold_id: z.string(),
      state: z.literal('confirmed'),
      offer_id: z.string(),
      amount: z.number().int(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: { 'velox/audience': 'app' },
  }, async ({ hold_id, token, plan_id, idem_key }: any): Promise<any> => {
    const idemKey = idem_key ?? `${hold_id}:${plan_id}`;
    const cached = store.getIdempotent<Record<string, unknown>>(idemKey);
    if (cached) {
      return {
        content: [{ type: 'text', text: JSON.stringify(cached) }],
        structuredContent: cached,
      };
    }
    const hold = store.readHold(hold_id);
    if (!hold) {
      return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    }
    if (hold.state !== 'held') {
      return makeError('INVALID', `Hold ${hold_id} is not held`, false);
    }
    if (new Date(hold.expires_at).getTime() < Date.now()) {
      store.setHoldState(hold_id, 'expired');
      return makeError('HOLD_EXPIRED', `Hold ${hold_id} has expired`, true);
    }
    const chaos = store.consumeChaos();
    if (chaos) {
      return makeError('SOLD_OUT', `Confirmation failed due to ${chaos}`, true);
    }
    const expected = signConfirm(process.env.VELOX_CONFIRM_SECRET ?? 'dev-secret', hold_id, plan_id);
    if (!token || !verifyConfirm(process.env.VELOX_CONFIRM_SECRET ?? 'dev-secret', hold_id, plan_id, token)) {
      return makeError('FORBIDDEN', 'Missing or invalid confirmation token', false);
    }
    const confirmed = store.confirmHold(hold_id) ?? hold;
    const result = { hold_id: confirmed.hold_id, state: 'confirmed' as const, offer_id: confirmed.offer_id, amount: confirmed.amount };
    store.upsertIdempotent(idemKey, result);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });

  server.registerTool('cancel_booking', {
    description: 'Cancel a confirmed or held booking for a flight. Safe to call repeatedly.',
    inputSchema: {
      hold_id: z.string(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      hold_id: z.string(),
      state: z.literal('cancelled'),
      offer_id: z.string(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    _meta: { 'velox/audience': 'app' },
  }, async ({ hold_id }: any): Promise<any> => {
    const hold = store.readHold(hold_id);
    if (!hold) {
      return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    }
    const cancelled = store.cancelHold(hold_id) ?? hold;
    return {
      content: [{ type: 'text', text: JSON.stringify({ hold_id: cancelled.hold_id, state: 'cancelled', offer_id: cancelled.offer_id }) }],
      structuredContent: { hold_id: cancelled.hold_id, state: 'cancelled', offer_id: cancelled.offer_id },
    };
  });

  return {
    server,
    store,
    protocolVersion: MCP_PROTOCOL_VERSION,
    port: basePort,
    connect: (transport: any) => server.connect(transport),
    close: () => server.close(),
  };
}
