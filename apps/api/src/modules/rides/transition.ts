import type { RideStatus } from '@relay/contracts';
import type { Queryable } from '../../database/db.js';
import { conflict } from '../../common/errors.js';
import { emit } from '../notifications/outbox.js';
import { assertTransition, type Actor } from './state-machine.js';
import type { RideRow } from './rides.repo.js';

export interface ActorRef {
  type: Actor;
  id?: string | null;
}
export const SYSTEM: ActorRef = { type: 'SYSTEM' };
export const NOW = Symbol('now');

const SETTABLE = new Set([
  'accepted_at', 'pickup_at', 'started_at', 'completed_at', 'cancelled_at', 'cancelled_by', 'assigned_driver_id',
  'pool_group_id', 'pickup_eta_seconds', 'final_fare_minor', 'exception_reason', 'exception_at', 'exception_prev_status',
  'quoted_fare_minor', 'fare_breakdown',
]);

/** The ONLY way ride status changes: validates, bumps version, appends history, writes outbox — in the caller's tx. */
export async function transition(
  c: Queryable,
  ride: RideRow,
  to: RideStatus,
  actor: ActorRef,
  opts: { reason?: string; metadata?: Record<string, unknown>; set?: Record<string, unknown>; notifyUserIds?: (string | null)[] } = {},
) {
  assertTransition(ride.status, to, actor.type);
  const cols: string[] = [];
  const vals: unknown[] = [to, opts.reason ?? null, ride.id, ride.version];
  for (const [k, v] of Object.entries(opts.set ?? {})) {
    if (!SETTABLE.has(k)) throw new Error(`column ${k} not settable`);
    if (v === NOW) cols.push(`${k} = now()`);
    else {
      vals.push(k === 'fare_breakdown' ? JSON.stringify(v) : v);
      cols.push(`${k} = $${vals.length}`);
    }
  }
  const { rows } = await c.query(
    `update rides set status=$1, status_reason=$2, version=version+1, updated_at=now() ${cols.length ? ',' + cols.join(',') : ''}
      where id=$3 and version=$4 returning version, assigned_driver_id`,
    vals,
  );
  if (!rows[0]) throw conflict('STALE_VERSION', 'Ride changed concurrently; refresh and retry');
  const from = ride.status;
  ride.status = to;
  ride.version = rows[0].version;
  await c.query(
    `insert into ride_events (ride_id, event_type, from_status, to_status, actor_type, actor_id, reason_code, metadata)
     values ($1,'STATUS_CHANGED',$2,$3,$4,$5,$6,$7)`,
    [ride.id, from, to, actor.type, actor.id ?? null, opts.reason ?? null, JSON.stringify(opts.metadata ?? {})],
  );
  await emit(c, 'ride.status_changed', ride.id, ride.version, { rideId: ride.id, from, to, reason: opts.reason ?? null }, {
    userIds: [ride.passenger_id, ride.driver_user_id, ...(opts.notifyUserIds ?? [])],
  });
  return ride;
}

/** Non-status timeline entries (offers, flags, pool changes). */
export async function rideEvent(
  c: Queryable,
  rideId: string,
  type: string,
  actor: ActorRef,
  reason: string | null,
  metadata: Record<string, unknown> = {},
) {
  await c.query(
    `insert into ride_events (ride_id, event_type, actor_type, actor_id, reason_code, metadata) values ($1,$2,$3,$4,$5,$6)`,
    [rideId, type, actor.type, actor.id ?? null, reason, JSON.stringify(metadata)],
  );
}
