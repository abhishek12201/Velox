import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeError } from '../kit/errors.js';

interface ProfileRecord {
  key: string;
  value: string;
  source: 'stated' | 'inferred';
  evidence: string;
  updated: string;
}

interface TripRecord {
  id: string;
  title: string;
  party: number;
  start: string;
  end: string;
  total: number;
  plan_json: string;
  created: string;
}

function readTripSummary(planJson: string): { party: number; start: string; end: string; total: number } | null {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch {
    return null;
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const fields = plan as Record<string, unknown>;
  const party = fields.party;
  const start = fields.start;
  const end = fields.end;
  const total = fields.total;
  if (!Number.isInteger(party) || (party as number) < 1) return null;
  if (typeof start !== 'string' || !start || typeof end !== 'string' || !end) return null;
  if (!Number.isSafeInteger(total) || (total as number) < 0) return null;
  return { party: party as number, start, end, total: total as number };
}

export function createVaultServer(options: { dbPath?: string; basePort?: number } = {}) {
  const basePort = options.basePort ?? Number(process.env.VAULT_PORT ?? process.env.PORT ?? 0);
  const dbPath = options.dbPath ?? join(process.env.VELOX_DATA_DIR ?? join(process.cwd(), 'data'), 'vault.db');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('stated', 'inferred')),
      evidence TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      party INTEGER NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      total INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      created TEXT NOT NULL
    );
  `);
  const server = new McpServer({ name: 'vault', version: '1.0.0' }, { capabilities: {} });

  server.registerTool('get_profile', {
    description: 'Retrieve saved stated and inferred travel preferences from the profile.',
    inputSchema: { as_of: z.string().optional() },
    outputSchema: z.object({ profile: z.array(z.object({
      key: z.string(), value: z.string(), source: z.enum(['stated', 'inferred']), evidence: z.string(), updated: z.string(),
    })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async (): Promise<any> => {
    const profile = db.prepare('SELECT key, value, source, evidence, updated FROM profile ORDER BY key').all() as ProfileRecord[];
    return { content: [{ type: 'text', text: JSON.stringify({ profile }) }], structuredContent: { profile } };
  });

  server.registerTool('remember', {
    description: 'Save or update a travel preference with its source and supporting evidence.',
    inputSchema: {
      key: z.string().min(1).max(100),
      value: z.string().min(1).max(1000),
      source: z.enum(['stated', 'inferred']),
      evidence: z.string().min(1).max(2000),
      as_of: z.string().optional(),
    },
    outputSchema: z.object({
      key: z.string(), value: z.string(), source: z.enum(['stated', 'inferred']), evidence: z.string(), updated: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ key, value, source, evidence }: any): Promise<any> => {
    const updated = new Date().toISOString();
    db.prepare(`INSERT INTO profile (key, value, source, evidence, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, evidence = excluded.evidence, updated = excluded.updated`)
      .run(key, value, source, evidence, updated);
    const result = { key, value, source, evidence, updated };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('list_trips', {
    description: 'List saved trips in newest-first order for recalling prior itineraries.',
    inputSchema: { limit: z.number().int().gte(1).lte(50).default(5), as_of: z.string().optional() },
    outputSchema: z.object({ trips: z.array(z.object({
      id: z.string(), title: z.string(), party: z.number().int(), start: z.string(), end: z.string(),
      total: z.number().int(), plan_json: z.string(), created: z.string(),
    })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: { 'velox/audience': 'llm' },
  }, async ({ limit = 5 }: any): Promise<any> => {
    const trips = db.prepare('SELECT id, title, party, start, end, total, plan_json, created FROM trips ORDER BY created DESC, id DESC LIMIT ?').all(limit) as TripRecord[];
    return { content: [{ type: 'text', text: JSON.stringify({ trips }) }], structuredContent: { trips } };
  });

  server.registerTool('save_trip', {
    description: 'Save a confirmed trip plan to the persistent travel history.',
    inputSchema: { plan_json: z.string().min(1), title: z.string().min(1).max(200), as_of: z.string().optional() },
    outputSchema: z.object({
      id: z.string(), title: z.string(), party: z.number().int(), start: z.string(), end: z.string(),
      total: z.number().int(), plan_json: z.string(), created: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: { 'velox/audience': 'app' },
  }, async ({ plan_json, title }: any): Promise<any> => {
    const summary = readTripSummary(plan_json);
    if (!summary) return makeError('INVALID', 'Trip plan JSON must include positive integer party, start and end dates, and non-negative integer total', false);
    const result = {
      id: `trip_${crypto.randomUUID().replace(/-/g, '')}`,
      title,
      ...summary,
      plan_json,
      created: new Date().toISOString(),
    };
    db.prepare('INSERT INTO trips (id, title, party, start, end, total, plan_json, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(result.id, result.title, result.party, result.start, result.end, result.total, result.plan_json, result.created);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  let closePromise: Promise<void> | undefined;
  return {
    server,
    port: basePort,
    connect: (transport: any) => server.connect(transport),
    close: () => closePromise ??= server.close().then(() => { db.close(); }),
  };
}
