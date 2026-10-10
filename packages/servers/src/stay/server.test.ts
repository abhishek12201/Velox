import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signConfirm } from '@velox/core';
import { createServeApp } from '../kit/serve.js';
import { createStayServer } from './server.js';

const testAsOf = '2026-06-01T00:00:00.000Z';
let serverHandle: Server | undefined;
let url: string;
let stayServer: ReturnType<typeof createStayServer>;
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
  testDir = await mkdtemp(join(tmpdir(), 'velox-stay-test-'));
  stayServer = createStayServer({ dbPath: join(testDir, 'stay.db') });
  const { server } = createServeApp(() => stayServer, { serverName: 'stay', port: 0 });
  serverHandle = server;
  await waitForListening(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Stay test server did not bind to a TCP port');
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
  const client = new Client({ name: 'stay-test-client', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await run(client);
  } finally {
    await client.close();
  }
}

test('search_stays applies area, nightly budget, and tag filters', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'search_stays',
      arguments: { area: 'north', checkin: '2026-06-10', checkout: '2026-06-12', guests: 1, max_per_night: 5000, tags: ['hillside'], as_of: testAsOf },
    });
    const offers = (result.structuredContent as { offers: Array<{ area: string; price_per_night: number; tags: string[] }> }).offers;
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((offer) => offer.area === 'north' && offer.price_per_night <= 5000 && offer.tags.includes('hillside'))).toBe(true);
  });
});

test('stay holds support idempotency, release, token confirmation, and cancellation', async () => {
  await withClient(async (client) => {
    const search = await client.callTool({
      name: 'search_stays',
      arguments: { area: 'north', checkin: '2026-06-10', checkout: '2026-06-12', guests: 2, as_of: testAsOf },
    });
    const offers = (search.structuredContent as { offers: Array<{ id: string }> }).offers;
    expect(offers.length).toBeGreaterThan(1);

    const holdArgs = { offer_id: offers[0].id, checkin: '2026-06-10', checkout: '2026-06-12', guests: 2, idem_key: 'stay-repeat', as_of: testAsOf };
    const hold = await client.callTool({ name: 'hold_stay', arguments: holdArgs });
    const holdId = (hold.structuredContent as { hold_id: string }).hold_id;
    const repeatedHold = await client.callTool({ name: 'hold_stay', arguments: holdArgs });
    expect((repeatedHold.structuredContent as { hold_id: string }).hold_id).toBe(holdId);
    expect(stayServer.store.countHolds()).toBe(1);

    const missing = await client.callTool({ name: 'confirm_stay', arguments: { hold_id: holdId, token: '', plan_id: 'stay-plan', as_of: testAsOf } });
    expect((missing.structuredContent as { code: string }).code).toBe('FORBIDDEN');
    const wrong = await client.callTool({ name: 'confirm_stay', arguments: { hold_id: holdId, token: 'wrong', plan_id: 'stay-plan', as_of: testAsOf } });
    expect((wrong.structuredContent as { code: string }).code).toBe('FORBIDDEN');
    const token = signConfirm('dev-secret', holdId, 'stay-plan');
    const confirmArgs = { hold_id: holdId, token, plan_id: 'stay-plan', idem_key: 'stay-confirm-repeat', as_of: testAsOf };
    const confirmed = await client.callTool({ name: 'confirm_stay', arguments: confirmArgs });
    expect((confirmed.structuredContent as { state: string }).state).toBe('confirmed');
    const repeatedConfirm = await client.callTool({ name: 'confirm_stay', arguments: confirmArgs });
    expect(repeatedConfirm.structuredContent).toEqual(confirmed.structuredContent);

    const cancelArgs = { hold_id: holdId, as_of: testAsOf };
    const cancelled = await client.callTool({ name: 'cancel_booking', arguments: cancelArgs });
    const repeatedCancel = await client.callTool({ name: 'cancel_booking', arguments: cancelArgs });
    expect((cancelled.structuredContent as { state: string }).state).toBe('cancelled');
    expect(repeatedCancel.structuredContent).toEqual(cancelled.structuredContent);

    const releaseHold = await client.callTool({
      name: 'hold_stay',
      arguments: { offer_id: offers[1].id, checkin: '2026-06-10', checkout: '2026-06-12', guests: 1, idem_key: 'stay-release', as_of: testAsOf },
    });
    const releaseId = (releaseHold.structuredContent as { hold_id: string }).hold_id;
    const releaseArgs = { hold_id: releaseId, as_of: testAsOf };
    const released = await client.callTool({ name: 'release_hold', arguments: releaseArgs });
    const repeatedRelease = await client.callTool({ name: 'release_hold', arguments: releaseArgs });
    expect((released.structuredContent as { state: string }).state).toBe('released');
    expect(repeatedRelease.structuredContent).toEqual(released.structuredContent);
  });
});
