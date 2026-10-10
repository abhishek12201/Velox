import express, { type Request, type Response } from 'express';
import type { LlmProvider } from './llm/types.js';
import { BedrockProvider } from './llm/bedrock.js';
import { ScenarioProvider } from './llm/mock.js';
import { createRegistry, type ServerName } from './mcp/registry.js';
import { runLoop, type AgentSession, type LoopEvent } from './loop.js';
import { confirmPlan } from './saga.js';
import { TripScheduler } from './scheduler.js';

const allowedOrigin = 'http://localhost:5173';

export interface AgentAppOptions {
  serverUrls?: Partial<Record<ServerName, string>>;
  provider?: LlmProvider;
  asOf?: string;
}

function writeSse(res: Response, event: LoopEvent | { type: 'done' }): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function newSession(id: string, asOf: string): AgentSession {
  return {
    id,
    asOf,
    messages: [],
    ledger: {
      offers: new Map(),
      holds: new Map(),
      plans: new Map(),
      cards: new Map(),
      swaps: new Map(),
    },
  };
}

export async function createAgentApp(options: AgentAppOptions = {}): Promise<{
  app: express.Express;
  tick: () => Promise<Map<string, LoopEvent[]>>;
  startScheduler: () => void;
  stop: () => void;
  close: () => Promise<void>;
}> {
  const llm = process.env.VELOX_LLM ?? 'mock';
  const provider = options.provider ?? (llm === 'bedrock'
    ? new BedrockProvider()
    : llm === 'mock'
      ? new ScenarioProvider()
      : undefined);
  if (!provider) throw new Error(`Unsupported VELOX_LLM value: ${llm}`);
  let registry;
  try {
    registry = await createRegistry(options.serverUrls);
  } catch (error) {
    if (provider instanceof BedrockProvider) provider.close();
    throw error;
  }
  const sessions = new Map<string, AgentSession>();
  const defaultAsOf = options.asOf ?? new Date().toISOString();
  const scheduler = new TripScheduler(() => [...sessions.values()], registry, provider, defaultAsOf);
  const pendingEvents = new Map<string, LoopEvent[]>();
  const publish = (sessionId: string, events: LoopEvent[]) => {
    pendingEvents.set(sessionId, [...(pendingEvents.get(sessionId) ?? []), ...events]);
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next) => {
    const origin = req.get('origin');
    if (origin && origin !== allowedOrigin) {
      res.status(403).json({ error: 'Forbidden: unsupported origin' });
      return;
    }
    if (origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin === allowedOrigin ? 204 : 403);
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get('/api/clock', (_req, res) => {
    res.status(200).json({ now: scheduler.now() });
  });

  app.post('/api/clock', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { to?: unknown; plus_hours?: unknown; preset?: unknown }
      : {};
    try {
      let target: string;
      if (body.preset === 'trip_day' && body.to === undefined && body.plus_hours === undefined) {
        const response = await registry.invoke('vault__list_trips', { limit: 50 }, scheduler.now());
        const trips = response.trips;
        if (!Array.isArray(trips) || !trips.length || !trips[0] || typeof trips[0] !== 'object') {
          res.status(409).json({ error: 'No confirmed trip is available for the trip_day preset' });
          return;
        }
        const start = (trips[0] as Record<string, unknown>).start;
        if (typeof start !== 'string' || !Number.isFinite(Date.parse(`${start}T00:00:00Z`))) {
          throw new Error('Vault returned an invalid trip start date');
        }
        const tripDate = new Date(`${start}T00:00:00Z`);
        const daysSinceFriday = (tripDate.getUTCDay() - 5 + 7) % 7;
        tripDate.setUTCDate(tripDate.getUTCDate() - daysSinceFriday);
        target = `${tripDate.toISOString().slice(0, 10)}T08:00:00.000Z`;
      } else if (body.to !== undefined && body.plus_hours === undefined && body.preset === undefined && typeof body.to === 'string') {
        target = body.to;
      } else if (body.plus_hours !== undefined && body.to === undefined && body.preset === undefined &&
        typeof body.plus_hours === 'number' && Number.isFinite(body.plus_hours)) {
        target = new Date(Date.parse(scheduler.now()) + body.plus_hours * 3_600_000).toISOString();
      } else {
        res.status(400).json({ error: 'Provide exactly one of to, plus_hours, or preset: trip_day' });
        return;
      }
      scheduler.setNow(target);
      for (const session of sessions.values()) publish(session.id, [{ type: 'clock', now: scheduler.now() }]);
      const scheduled = await scheduler.tick();
      for (const [sessionId, events] of scheduled) publish(sessionId, events);
      res.status(200).json({ now: scheduler.now() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not set the virtual clock' });
    }
  });

  app.get('/api/events', (req, res) => {
    const sessionId = req.query.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    const events = pendingEvents.get(sessionId) ?? [];
    for (const event of events) writeSse(res, event);
    pendingEvents.delete(sessionId);
    writeSse(res, { type: 'done' });
    res.end();
  });

  app.post('/api/reset', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { scope?: unknown; session_id?: unknown }
      : {};
    if (body.scope === 'all') {
      try {
        const reset = await registry.invokeApp('vault__reset', {}, defaultAsOf);
        if (reset.isError === true) throw new Error('Vault rejected the reset request');
        sessions.clear();
        res.status(200).json({ ok: true, reset: 'all' });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : 'Could not clear vault data' });
      }
      return;
    }
    if (body.scope === 'session' && typeof body.session_id === 'string' && body.session_id) {
      sessions.delete(body.session_id);
      res.status(200).json({ ok: true, reset: 'session' });
      return;
    }
    res.status(400).json({ error: 'scope must be all or session with a session_id' });
  });

  app.post('/api/chaos', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { server?: unknown }
      : {};
    const server = body.server;
    if (server !== null && server !== undefined && !['air', 'stay', 'local', 'vault'].includes(String(server))) {
      res.status(400).json({ error: 'server must be air, stay, local, vault, or null' });
      return;
    }
    try {
      await registry.setChaos(server as ServerName | null);
      res.status(200).json({ ok: true, server: server ?? null, active: true });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Could not configure chaos' });
    }
  });

  app.post('/api/confirm', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { session_id?: unknown; plan_id?: unknown }
      : {};
    if (typeof body.session_id !== 'string' || typeof body.plan_id !== 'string') {
      res.status(400).json({ error: 'session_id and plan_id are required' });
      return;
    }
    const session = sessions.get(body.session_id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      for (const event of await confirmPlan(session, body.plan_id, provider, registry)) writeSse(res, event);
    } catch (error) {
      writeSse(res, { type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    writeSse(res, { type: 'done' });
    res.end();
  });

  app.post('/api/accept', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { session_id?: unknown; plan_id?: unknown }
      : {};
    if (typeof body.session_id !== 'string' || typeof body.plan_id !== 'string') {
      res.status(400).json({ error: 'session_id and plan_id are required' });
      return;
    }
    const session = sessions.get(body.session_id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      for (const event of await confirmPlan(session, body.plan_id, provider, registry)) writeSse(res, event);
    } catch (error) {
      writeSse(res, { type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    writeSse(res, { type: 'done' });
    res.end();
  });

  app.post('/api/chat', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { session_id?: unknown; text?: unknown }
      : {};
    if (typeof body.session_id !== 'string' || !body.session_id.trim() || typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'session_id and text are required' });
      return;
    }
    const session = sessions.get(body.session_id) ?? newSession(body.session_id, options.asOf ?? defaultAsOf);
    sessions.set(session.id, session);
    session.messages.push({ role: 'user', content: body.text });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      const events = await runLoop(session, provider, registry);
      for (const event of events) writeSse(res, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeSse(res, { type: 'error', message });
    }
    writeSse(res, { type: 'done' });
    res.end();
  });

  return {
    app,
    tick: scheduler.tick.bind(scheduler),
    startScheduler: () => scheduler.start(publish),
    stop: () => scheduler.stop(),
    async close() {
      scheduler.stop();
      pendingEvents.clear();
      sessions.clear();
      try {
        await registry.close();
      } finally {
        if (provider instanceof BedrockProvider) provider.close();
      }
    },
  };
}
