import crypto from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { stays, verifyConfirm } from '@velox/core';
import { HoldStore } from '../kit/store.js';
import { makeError } from '../kit/errors.js';

const areas = ['north', 'south', 'central'] as const;

const stayOutputSchema = z.object({
  offers: z.array(z.object({
    id: z.string(),
    kind: z.literal('stay'),
    name: z.string(),
    area: z.enum(areas),
    price_per_night: z.number().int(),
    rating: z.number(),
    tags: z.array(z.string()),
  })),
});

export function createStayServer(options: { dbPath?: string; basePort?: number } = {}) {
  const basePort = options.basePort ?? Number(process.env.STAY_PORT ?? process.env.PORT ?? 7102);
  const store = new HoldStore('stay', options.dbPath);
  const server = new McpServer({ name: 'stay', version: '1.0.0' }, { capabilities: {} });

  server.registerTool('search_stays', {
    description: 'Search available stays by area, dates, guests, nightly budget, and requested tags.',
    inputSchema: {
      area: z.enum(areas).optional(),
      checkin: z.string(),
      checkout: z.string(),
      guests: z.number().int().gte(1).default(1),
      max_per_night: z.number().int().optional(),
      tags: z.array(z.string()).optional(),
      as_of: z.string().optional(),
    },
    outputSchema: stayOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ area, checkin, checkout, guests = 1, max_per_night, tags }: any): Promise<any> => {
    const checkinTime = Date.parse(`${checkin}T00:00:00Z`);
    const checkoutTime = Date.parse(`${checkout}T00:00:00Z`);
    const validRange = Number.isFinite(checkinTime) && Number.isFinite(checkoutTime) && checkoutTime > checkinTime;
    const offers = validRange ? stays()
      .filter((stay) => !area || stay.area === area)
      .filter((stay) => !max_per_night || stay.price_per_night <= max_per_night)
      .filter((stay) => !tags || tags.every((tag: string) => stay.tags.includes(tag)))
      .map((stay) => ({ ...stay })) : [];
    return {
      content: [{ type: 'text', text: JSON.stringify({ offers }) }],
      structuredContent: { offers },
    };
  });

  server.registerTool('hold_stay', {
    description: 'Hold a stay offer for its requested dates and guests before confirmation.',
    inputSchema: {
      offer_id: z.string(),
      checkin: z.string(),
      checkout: z.string(),
      guests: z.number().int().gte(1).default(1),
      idem_key: z.string().optional(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      hold_id: z.string(), offer_id: z.string(), amount: z.number().int(), qty: z.number().int(),
      state: z.literal('held'), expires_at: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ offer_id, checkin, checkout, guests = 1, idem_key }: any): Promise<any> => {
    const idemKey = idem_key ?? `stay:${offer_id}:${checkin}:${checkout}:${guests}`;
    const cached = store.getIdempotent<Record<string, unknown>>(idemKey);
    if (cached) return { content: [{ type: 'text' as const, text: JSON.stringify(cached) }], structuredContent: cached };

    const checkinTime = Date.parse(`${checkin}T00:00:00Z`);
    const checkoutTime = Date.parse(`${checkout}T00:00:00Z`);
    const offer = stays().find((stay) => stay.id === offer_id);
    if (!offer || !Number.isFinite(checkinTime) || checkoutTime <= checkinTime) {
      return makeError('NOT_FOUND', `Stay offer ${offer_id} or its date range was not found`, false);
    }
    const nights = (checkoutTime - checkinTime) / 86400000;
    const holdId = `hold_${crypto.randomUUID().replace(/-/g, '')}`;
    const record = store.createHold(holdId, 'stay', offer_id, offer.price_per_night * nights, guests);
    const result = {
      hold_id: record.hold_id, offer_id: record.offer_id, amount: record.amount, qty: record.qty,
      state: record.state, expires_at: record.expires_at,
    };
    store.upsertIdempotent(idemKey, result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('release_hold', {
    description: 'Release a stay reservation hold so it is no longer active.',
    inputSchema: { hold_id: z.string(), as_of: z.string().optional() },
    outputSchema: z.object({ hold_id: z.string(), state: z.literal('released'), offer_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ hold_id }: any): Promise<any> => {
    const hold = store.readHold(hold_id);
    if (!hold) return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    const released = store.releaseHold(hold_id) ?? hold;
    const result = { hold_id: released.hold_id, state: 'released' as const, offer_id: released.offer_id };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('confirm_stay', {
    description: 'Confirm a stay hold using a valid HMAC token and plan id.',
    inputSchema: { hold_id: z.string(), token: z.string(), plan_id: z.string(), idem_key: z.string().optional(), as_of: z.string().optional() },
    outputSchema: z.object({ hold_id: z.string(), state: z.literal('confirmed'), offer_id: z.string(), amount: z.number().int() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'app' },
  }, async ({ hold_id, token, plan_id, idem_key }: any): Promise<any> => {
    const idemKey = idem_key ?? `${hold_id}:${plan_id}`;
    const cached = store.getIdempotent<Record<string, unknown>>(idemKey);
    if (cached) return { content: [{ type: 'text' as const, text: JSON.stringify(cached) }], structuredContent: cached };
    const hold = store.readHold(hold_id);
    if (!hold) return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    if (hold.state !== 'held') return makeError('INVALID', `Hold ${hold_id} is not held`, false);
    if (Date.parse(hold.expires_at) < Date.now()) {
      store.setHoldState(hold_id, 'expired');
      return makeError('HOLD_EXPIRED', `Hold ${hold_id} has expired`, true);
    }
    const chaos = store.consumeChaos();
    if (chaos) return makeError('SOLD_OUT', `Confirmation failed due to ${chaos}`, true);
    const secret = process.env.VELOX_CONFIRM_SECRET ?? 'dev-secret';
    if (!token || !verifyConfirm(secret, hold_id, plan_id, token)) {
      return makeError('FORBIDDEN', 'Missing or invalid confirmation token', false);
    }
    const confirmed = store.confirmHold(hold_id) ?? hold;
    const result = { hold_id: confirmed.hold_id, state: 'confirmed' as const, offer_id: confirmed.offer_id, amount: confirmed.amount };
    store.upsertIdempotent(idemKey, result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('cancel_booking', {
    description: 'Cancel a confirmed or held stay booking; repeated requests are safe.',
    inputSchema: { hold_id: z.string(), as_of: z.string().optional() },
    outputSchema: z.object({ hold_id: z.string(), state: z.literal('cancelled'), offer_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    _meta: { 'velox/audience': 'app' },
  }, async ({ hold_id }: any): Promise<any> => {
    const hold = store.readHold(hold_id);
    if (!hold) return makeError('NOT_FOUND', `Hold ${hold_id} was not found`, false);
    const cancelled = store.cancelHold(hold_id) ?? hold;
    const result = { hold_id: cancelled.hold_id, state: 'cancelled' as const, offer_id: cancelled.offer_id };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  return {
    server, store, port: basePort,
    connect: (transport: any) => server.connect(transport),
    close: () => server.close(),
  };
}
