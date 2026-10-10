import crypto from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forecast, places, verifyConfirm } from '@velox/core';
import { HoldStore } from '../kit/store.js';
import { makeError } from '../kit/errors.js';

const areas = ['north', 'south', 'central'] as const;
const kinds = ['food', 'activity'] as const;
const conditionSchema = z.enum(['sunny', 'cloudy', 'rain']);

export function createLocalServer(options: { dbPath?: string; basePort?: number } = {}) {
  const basePort = options.basePort ?? Number(process.env.LOCAL_PORT ?? process.env.PORT ?? 7103);
  const store = new HoldStore('local', options.dbPath);
  const server = new McpServer({ name: 'local', version: '1.0.0' }, { capabilities: {} });

  server.registerTool('search_places', {
    description: 'Search synthetic food and activity offers by area, price, outdoor status, and tags.',
    inputSchema: {
      area: z.enum(areas).optional(),
      kind: z.enum(kinds),
      max_per_head: z.number().int().optional(),
      outdoor: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      offers: z.array(z.object({
        id: z.string(), kind: z.enum(kinds), name: z.string(), area: z.enum(areas),
        price_per_head: z.number().int(), tags: z.array(z.string()), outdoor: z.boolean(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ area, kind, max_per_head, outdoor, tags }: any): Promise<any> => {
    const offers = places()
      .filter((place) => place.kind === kind)
      .filter((place) => !area || place.area === area)
      .filter((place) => max_per_head === undefined || place.price_per_head <= max_per_head)
      .filter((place) => outdoor === undefined || place.outdoor === outdoor)
      .filter((place) => !tags || tags.every((tag: string) => place.tags.includes(tag)));
    return { content: [{ type: 'text', text: JSON.stringify({ offers }) }], structuredContent: { offers } };
  });

  server.registerTool('get_forecast', {
    description: 'Get a deterministic day-by-day synthetic weather forecast for an area and date range.',
    inputSchema: { area: z.enum(areas), date_from: z.string(), date_to: z.string(), as_of: z.string().optional() },
    outputSchema: z.object({
      forecast: z.array(z.object({ date: z.string(), condition: conditionSchema, rain_pct: z.number().int() })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ area, date_from, date_to, as_of }: any): Promise<any> => {
    const from = Date.parse(`${date_from}T00:00:00Z`);
    const to = Date.parse(`${date_to}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      return makeError('INVALID', 'Forecast dates must be a valid inclusive range', false);
    }
    const forecastDays = [];
    for (let timestamp = from; timestamp <= to; timestamp += 86400000) {
      const day = new Date(timestamp).toISOString().slice(0, 10);
      const result = forecast(area, day, as_of ?? new Date().toISOString());
      forecastDays.push({
        date: day,
        condition: result.rain ? 'rain' : result.chance >= 50 ? 'cloudy' : 'sunny',
        rain_pct: result.chance,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ forecast: forecastDays }) }], structuredContent: { forecast: forecastDays } };
  });

  server.registerTool('hold_table', {
    description: 'Hold a food or activity offer for a time and party size before confirmation.',
    inputSchema: { offer_id: z.string(), when: z.string(), party: z.number().int().gte(1), idem_key: z.string().optional(), as_of: z.string().optional() },
    outputSchema: z.object({
      hold_id: z.string(), offer_id: z.string(), amount: z.number().int(), qty: z.number().int(),
      state: z.literal('held'), expires_at: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ offer_id, when, party, idem_key }: any): Promise<any> => {
    const idemKey = idem_key ?? `local:${offer_id}:${when}:${party}`;
    const cached = store.getIdempotent<Record<string, unknown>>(idemKey);
    if (cached) return { content: [{ type: 'text' as const, text: JSON.stringify(cached) }], structuredContent: cached };
    const offer = places().find((place) => place.id === offer_id && (place.kind === 'food' || place.kind === 'activity'));
    if (!offer) return makeError('NOT_FOUND', `Local offer ${offer_id} was not found`, false);
    const holdId = `hold_${crypto.randomUUID().replace(/-/g, '')}`;
    const record = store.createHold(holdId, 'local', offer_id, offer.price_per_head * party, party);
    const result = {
      hold_id: record.hold_id, offer_id: record.offer_id, amount: record.amount, qty: record.qty,
      state: record.state, expires_at: record.expires_at,
    };
    store.upsertIdempotent(idemKey, result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('release_hold', {
    description: 'Release a food or activity reservation hold so it is no longer active.',
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

  server.registerTool('confirm_table', {
    description: 'Confirm a local food or activity hold with a valid HMAC token and plan id.',
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
    description: 'Cancel a confirmed or held local booking; repeated requests are safe.',
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
