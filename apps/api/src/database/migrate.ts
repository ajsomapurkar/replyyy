import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../infra/migrations');

const TABLES = [
  'audit_log', 'jobs', 'outbox_events', 'idempotency_records', 'fleet_snapshots', 'reposition_recommendations', 'zone_pricing_state',
  'zone_demand_buckets', 'dispatch_decisions', 'dispatch_offers', 'ride_events', 'pool_members', 'rides', 'pool_groups',
  'driver_locations', 'drivers', 'vehicles', 'zones', 'sessions', 'users', 'demo_places',
];

/**
 * Demo reset: drops ONLY Relay's own tables (never the whole public schema — on Supabase that would wipe the
 * platform's grants and other objects), then applies every migration in order.
 */
export async function migrate(url?: string, { reset = true } = {}) {
  const db = getPool(url);
  if (reset) {
    await db.query(`drop table if exists ${TABLES.join(', ')} cascade`);
    await db.query('drop function if exists ride_events_immutable() cascade');
  }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(dir, f), 'utf8'));
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate()
    .then(() => console.log('migrations applied'))
    .finally(() => closePool());
}
