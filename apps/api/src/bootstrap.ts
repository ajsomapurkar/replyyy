/**
 * Production first-boot: if Relay's tables don't exist yet, create them and load the demo city.
 * If they already exist, do nothing — unlike `npm run reset`, this never drops data on restart.
 */
import { getPool, closePool } from './database/db.js';
import { migrate } from './database/migrate.js';
import { seedDatabase } from './seed/seed.js';

const db = getPool();
const { rows } = await db.query(`select to_regclass('public.users') as t`);
if (rows[0].t) {
  console.log('bootstrap: schema present — skipping migrate/seed');
} else {
  console.log('bootstrap: empty database — applying migrations and seeding demo city');
  await db.query('create extension if not exists postgis').catch((e) => console.warn('bootstrap: could not enable postgis automatically:', e.message));
  await migrate(undefined, { reset: false });
  const r = await seedDatabase(db);
  console.log(`bootstrap: seeded ${r.users} users / ${r.drivers} drivers`);
}
await closePool();
