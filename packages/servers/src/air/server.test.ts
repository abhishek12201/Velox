import { afterEach, beforeEach, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAirServer } from './server.js';
import { createServeApp } from '../kit/serve.js';
import { signConfirm } from '@velox/core';

let serverHandle: { close: (callback?: () => void) => void } | undefined;
let url: string;
let airServer: ReturnType<typeof createAirServer>;

function waitForListening(server: { address: () => any }): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const address = server.address();
      const port = typeof address === 'string' ? 0 : address?.port;
      if (typeof port === 'number' && port > 0) {
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

beforeEach(async () => {
  airServer = createAirServer();
  const { server } = createServeApp(() => airServer as any, { serverName: 'air', port: 0 });
  serverHandle = server;
  await waitForListening(server);
  const address = server.address();
  const port = typeof address === 'string' ? 0 : address?.port ?? 0;
  url = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  serverHandle?.close();
  serverHandle = undefined;
});

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test('initialization negotiates protocol and exposes app-only tools', async () => {
  const client = await connect();
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name);
  expect(names).toContain('search_flights');
  const confirmTool = result.tools.find((tool) => tool.name === 'confirm_flight');
  expect(confirmTool?._meta?.['velox/audience']).toBe('app');
  const cancelTool = result.tools.find((tool) => tool.name === 'cancel_booking');
  expect(cancelTool?._meta?.['velox/audience']).toBe('app');
  await client.close();
});

test('search -> hold -> release -> expiry works', async () => {
  const client = await connect();
  const search = await client.callTool({ name: 'search_flights', arguments: { origin: 'BLR', destination: 'GOX', date: '2026-06-30', pax: 1 } });
  const offer = (search.structuredContent as { offers: Array<{ id: string; price_per_pax: number }> }).offers[0];
  const hold = await client.callTool({ name: 'hold_flight', arguments: { offer_id: offer.id, pax: 1, idem_key: 'hold-key' } });
  const holdId = (hold as any).hold_id ?? (hold.structuredContent as { hold_id: string } | undefined)?.hold_id;
  await client.callTool({ name: 'release_hold', arguments: { hold_id: holdId } });
  const after = await client.callTool({ name: 'search_flights', arguments: { origin: 'BLR', destination: 'GOX', date: '2026-06-30', pax: 1 } });
  expect(after.structuredContent).toBeTruthy();
  await client.close();
});

test('confirm without token or with wrong token is forbidden; valid token confirms', async () => {
  const client = await connect();
  const search = await client.callTool({ name: 'search_flights', arguments: { origin: 'BLR', destination: 'GOX', date: '2026-06-30', pax: 1 } });
  const offer = (search.structuredContent as { offers: Array<{ id: string; price_per_pax: number }> }).offers[0];
  const hold = await client.callTool({ name: 'hold_flight', arguments: { offer_id: offer.id, pax: 1, idem_key: 'confirm-key' } });
  const holdId = (hold as any).hold_id ?? (hold.structuredContent as { hold_id: string } | undefined)?.hold_id;
  const wrong = await client.callTool({ name: 'confirm_flight', arguments: { hold_id: holdId, token: 'bad', plan_id: 'plan_1' } });
  expect((wrong as any).isError).toBe(true);
  const validToken = signConfirm('dev-secret', holdId, 'plan_1');
  const valid = await client.callTool({ name: 'confirm_flight', arguments: { hold_id: holdId, token: validToken, plan_id: 'plan_1' } });
  const validState = (valid as any).state ?? (valid.structuredContent as { state: string } | undefined)?.state;
  expect(validState).toBe('confirmed');
  await client.close();
});

test('cancel booking is idempotent and chaos triggers sold out once', async () => {
  const client = await connect();
  const search = await client.callTool({ name: 'search_flights', arguments: { origin: 'BLR', destination: 'GOX', date: '2026-06-30', pax: 1 } });
  const offer = (search.structuredContent as { offers: Array<{ id: string; price_per_pax: number }> }).offers[0];
  const hold = await client.callTool({ name: 'hold_flight', arguments: { offer_id: offer.id, pax: 1, idem_key: 'cancel-key' } });
  const holdId = (hold as any).hold_id ?? (hold.structuredContent as { hold_id: string } | undefined)?.hold_id;
  const validToken = signConfirm('dev-secret', holdId, 'plan_2');
  const chaos = await fetch('http://127.0.0.1:' + (serverHandle as any).address().port + '/admin/chaos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'SOLD_OUT', once: true }) });
  expect(await chaos.text()).toContain('ok');
  const fail = await client.callTool({ name: 'confirm_flight', arguments: { hold_id: holdId, token: validToken, plan_id: 'plan_2' } });
  expect((fail as any).isError).toBe(true);
  const cancel = await client.callTool({ name: 'cancel_booking', arguments: { hold_id: holdId } });
  const cancelState = (cancel as any).state ?? (cancel.structuredContent as { state: string } | undefined)?.state;
  expect(cancelState).toBe('cancelled');
  await client.close();
});

test('hold and confirm idempotency return the original results without duplicate holds', async () => {
  const client = await connect();
  const search = await client.callTool({ name: 'search_flights', arguments: { origin: 'BLR', destination: 'GOX', date: '2026-06-30', pax: 1 } });
  const offer = (search.structuredContent as { offers: Array<{ id: string }> }).offers[0];
  const originalHold = await client.callTool({
    name: 'hold_flight',
    arguments: { offer_id: offer.id, idem_key: 'repeat-hold-key' },
  });
  const holdId = (originalHold.structuredContent as { hold_id: string }).hold_id;
  expect(airServer.store.countHolds()).toBe(1);

  const repeatedHold = await client.callTool({
    name: 'hold_flight',
    arguments: { offer_id: offer.id, idem_key: 'repeat-hold-key' },
  });
  expect((repeatedHold.structuredContent as { hold_id: string }).hold_id).toBe(holdId);
  expect(airServer.store.countHolds()).toBe(1);

  const token = signConfirm('dev-secret', holdId, 'plan_idem');
  const originalConfirm = await client.callTool({
    name: 'confirm_flight',
    arguments: { hold_id: holdId, token, plan_id: 'plan_idem', idem_key: 'repeat-confirm-key' },
  });
  const repeatedConfirm = await client.callTool({
    name: 'confirm_flight',
    arguments: { hold_id: holdId, token, plan_id: 'plan_idem', idem_key: 'repeat-confirm-key' },
  });
  expect(repeatedConfirm.structuredContent).toEqual(originalConfirm.structuredContent);
  await client.close();
});

test('rejects MCP requests with a foreign Origin', async () => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(response.status).toBe(403);
});
