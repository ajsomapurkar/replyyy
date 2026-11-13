import pg from 'pg';
import { config } from '../config.js';

pg.types.setTypeParser(1700, (v) => Number(v)); // numeric → number
pg.types.setTypeParser(20, (v) => Number(v)); // bigint → number (counts)

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;
/**
 * Supabase (and most hosted Postgres) requires TLS. Set DATABASE_SSL=true, or it is enabled automatically for
 * *.supabase.co / *.pooler.supabase.com hosts. sslmode is stripped from the URL so node-pg uses the explicit TLS config.
 */
export function poolConfig(url: string): pg.PoolConfig {
  const hosted = /supabase\.(co|com)/.test(url) || process.env.DATABASE_SSL === 'true';
  const cleaned = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return {
    connectionString: cleaned,
    max: Number(process.env.DATABASE_POOL_MAX ?? (hosted ? 10 : 20)),
    ssl: hosted ? { rejectUnauthorized: process.env.DATABASE_SSL_VERIFY === 'true' } : undefined,
  };
}
export function getPool(url = config.databaseUrl): pg.Pool {
  if (!pool) pool = new pg.Pool(poolConfig(url));
  return pool;
}
export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

/** Run fn inside a transaction. Retries on serialization/deadlock failures. */
export async function tx<T>(db: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e: any) {
      await client.query('rollback').catch(() => {});
      if (attempt < retries && (e?.code === '40001' || e?.code === '40P01')) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Point literal for PostGIS from lat/lng (parameterised). Use as ST_SetSRID(ST_MakePoint($lng,$lat),4326)::geography */
export const POINT = (lngIdx: number, latIdx: number) =>
  `ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography`;
