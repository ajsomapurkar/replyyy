import type { Pool, PoolClient } from 'pg';
import type { RoutingProvider } from '../modules/routing/routing.js';
import { tx } from '../database/db.js';

export interface Ctx {
  db: Pool;
  routing: RoutingProvider;
}

/** Use the caller's transaction if given, otherwise open one. */
export function inTx<T>(ctx: Ctx, c: PoolClient | undefined, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return c ? fn(c) : tx(ctx.db, fn);
}
