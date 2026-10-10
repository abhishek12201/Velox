import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServeApp } from '../kit/serve.js';
import { createVaultServer } from './server.js';

async function withVault<T>(run: (client: Client, vault: ReturnType<typeof createVaultServer>) => Promise<T>): Promise<T> {
  const vault = createVaultServer({ dbPath: ':memory:' });
  const { server } = createServeApp(() => vault, { serverName: 'vault', port: 0 });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Vault test server did not bind to a TCP port');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client({ name: 'vault-test-client', version: '1.0.0' }, { capabilities: {} });
  let connected = false;
  try {
    await client.connect(transport);
    connected = true;
    return await run(client, vault);
  } finally {
    if (connected) await transport.terminateSession();
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('remember upserts source and evidence for get_profile', async () => {
  await withVault(async (client) => {
    const initial = await client.callTool({ name: 'get_profile', arguments: { as_of: '2026-06-01T00:00:00.000Z' } });
    expect((initial.structuredContent as { profile: unknown[] }).profile).toEqual([]);
    const first = await client.callTool({
      name: 'remember',
      arguments: { key: 'diet', value: 'vegetarian', source: 'stated', evidence: 'I prefer vegetarian meals.', as_of: '2026-06-01T00:00:00.000Z' },
    });
    expect((first.structuredContent as { source: string }).source).toBe('stated');
    const updated = await client.callTool({
      name: 'remember',
      arguments: { key: 'diet', value: 'mostly vegetarian', source: 'inferred', evidence: 'Skipped meat options twice.', as_of: '2026-06-01T00:00:00.000Z' },
    });
    expect((updated.structuredContent as { source: string }).source).toBe('inferred');
    const profile = await client.callTool({ name: 'get_profile', arguments: { as_of: '2026-06-01T00:00:00.000Z' } });
    expect((profile.structuredContent as { profile: Array<{ key: string; value: string; source: string; evidence: string }> }).profile)
      .toMatchObject([{ key: 'diet', value: 'mostly vegetarian', source: 'inferred', evidence: 'Skipped meat options twice.' }]);
  });
});

test('save_trip is app-only and list_trips returns newest trips first', async () => {
  await withVault(async (client) => {
    const listed = await client.listTools();
    const saveTool = listed.tools.find((tool) => tool.name === 'save_trip');
    expect(saveTool?._meta?.['velox/audience']).toBe('app');

    const firstPlan = JSON.stringify({ party: 2, start: '2026-06-10', end: '2026-06-12', total: 12000 });
    const secondPlan = JSON.stringify({ party: 1, start: '2026-07-10', end: '2026-07-11', total: 7000 });
    const first = await client.callTool({
      name: 'save_trip',
      arguments: { plan_json: firstPlan, title: 'June trip', as_of: '2026-06-01T00:00:00.000Z' },
    });
    expect(first.isError).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await client.callTool({
      name: 'save_trip',
      arguments: { plan_json: secondPlan, title: 'July trip', as_of: '2026-06-01T00:00:00.000Z' },
    });

    const trips = await client.callTool({ name: 'list_trips', arguments: { limit: 5, as_of: '2026-06-01T00:00:00.000Z' } });
    expect((trips.structuredContent as { trips: Array<{ title: string }> }).trips.map((trip) => trip.title))
      .toEqual(['July trip', 'June trip']);
  });
});
