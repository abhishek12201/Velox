import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { createAgentApp } from '../../packages/agent/src/api.js';
import { ScenarioProvider } from '../../packages/agent/src/llm/mock.js';
import { start } from '../../packages/servers/src/main.js';

const asOf = '2026-06-01T00:00:00.000Z';
const names = ['air', 'stay', 'local', 'vault'] as const;
const cleanupActions: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupActions.splice(0).reverse()) await cleanup();
});

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

async function openEventStream(baseUrl: string, sessionId: string) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events?session_id=${encodeURIComponent(sessionId)}`, {
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`Could not open event stream: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  const waiters = new Set<{
    predicate: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let buffer = '';
  let closed = false;
  const dispatch = (frame: string) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return;
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSE event');
    const event = value as Record<string, unknown>;
    events.push(event);
    for (const waiter of waiters) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  };
  const reading = (async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        dispatch(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
    }
  })().catch((error: unknown) => {
    if (closed) return;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
    waiters.clear();
  });
  const stream = {
    events,
    waitFor(predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 5_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error('Timed out waiting for an SSE event'));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('SSE stream closed'));
      }
      waiters.clear();
      await reader.cancel().catch(() => undefined);
      await reading;
    },
  };
  cleanupActions.push(stream.close);
  return stream;
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), `velox-scheduler-${randomUUID()}-`));
  const dbPaths = Object.fromEntries(names.map((name) => [name, join(dataDir, `${name}.db`) ])) as Record<typeof names[number], string>;
  const servers: Server[] = [];
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;
  let closed = false;
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
    const env = {
      agent,
      baseUrl,
      dbPath: dbPaths.local,
      async close() {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        const cleanup = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        };
        agent?.stop();
        if (agent) await cleanup(() => agent?.close() ?? Promise.resolve());
        if (apiServer?.listening) {
          await cleanup(() => new Promise<void>((resolve, reject) => {
            apiServer?.close((error) => error ? reject(error) : resolve());
          }));
        }
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
    cleanupActions.push(env.close);
    return env;
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

async function confirmedOutdoorTrip(
  env: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  text = 'S6 Weekend in Goa under 20k',
): Promise<string> {
  const chat = await postJson(env.baseUrl, '/api/chat', { session_id: sessionId, text });
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
    const stream = await openEventStream(env.baseUrl, 's6');
    await stream.waitFor((event) => event.type === 'nudge');
    const events = stream.events;
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
    const stream = await openEventStream(env.baseUrl, 's6-fail');
    await stream.waitFor((event) => event.type === 'nudge');
    const events = stream.events;
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

test('live events stream delivers one nudge for the standard outdoor demo plan', async () => {
  const env = await fixture();
  const stream = await openEventStream(env.baseUrl, 's6-live');
  await confirmedOutdoorTrip(env, 's6-live', 'Weekend in Goa under 20k');

  const tripDay = await postJson(env.baseUrl, '/api/clock', { preset: 'trip_day' });
  expect(tripDay.status).toBe(200);
  const nudge = await stream.waitFor((event) => event.type === 'nudge', 5_000);
  expect(nudge.type).toBe('nudge');
  const later = await postJson(env.baseUrl, '/api/clock', { plus_hours: 2 });
  expect(later.status).toBe(200);
  await stream.waitFor((event) => event.type === 'clock' && event.now === '2026-06-05T10:00:00.000Z');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stream.events.filter((event) => event.type === 'nudge')).toHaveLength(1);
}, 30_000);

test('clock rejects missing trips and past timestamps without moving time', async () => {
  const env = await fixture();
  const before = await fetch(`${env.baseUrl}/api/clock`).then((response) => response.json()) as { now: string };
  const missingTrip = await postJson(env.baseUrl, '/api/clock', { preset: 'trip_day' });
  expect(missingTrip.status).toBe(409);
  const afterMissingTrip = await fetch(`${env.baseUrl}/api/clock`).then((response) => response.json()) as { now: string };
  expect(afterMissingTrip.now).toBe(before.now);

  const past = await postJson(env.baseUrl, '/api/clock', { to: '2026-05-31T23:00:00.000Z' });
  expect(past.status).toBe(400);
  const afterPast = await fetch(`${env.baseUrl}/api/clock`).then((response) => response.json()) as { now: string };
  expect(afterPast.now).toBe(before.now);

  const allowedPast = await postJson(env.baseUrl, '/api/clock', {
    to: '2026-05-31T23:00:00.000Z',
    allow_past: true,
  });
  expect(allowedPast.status).toBe(200);
  expect(await allowedPast.json()).toEqual({ now: '2026-05-31T23:00:00.000Z' });
}, 30_000);
