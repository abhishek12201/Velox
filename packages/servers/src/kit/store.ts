import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type HoldState = 'held' | 'confirmed' | 'released' | 'expired' | 'cancelled';

export interface HoldRecord {
  hold_id: string;
  server: string;
  offer_id: string;
  amount: number;
  qty: number;
  expires_at: string;
  state: HoldState;
}

export interface ChaosState {
  active: boolean;
  code: string;
  once: boolean;
}

export class HoldStore {
  private readonly db: Database.Database;
  private readonly ttlSeconds: number;
  private chaos: ChaosState = { active: false, code: 'SOLD_OUT', once: true };

  constructor(serverName: string, dbPath = join(process.env.VELOX_DATA_DIR ?? join(process.cwd(), 'data', `${serverName}-${randomUUID().slice(0, 8)}`), `${serverName}.db`)) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.ttlSeconds = Number(process.env.VELOX_HOLD_TTL_SEC ?? 600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        hold_id TEXT PRIMARY KEY,
        server TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private expireHeldRows(): void {
    const rows = this.db.prepare(`SELECT hold_id, expires_at FROM holds WHERE state = 'held'`).all() as Array<{ hold_id: string; expires_at: string }>;
    const now = Date.now();
    const expired = rows.filter((row) => new Date(row.expires_at).getTime() <= now).map((row) => row.hold_id);
    if (expired.length === 0) return;
    const stmt = this.db.prepare(`UPDATE holds SET state = 'expired' WHERE hold_id = ?`);
    for (const holdId of expired) {
      stmt.run(holdId);
    }
  }

  getChaos(): ChaosState {
    return { ...this.chaos };
  }

  setChaos(code: string, once = true): ChaosState {
    this.chaos = { active: true, code, once };
    return { ...this.chaos };
  }

  consumeChaos(): string | null {
    if (!this.chaos.active) return null;
    const code = this.chaos.code;
    if (this.chaos.once) {
      this.chaos = { active: false, code, once: true };
    }
    return code;
  }

  readHold(holdId: string): HoldRecord | null {
    this.expireHeldRows();
    const row = this.db.prepare(`SELECT * FROM holds WHERE hold_id = ?`).get(holdId) as HoldRecord | undefined;
    return row ?? null;
  }

  upsertIdempotent(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO idempotency (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`).run(key, JSON.stringify(value), this.nowIso());
  }

  getIdempotent<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM idempotency WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  countHolds(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM holds`).get() as { count: number };
    return row.count;
  }

  createHold(holdId: string, server: string, offerId: string, amount: number, qty: number): HoldRecord {
    this.expireHeldRows();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    const record: HoldRecord = {
      hold_id: holdId,
      server,
      offer_id: offerId,
      amount,
      qty,
      expires_at: expiresAt,
      state: 'held',
    };
    this.db.prepare(`INSERT INTO holds (hold_id, server, offer_id, amount, qty, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.hold_id, record.server, record.offer_id, record.amount, record.qty, record.expires_at, record.state);
    return record;
  }

  setHoldState(holdId: string, state: HoldState): HoldRecord | null {
    const current = this.readHold(holdId);
    if (!current) return null;
    this.db.prepare(`UPDATE holds SET state = ? WHERE hold_id = ?`).run(state, holdId);
    return { ...current, state };
  }

  releaseHold(holdId: string): HoldRecord | null {
    const current = this.readHold(holdId);
    if (!current) return null;
    if (current.state === 'released') return current;
    if (current.state === 'cancelled' || current.state === 'expired') return { ...current, state: current.state };
    this.db.prepare(`UPDATE holds SET state = 'released' WHERE hold_id = ?`).run(holdId);
    return { ...current, state: 'released' };
  }

  confirmHold(holdId: string): HoldRecord | null {
    const current = this.readHold(holdId);
    if (!current) return null;
    if (current.state !== 'held') return current;
    this.db.prepare(`UPDATE holds SET state = 'confirmed' WHERE hold_id = ?`).run(holdId);
    return { ...current, state: 'confirmed' };
  }

  cancelHold(holdId: string): HoldRecord | null {
    const current = this.readHold(holdId);
    if (!current) return null;
    if (current.state === 'cancelled') return current;
    this.db.prepare(`UPDATE holds SET state = 'cancelled' WHERE hold_id = ?`).run(holdId);
    return { ...current, state: 'cancelled' };
  }
}
