import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signConfirm } from '@velox/core';
import { createServeApp } from '../kit/serve.js';
import { createLocalServer } from './server.js';

const testAsOf = '2026-06-01T00:00:00.000Z';
let serverHandle: Server | undefined;
let url: string;
let localServer: ReturnType<typeof createLocalServer>;
let testDir: string;

function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const address = server.address();
      if (typeof address === 'object' && address && address.port > 0) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'velox-local-test-'));
  localServer = createLocalServer({ dbPath: join(testDir, 'local.db') });
  const { server } = createServeApp(() => localServer, { serverName: 'local', port: 0 });
  serverHandle = server;
  await waitForListening(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local test server did not bind to a TCP port');
  url = `http://127.0.0.1:${address.port}/mcp`;
});

afterEach(async () => {
  const server = serverHandle;
  serverHandle = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await rm(testDir, { recursive: true, force: true });
});

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'local-test-client', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await run(client);
  } finally {
    await client.close();
  }
}

test('search_places applies kind, area, price, outdoor, and tag filters', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'search_places',
      arguments: { area: 'north', kind: 'food', max_per_head: 1000, outdoor: false, tags: ['family'], as_of: testAsOf },
    });
    const offers = (result.structuredContent as { offers: Array<{ kind: string; area: string; price_per_head: number; outdoor: boolean; tags: string[] }> }).offers;
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((offer) =>
      offer.kind === 'food' && offer.area === 'north' && offer.price_per_head <= 1000 &&
      !offer.outdoor && offer.tags.includes('family'),
    )).toBe(true);
  });
});

test('forecast reflects lead time for Saturday weather', async () => {
  await withClient(async (client) => {
    const farForecast = await client.callTool({
      name: 'get_forecast',
      arguments: { area: 'north', date_from: '2026-06-06', date_to: '2026-06-06', as_of: '2026-06-02T00:00:00.000Z' },
    });
    const nearForecast = await client.callTool({
      name: 'get_forecast',
      arguments: { area: 'north', date_from: '2026-06-06', date_to: '2026-06-06', as_of: '2026-06-05T00:00:00.000Z' },
    });
    expect((farForecast.structuredContent as { forecast: Array<{ condition: string }> }).forecast[0].condition).toBe('sunny');
    expect((nearForecast.structuredContent as { forecast: Array<{ condition: string }> }).forecast[0].condition).toBe('rain');
  });
});

test('hold_table handles food and activities with release, token confirmation, cancellation, and idempotency', async () => {
  await withClient(async (client) => {
    const search = await client.callTool({
      name: 'search_places',
      arguments: { area: 'north', kind: 'food', max_per_head: 1000, outdoor: false, tags: ['family'], as_of: testAsOf },
    });
    const foodOffers = (search.structuredContent as { offers: Array<{ id: string }> }).offers;
    expect(foodOffers.length).toBeGreaterThan(1);
    const foodHoldArgs = { offer_id: foodOffers[0].id, when: '2026-06-10T19:00:00.000Z', party: 2, idem_key: 'food-repeat', as_of: testAsOf };
    const hold = await client.callTool({ name: 'hold_table', arguments: foodHoldArgs });
    const holdId = (hold.structuredContent as { hold_id: string }).hold_id;
    const repeatedHold = await client.callTool({ name: 'hold_table', arguments: foodHoldArgs });
    expect((repeatedHold.structuredContent as { hold_id: string }).hold_id).toBe(holdId);
    expect(localServer.store.countHolds()).toBe(1);

    const missing = await client.callTool({ name: 'confirm_table', arguments: { hold_id: holdId, token: '', plan_id: 'local-plan', as_of: testAsOf } });
    expect((missing.structuredContent as { code: string }).code).toBe('FORBIDDEN');
    const wrong = await client.callTool({ name: 'confirm_table', arguments: { hold_id: holdId, token: 'wrong', plan_id: 'local-plan', as_of: testAsOf } });
    expect((wrong.structuredContent as { code: string }).code).toBe('FORBIDDEN');
    const token = signConfirm('dev-secret', holdId, 'local-plan');
    const confirmArgs = { hold_id: holdId, token, plan_id: 'local-plan', idem_key: 'local-confirm-repeat', as_of: testAsOf };
    const confirmed = await client.callTool({ name: 'confirm_table', arguments: confirmArgs });
    expect((confirmed.structuredContent as { state: string }).state).toBe('confirmed');
    const repeatedConfirm = await client.callTool({ name: 'confirm_table', arguments: confirmArgs });
    expect(repeatedConfirm.structuredContent).toEqual(confirmed.structuredContent);

    const cancelArgs = { hold_id: holdId, as_of: testAsOf };
    const cancelled = await client.callTool({ name: 'cancel_booking', arguments: cancelArgs });
    const repeatedCancel = await client.callTool({ name: 'cancel_booking', arguments: cancelArgs });
    expect((cancelled.structuredContent as { state: string }).state).toBe('cancelled');
    expect(repeatedCancel.structuredContent).toEqual(cancelled.structuredContent);

    const activitySearch = await client.callTool({
      name: 'search_places',
      arguments: { area: 'north', kind: 'activity', outdoor: true, as_of: testAsOf },
    });
    const activities = (activitySearch.structuredContent as { offers: Array<{ id: string }> }).offers;
    expect(activities.length).toBeGreaterThan(0);
    const activityHold = await client.callTool({
      name: 'hold_table',
      arguments: { offer_id: activities[0].id, when: '2026-06-11T10:00:00.000Z', party: 1, idem_key: 'activity-release', as_of: testAsOf },
    });
    const activityHoldId = (activityHold.structuredContent as { hold_id: string }).hold_id;
    const releaseArgs = { hold_id: activityHoldId, as_of: testAsOf };
    const released = await client.callTool({ name: 'release_hold', arguments: releaseArgs });
    const repeatedRelease = await client.callTool({ name: 'release_hold', arguments: releaseArgs });
    expect((released.structuredContent as { state: string }).state).toBe('released');
    expect(repeatedRelease.structuredContent).toEqual(released.structuredContent);
  });
});
