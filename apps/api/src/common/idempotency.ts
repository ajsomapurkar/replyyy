import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { tx } from '../database/db.js';
import { AppError } from './errors.js';

/**
 * Executes fn at most once per (user, scope, key). The record and fn's writes commit in the
 * same transaction, so a retry after a crash either replays the stored response or re-runs cleanly.
 */
export async function withIdempotency<T>(
  db: Pool,
  userId: string,
  scope: string,
  key: string,
  request: unknown,
  fn: (c: PoolClient) => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–100 safe characters');
  const hash = createHash('sha256').update(JSON.stringify(request ?? {})).digest('hex');
  return tx(db, async (c) => {
    const ins = await c.query(
      `insert into idempotency_records (user_id, scope, key, request_hash) values ($1,$2,$3,$4) on conflict do nothing returning key`,
      [userId, scope, key, hash],
    );
    if (!ins.rowCount) {
      const { rows } = await c.query(`select * from idempotency_records where user_id=$1 and scope=$2 and key=$3`, [userId, scope, key]);
      const ex = rows[0];
      if (ex.request_hash !== hash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request');
      if (ex.status === 'COMPLETED') return { status: ex.response_status, body: ex.response_body as T, replayed: true };
      throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'An identical request is still being processed');
    }
    const out = await fn(c);
    await c.query(
      `update idempotency_records set status='COMPLETED', response_status=$4, response_body=$5 where user_id=$1 and scope=$2 and key=$3`,
      [userId, scope, key, out.status, JSON.stringify(out.body)],
    );
    return { ...out, replayed: false };
  });
}
