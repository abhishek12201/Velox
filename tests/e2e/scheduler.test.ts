import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createAgentApp } from '../../packages/agent/src/api.js';
import { ScenarioProvider } from '../../packages/agent/src/llm/mock.js';
import { start } from '../../packages/servers/src/main.js';

const asOf = '2026-06-01T00:00:00.000Z';
const names = ['air', 'stay', 'local', 'vault'] as const;

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

function eventsFrom(body: string): Array<Record<string, unknown>> {
  return body.split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return [];
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSE event');
    return [value as Record<string, unknown>];
  });
}

async function postJson(baseUrl: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), `velox-scheduler-${randomUUID()}-`));
  const dbPaths = Object.fromEntries(names.map((name) => [name, join(dataDir, `${name}.db`) ])) as Record<typeof names[number], string>;
  const servers: Server[] = [];
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;
  try {
    const serverUrls: Partial<Record<typeof names[number], string>> = {};
    for (const name of names) {
      const { server } = start(name, { port: 0, dbPath: dbPaths[name] });
      servers.push(server);
      serverUrls[name] = `http://127.0.0.1:${await waitForPort(server)}/mcp`;
    }
    agent = await createAgentApp({ serverUrls, provider: new ScenarioProvider(), asOf });
    apiServer = createHttpServer(agent.app);
    apiServer.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${await waitForPort(apiServer)}`;
    return {
      agent,
      baseUrl,
      dbPath: dbPaths.local,
      async close() {
        const errors: unknown[] = [];
        const cleanup = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        };
        agent?.stop();
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
        if (errors.length) throw new AggregateError(errors, 'Scheduler test cleanup failed');
      },
    };
  } catch (error) {
    if (apiServer?.listening) await new Promise<void>((resolve) => apiServer?.close(() => resolve()));
    if (agent) await agent.close();
    for (const server of servers) {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function confirmedOutdoorTrip(env: Awaited<ReturnType<typeof fixture>>, sessionId: string): Promise<string> {
  const chat = await postJson(env.baseUrl, '/api/chat', { session_id: sessionId, text: 'S6 Weekend in Goa under 20k' });
  const chatEvents = eventsFrom(await chat.text());
  const itinerary = chatEvents.filter((event) => event.type === 'card')
    .map((event) => event.card as Record<string, unknown>)
    .find((card) => card.kind === 'itinerary' && card.status === 'proposed');
  if (typeof itinerary?.plan_id !== 'string') throw new Error(`S6 mock did not propose an itinerary: ${JSON.stringify(chatEvents)}`);
  const response = await postJson(env.baseUrl, '/api/confirm', { session_id: sessionId, plan_id: itinerary.plan_id });
  const events = eventsFrom(await response.text());
  if (!events.some((event) => event.type === 'card' && (event.card as Record<string, unknown>).status === 'confirmed')) {
    throw new Error('S6 trip was not confirmed');
  }
  return itinerary.plan_id;
}

test('S6 emits one trip-day nudge and accepting it confirms indoor then cancels outdoor', async () => {
  const env = await fixture();
  try {
    await confirmedOutdoorTrip(env, 's6');
    const clock = await postJson(env.baseUrl, '/api/clock', { preset: 'trip_day' });
    expect(clock.status).toBe(200);
    expect(await clock.json()).toEqual({ now: '2026-06-05T08:00:00.000Z' });
    await env.agent.tick();
    const later = await postJson(env.baseUrl, '/api/clock', { plus_hours: 24 });
    expect(later.status).toBe(200);
    await env.agent.tick();
    const eventResponse = await fetch(`${env.baseUrl}/api/events?session_id=s6`);
    const events = eventsFrom(await eventResponse.text());
    const nudges = events.filter((event) => event.type === 'nudge');
    expect(nudges).toHaveLength(1);
    const nudge = nudges[0]?.card as Record<string, unknown>;
    expect(nudge.text).toMatch(/Rain is forecast.*Replace .* with .*; the change .*INR/);
    expect(nudge.plan_id).toBeTypeOf('string');

    const accepted = await postJson(env.baseUrl, '/api/accept', { session_id: 's6', plan_id: nudge.plan_id });
    const acceptEvents = eventsFrom(await accepted.text());
    expect(acceptEvents.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'confirmed')).toBe(true);
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const activityHolds = db.prepare("SELECT offer_id, state FROM holds WHERE offer_id LIKE 'activity_%' OR offer_id LIKE 'food_%'")
        .all() as Array<{ offer_id: string; state: string }>;
      expect(activityHolds.some((hold) => hold.offer_id.startsWith('activity_') && hold.state === 'cancelled')).toBe(true);
      expect(activityHolds.some((hold) => hold.offer_id.startsWith('activity_') && hold.state === 'confirmed')).toBe(true);
    } finally {
      db.close();
    }
  } finally {
    await env.close();
  }
}, 30_000);

test('failed weather swap confirmation releases the replacement and keeps the original confirmed', async () => {
  const env = await fixture();
  try {
    await confirmedOutdoorTrip(env, 's6-fail');
    const clock = await postJson(env.baseUrl, '/api/clock', { preset: 'trip_day' });
    expect(clock.status).toBe(200);
    const eventsResponse = await fetch(`${env.baseUrl}/api/events?session_id=s6-fail`);
    const events = eventsFrom(await eventsResponse.text());
    const nudge = events.find((event) => event.type === 'nudge')?.card as Record<string, unknown> | undefined;
    expect(nudge?.plan_id).toBeTypeOf('string');
    const chaos = await postJson(env.baseUrl, '/api/chaos', { server: 'local' });
    expect(chaos.status).toBe(200);
    const accepted = await postJson(env.baseUrl, '/api/accept', { session_id: 's6-fail', plan_id: nudge?.plan_id });
    const acceptEvents = eventsFrom(await accepted.text());
    expect(acceptEvents.some((event) => event.type === 'recovery')).toBe(true);
    expect(acceptEvents.some((event) => event.type === 'error' && /rolled back/i.test(String(event.message)))).toBe(true);
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const states = db.prepare("SELECT offer_id, state FROM holds WHERE offer_id LIKE 'activity_%' OR offer_id LIKE 'food_%'")
        .all() as Array<{ offer_id: string; state: string }>;
      expect(states.some((hold) => hold.offer_id.startsWith('activity_') && hold.state === 'confirmed')).toBe(true);
      expect(states.some((hold) => hold.offer_id.startsWith('activity_') && hold.state === 'released')).toBe(true);
    } finally {
      db.close();
    }
  } finally {
    await env.close();
  }
}, 30_000);
