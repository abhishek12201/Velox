import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const dataDir = resolve(process.env.VELOX_DATA_DIR ?? join(process.cwd(), 'data'));
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'vault.db'));
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

try {
  const now = new Date();
  const daysSinceFriday = (now.getUTCDay() - 5 + 7) % 7 || 7;
  const startDate = new Date(now.getTime() - (daysSinceFriday + 14) * 86400000);
  const endDate = new Date(startDate.getTime() + 2 * 86400000);
  const date = (value: Date) => value.toISOString().slice(0, 10);
  const start = date(startDate);
  const end = date(endDate);
  const created = now.toISOString();
  const profile = [
    { key: 'home_airport', value: 'BLR', source: 'stated', evidence: 'Synthetic demo preference: Bengaluru is the home airport.' },
    { key: 'avoid_departure_before', value: '07:00', source: 'stated', evidence: 'Synthetic demo preference: avoid flights departing before 07:00.' },
  ] as const;
  const plan = {
    synthetic: true,
    party: 1,
    start,
    end,
    total: 12_500,
    destination: 'Goa',
    title: 'Synthetic Goa weekend',
  };
  const insertProfile = db.prepare(`INSERT INTO profile (key, value, source, evidence, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, evidence = excluded.evidence, updated = excluded.updated`);
  const save = db.transaction(() => {
    for (const entry of profile) {
      insertProfile.run(entry.key, entry.value, entry.source, entry.evidence, created);
    }
    db.prepare(`INSERT OR REPLACE INTO trips (id, title, party, start, end, total, plan_json, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('synthetic_goa_demo_trip', 'Synthetic Goa weekend', 1, start, end, plan.total, JSON.stringify(plan), created);
  });
  save();
  console.log(`Seeded synthetic Goa trip and ${profile.length} synthetic profile entries in ${join(dataDir, 'vault.db')}`);
} finally {
  db.close();
}
