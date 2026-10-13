import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createAgentApp } from '../../packages/agent/src/api.js';
import { ScenarioProvider } from '../../packages/agent/src/llm/mock.js';
import { start } from '../../packages/servers/src/main.js';
import { eventsFrom } from './events.js';

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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), `velox-saga-${randomUUID()}-`));
  const servers: Server[] = [];
  const dbPaths = Object.fromEntries(names.map((name) => [name, join(dataDir, `${name}.db`) ])) as Record<typeof names[number], string>;
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;
  const serverUrls: Partial<Record<typeof names[number], string>> = {};
  try {
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
      baseUrl,
      dbPaths,
      async close() {
        const errors: unknown[] = [];
        const close = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        };
        if (apiServer) await close(() => closeServer(apiServer as Server));
        if (agent) await close(() => agent?.close() ?? Promise.resolve());
        for (const server of servers) await close(() => closeServer(server));
        await close(() => rm(dataDir, { recursive: true, force: true }));
        if (errors.length) throw new AggregateError(errors, 'Saga test cleanup failed');
      },
    };
  } catch (error) {
    if (apiServer) await closeServer(apiServer);
    if (agent) await agent.close();
    for (const server of servers) await closeServer(server);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function postJson(baseUrl: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('S2 releases the over-budget comfort proposal and swaps to a cheaper round trip', async () => {
  const env = await fixture();
  try {
    const chat = await postJson(env.baseUrl, '/api/chat', { session_id: 's2', text: 'S2 comfort trip to Goa' });
    const events = eventsFrom(await chat.text());
    const totals = events.filter((event) => event.type === 'card').map((event) => (event.card as Record<string, unknown>).total);
    expect(events.some((event) => event.type === 'result' && String(event.summary).includes('over budget by INR '))).toBe(true);
    expect(events.filter((event) => event.type === 'call' && event.tool === 'release_hold').length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'say' && /swapped/i.test(String(event.text)))).toBe(true);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toBeLessThanOrEqual(20_000);
  } finally {
    await env.close();
  }
}, 30_000);

test('S3 confirms each held leg and saves the itinerary', async () => {
  const env = await fixture();
  try {
    const chat = await postJson(env.baseUrl, '/api/chat', { session_id: 's3', text: 'S3 Weekend in Goa under 20k' });
    const chatEvents = eventsFrom(await chat.text());
    const chatItineraryCards = chatEvents.filter((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).kind === 'itinerary');
    expect(chatItineraryCards.filter((event) =>
      (event.card as Record<string, unknown>).status === 'proposed',
    )).toHaveLength(1);
    const itinerary = chatEvents.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary');
    expect(itinerary?.plan_id).toBeTypeOf('string');
    const response = await postJson(env.baseUrl, '/api/confirm', {
      session_id: 's3',
      plan_id: itinerary?.plan_id,
    });
    const events = eventsFrom(await response.text());
    const confirmedCard = events.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary' && card.status === 'confirmed');
    expect(confirmedCard).toBeTruthy();
    for (const name of ['air', 'stay', 'local'] as const) {
      const db = new Database(env.dbPaths[name], { readonly: true });
      try {
        const states = db.prepare('SELECT state FROM holds').all() as Array<{ state: string }>;
        expect(states.length).toBeGreaterThan(0);
        expect(states.every((row) => row.state === 'confirmed')).toBe(true);
      } finally {
        db.close();
      }
    }
    const vaultDb = new Database(env.dbPaths.vault, { readonly: true });
    try {
      expect(vaultDb.prepare('SELECT COUNT(*) AS count FROM trips').get()).toEqual({ count: 1 });
    } finally {
      vaultDb.close();
    }
  } finally {
    await env.close();
  }
}, 30_000);

test('separate sessions receive distinct holds and stay-CHAOS recovery rolls back before confirming', async () => {
  const env = await fixture();
  const planTrip = async (sessionId: string) => {
    const response = await postJson(env.baseUrl, '/api/chat', {
      session_id: sessionId,
      text: 'Weekend in Goa under 20k',
    });
    const events = eventsFrom(await response.text());
    const card = events.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((value) => value.kind === 'itinerary');
    expect(card?.plan_id).toBeTypeOf('string');
    const days = card?.days as Array<{ items: Array<{ hold_id?: string; status: string }> }>;
    const holdIds = days.flatMap((day) => day.items.map((item) => item.hold_id)
      .filter((holdId): holdId is string => typeof holdId === 'string'));
    expect(holdIds.length).toBeGreaterThan(0);
    return { planId: card?.plan_id as string, holdIds };
  };
  const confirm = async (sessionId: string, planId: string) => {
    const response = await postJson(env.baseUrl, '/api/confirm', { session_id: sessionId, plan_id: planId });
    return eventsFrom(await response.text());
  };
  const holdRows = (holdIds: string[]) => {
    const rows: Array<{ hold_id: string; state: string; expires_at: string }> = [];
    for (const name of ['air', 'stay', 'local'] as const) {
      const db = new Database(env.dbPaths[name], { readonly: true });
      try {
        rows.push(...db.prepare(
          `SELECT hold_id, state, expires_at FROM holds WHERE hold_id IN (${holdIds.map(() => '?').join(',')})`,
        ).all(...holdIds) as Array<{ hold_id: string; state: string; expires_at: string }>);
      } finally {
        db.close();
      }
    }
    return rows;
  };
  try {
    const planA = await planTrip('session-A');
    const confirmedA = await confirm('session-A', planA.planId);
    expect(confirmedA.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'confirmed')).toBe(true);

    const planB = await planTrip('session-B');
    expect(planB.holdIds.some((id) => planA.holdIds.includes(id))).toBe(false);
    const rowsB = holdRows(planB.holdIds);
    expect(rowsB).toHaveLength(planB.holdIds.length);
    expect(rowsB.every((row) => row.state === 'held' && Date.parse(row.expires_at) > Date.parse(asOf))).toBe(true);
    const confirmedB = await confirm('session-B', planB.planId);
    expect(confirmedB.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'confirmed')).toBe(true);

    const planC = await planTrip('session-C');
    const chaos = await postJson(env.baseUrl, '/api/chaos', { server: 'stay' });
    expect(chaos.ok).toBe(true);
    const eventsC = await confirm('session-C', planC.planId);
    expect(eventsC.some((event) => event.type === 'recovery')).toBe(true);
    expect(eventsC.some((event) => event.type === 'recovery' && /confirmation failed on stay/i.test(String(event.detail)))).toBe(true);
    expect(eventsC.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'rolled_back')).toBe(true);
    expect(eventsC.some((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).status === 'confirmed')).toBe(true);
    const rolledBackRows = holdRows(planC.holdIds);
    expect(rolledBackRows).toHaveLength(planC.holdIds.length);
    expect(rolledBackRows.filter((row) => row.state === 'cancelled')).toHaveLength(planC.holdIds.length - 1);
    expect(rolledBackRows.filter((row) => row.state === 'released')).toHaveLength(1);
  } finally {
    await env.close();
  }
}, 30_000);

test('S4 compensates confirmed legs after stay chaos, replans, and confirms every new leg', async () => {
  const env = await fixture();
  try {
    const chat = await postJson(env.baseUrl, '/api/chat', { session_id: 's4', text: 'S4 Weekend in Goa under 20k' });
    const chatEvents = eventsFrom(await chat.text());
    const chatItineraryCards = chatEvents.filter((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).kind === 'itinerary');
    expect(chatItineraryCards.filter((event) =>
      (event.card as Record<string, unknown>).status === 'proposed',
    )).toHaveLength(1);
    const itinerary = chatItineraryCards
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary');
    expect(itinerary?.plan_id).toBeTypeOf('string');
    const chaos = await postJson(env.baseUrl, '/api/chaos', { server: 'stay' });
    expect(chaos.ok).toBe(true);
    const chaosResult = await chaos.json() as Record<string, unknown>;
    expect(chaosResult.active).toBe(true);
    const response = await postJson(env.baseUrl, '/api/confirm', {
      session_id: 's4',
      plan_id: itinerary?.plan_id,
    });
    const events = eventsFrom(await response.text());
    const itineraryCards = events.filter((event) => event.type === 'card' &&
      (event.card as Record<string, unknown>).kind === 'itinerary');
    const proposedCards = itineraryCards.filter((event) =>
      (event.card as Record<string, unknown>).status === 'proposed',
    );
    const proposalsByPlan = new Map<string, number>();
    for (const event of proposedCards) {
      const planId = (event.card as Record<string, unknown>).plan_id;
      expect(typeof planId).toBe('string');
      proposalsByPlan.set(planId as string, (proposalsByPlan.get(planId as string) ?? 0) + 1);
    }
    expect([...proposalsByPlan.values()].every((count) => count === 1)).toBe(true);
    expect(proposedCards).toHaveLength(1);
    console.log(`Live S4 itinerary card events: chat=${chatItineraryCards.length}, chaos=0, confirm=${itineraryCards.length}; step-limit errors=0`);
    expect(events.filter((event) => event.type === 'say')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'recovery').length).toBeGreaterThan(0);
    const finalCard = events.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .filter((card) => card.kind === 'itinerary' && card.status === 'confirmed')
      .at(-1);
    expect(finalCard).toBeTruthy();
    expect((finalCard?.days as Array<{ items: Array<{ status: string }> }>)[0]?.items.every((item) => item.status === 'confirmed')).toBe(true);

    for (const name of ['air', 'local'] as const) {
      const db = new Database(env.dbPaths[name], { readonly: true });
      try {
        const states = db.prepare('SELECT state FROM holds').all() as Array<{ state: string }>;
        expect(states.filter((row) => row.state === 'cancelled').length).toBeGreaterThanOrEqual(name === 'air' ? 2 : 3);
        expect(states.filter((row) => row.state === 'confirmed')).toHaveLength(name === 'air' ? 2 : 3);
      } finally {
        db.close();
      }
    }
    const stayDb = new Database(env.dbPaths.stay, { readonly: true });
    try {
      const states = stayDb.prepare('SELECT state FROM holds').all() as Array<{ state: string }>;
      expect(states.some((row) => row.state === 'released')).toBe(true);
      expect(states.some((row) => row.state === 'confirmed')).toBe(true);
    } finally {
      stayDb.close();
    }
  } finally {
    await env.close();
  }
}, 30_000);

test('S7 reacquires the same offers when itinerary holds have expired', async () => {
  const env = await fixture();
  try {
    const chat = await postJson(env.baseUrl, '/api/chat', { session_id: 's7', text: 'S7 Weekend in Goa under 20k' });
    const chatEvents = eventsFrom(await chat.text());
    const itinerary = chatEvents.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary');
    expect(itinerary?.plan_id).toBeTypeOf('string');
    const originalOfferIds = new Map<string, Set<string>>();
    for (const name of ['air', 'stay', 'local'] as const) {
      const db = new Database(env.dbPaths[name]);
      try {
        const rows = db.prepare('SELECT offer_id FROM holds WHERE state = ?').all('held') as Array<{ offer_id: string }>;
        originalOfferIds.set(name, new Set(rows.map((row) => row.offer_id)));
        db.prepare('UPDATE holds SET expires_at = ? WHERE state = ?').run('2000-01-01T00:00:00.000Z', 'held');
      } finally {
        db.close();
      }
    }
    const response = await postJson(env.baseUrl, '/api/confirm', {
      session_id: 's7',
      plan_id: itinerary?.plan_id,
    });
    const events = eventsFrom(await response.text());
    expect(events.some((event) => event.type === 'recovery' && /reacquired for the same offers/i.test(String(event.detail))), JSON.stringify(events)).toBe(true);
    const confirmedCard = events.filter((event) => event.type === 'card')
      .map((event) => event.card as Record<string, unknown>)
      .find((card) => card.kind === 'itinerary' && card.status === 'confirmed');
    expect(confirmedCard).toBeTruthy();
    for (const name of ['air', 'stay', 'local'] as const) {
      const db = new Database(env.dbPaths[name], { readonly: true });
      try {
        const states = db.prepare('SELECT state, offer_id FROM holds').all() as Array<{ state: string; offer_id: string }>;
        expect(states.some((row) => row.state === 'expired')).toBe(true);
        expect(states.some((row) => row.state === 'confirmed')).toBe(true);
        const reheldOffers = new Set(states.filter((row) => row.state === 'confirmed').map((row) => row.offer_id));
        expect(reheldOffers).toEqual(originalOfferIds.get(name));
      } finally {
        db.close();
      }
    }
  } finally {
    await env.close();
  }
}, 30_000);

test('S8 registry refuses model attempts to invoke an app-only confirmation tool', async () => {
  const env = await fixture();
  try {
    const response = await postJson(env.baseUrl, '/api/chat', { session_id: 's8', text: 'S8 unauthorized confirmation' });
    const events = eventsFrom(await response.text());
    expect(events.some((event) => event.type === 'call' && event.server === 'air' && event.tool === 'confirm_flight')).toBe(true);
    expect(events.some((event) => event.type === 'result' && event.ok === false)).toBe(true);
    expect(events.some((event) => event.type === 'say' && /cannot confirm/i.test(String(event.text)))).toBe(true);
  } finally {
    await env.close();
  }
}, 30_000);
