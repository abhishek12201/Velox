import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { LlmMessage, LlmProvider } from '../../packages/agent/src/llm/types.js';
import { ScenarioProvider } from '../../packages/agent/src/llm/mock.js';
import { createAgentApp } from '../../packages/agent/src/api.js';
import { start } from '../../packages/servers/src/main.js';
import { eventsFrom } from './events.js';

async function waitForPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
  return address.port;
}

async function postJson(baseUrl: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('S5 remembers a stated preference, saves a trip, and reuses both in a new session', async () => {
  const asOf = '2026-10-10T00:00:00.000Z';
  const names = ['air', 'stay', 'local', 'vault'] as const;
  const dataDir = await mkdtemp(join(tmpdir(), `velox-memory-${randomUUID()}-`));
  const servers: Server[] = [];
  const dbPaths = Object.fromEntries(names.map((name) => [name, join(dataDir, `${name}.db`)])) as Record<typeof names[number], string>;
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;
  const providerInputs: Array<{ system: string; messages: LlmMessage[] }> = [];
  try {
    const serverUrls: Partial<Record<typeof names[number], string>> = {};
    for (const name of names) {
      const { server } = start(name, { port: 0, dbPath: dbPaths[name] });
      servers.push(server);
      serverUrls[name] = `http://127.0.0.1:${await waitForPort(server)}/mcp`;
    }
    const scenario = new ScenarioProvider();
    const provider: LlmProvider = {
      async converse(input) {
        providerInputs.push({
          system: input.system,
          messages: input.messages.map((message) => ({ ...message })),
        });
        return scenario.converse(input);
      },
    };
    agent = await createAgentApp({ serverUrls, provider, asOf });
    apiServer = createHttpServer(agent.app);
    apiServer.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${await waitForPort(apiServer)}`;

    const preferenceResponse = await postJson(baseUrl, '/api/chat', {
      session_id: 'session-a',
      text: 'I hate flights before 7am',
    });
    const preferenceEvents = eventsFrom(await preferenceResponse.text());
    const rememberCall = preferenceEvents.find((event) => event.type === 'call' && event.server === 'vault' && event.tool === 'remember');
    expect(rememberCall?.args).toMatchObject({
      key: 'avoid_departure_before',
      value: '07:00',
      source: 'stated',
      evidence: 'I hate flights before 7am',
    });
    expect(preferenceEvents.some((event) => event.type === 'chip' && event.text === 'Remembered: avoids flights before 07:00')).toBe(true);

    const firstTrip = await postJson(baseUrl, '/api/chat', {
      session_id: 'session-a',
      text: 'Weekend in Goa under 20k',
    });
    const firstTripEvents = eventsFrom(await firstTrip.text());
    const firstCard = firstTripEvents.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary' && card.status === 'proposed');
    expect(firstCard?.plan_id).toBeTypeOf('string');
    const confirmation = await postJson(baseUrl, '/api/confirm', {
      session_id: 'session-a',
      plan_id: firstCard?.plan_id,
    });
    const confirmationEvents = eventsFrom(await confirmation.text());
    expect(confirmationEvents.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'confirmed')).toBe(true);

    const sessionReset = await postJson(baseUrl, '/api/reset', { scope: 'session', session_id: 'session-a' });
    expect(sessionReset.status).toBe(200);
    const secondTrip = await postJson(baseUrl, '/api/chat', {
      session_id: 'session-b',
      text: 'Same as last Goa trip, but my sister is coming',
    });
    const secondTripEvents = eventsFrom(await secondTrip.text());
    const calls = secondTripEvents.filter((event) => event.type === 'call');
    expect(calls.some((event) => event.server === 'vault' && event.tool === 'get_profile')).toBe(true);
    expect(calls.some((event) => event.server === 'vault' && event.tool === 'list_trips')).toBe(true);
    const flightSearches = calls.filter((event) => event.server === 'air' && event.tool === 'search_flights');
    expect(flightSearches).toHaveLength(2);
    expect(flightSearches.every((event) => (event.args as Record<string, unknown>).pax === 2 &&
      (event.args as Record<string, unknown>).depart_after === '07:00')).toBe(true);
    expect(calls.filter((event) => event.server === 'air' && event.tool === 'hold_flight')
      .every((event) => (event.args as Record<string, unknown>).pax === 2)).toBe(true);
    expect(providerInputs.some((input) => input.system.includes('avoid_departure_before=07:00'))).toBe(true);
    const profileLines = providerInputs.flatMap((input) => input.system.split('\n'))
      .filter((line) => line.startsWith('Travel profile: '));
    expect(profileLines.length).toBeGreaterThan(0);
    expect(profileLines.every((line) => new TextEncoder().encode(line).length <= 300)).toBe(true);

    const secondCard = secondTripEvents.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary' && card.status === 'proposed');
    expect(secondCard).toBeTruthy();
    expect(secondCard?.budget).toBe((firstCard?.total as number) * 2);
    expect(secondCard?.total).toBeLessThanOrEqual(secondCard?.budget as number);
    const recordedFlights = providerInputs.flatMap((input) => input.messages)
      .filter((message) => message.role === 'tool' && message.name === 'air__search_flights')
      .map((message) => JSON.parse(message.content) as { offers?: Array<{ depart?: string }> });
    const departures = recordedFlights.flatMap((response) => response.offers ?? [])
      .map((offer) => offer.depart);
    expect(departures.length).toBeGreaterThan(0);
    expect(departures.every((departure) => typeof departure === 'string' && departure.slice(11, 16) >= '07:00')).toBe(true);

    const airDb = new Database(dbPaths.air, { readonly: true });
    try {
      const twoPersonHolds = airDb.prepare('SELECT qty, state FROM holds WHERE qty = 2').all() as Array<{ qty: number; state: string }>;
      expect(twoPersonHolds).toHaveLength(2);
      expect(twoPersonHolds.every((hold) => hold.state === 'held')).toBe(true);
    } finally {
      airDb.close();
    }

    const allReset = await postJson(baseUrl, '/api/reset', { scope: 'all' });
    expect(allReset.status).toBe(200);
    const vaultDb = new Database(dbPaths.vault, { readonly: true });
    try {
      expect(vaultDb.prepare('SELECT COUNT(*) AS count FROM profile').get()).toEqual({ count: 0 });
      expect(vaultDb.prepare('SELECT COUNT(*) AS count FROM trips').get()).toEqual({ count: 0 });
    } finally {
      vaultDb.close();
    }
  } finally {
    const errors: unknown[] = [];
    const cleanup = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    };
    if (apiServer?.listening) {
      await cleanup(() => new Promise<void>((resolve, reject) => {
        apiServer?.close((error) => error ? reject(error) : resolve());
      }));
    }
    if (agent) await cleanup(() => agent?.close() ?? Promise.resolve());
    for (const server of servers) {
      if (server.listening) {
        await cleanup(() => new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }));
      }
    }
    await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, 'Memory test cleanup failed');
  }
}, 30_000);
