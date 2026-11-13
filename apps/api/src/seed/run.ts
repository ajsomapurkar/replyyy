import { getPool, closePool } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { seedDatabase } from './seed.js';

const db = getPool();
const t0 = Date.now();
await migrate();
const r = await seedDatabase(db);
console.log(`seeded ${r.users} users / ${r.drivers} drivers in ${Date.now() - t0} ms`);
await closePool();
