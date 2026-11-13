import type { DispatchCandidate, DispatchDecision, RideStatus } from '@relay/contracts';
import type { PoolClient } from 'pg';
import { type Ctx, inTx } from '../../common/context.js';
import { tx } from '../../database/db.js';
import { AppError, conflict, forbidden, notFound } from '../../common/errors.js';
import { metrics } from '../../common/metrics.js';
import { logger } from '../../common/logger.js';
import { config } from '../../config.js';
import { enqueue } from '../../workers/jobs.js';
import { emit } from '../notifications/outbox.js';
import { getRideRow, toRideDto, type RideRow } from '../rides/rides.repo.js';
import { NOW, rideEvent, SYSTEM, transition, type ActorRef } from '../rides/transition.js';
import { applyPoolPlan, advancePoolPlan, findPoolOptions, type PoolPlan } from '../pooling/pooling.service.js';
import { ineligibleReasons, type DriverState } from './eligibility.js';
import { explain, rankCandidates, type Ranked } from './scoring.js';

const DISPATCHABLE: RideStatus[] = ['REQUESTED', 'DISPATCHING', 'REASSIGNING'];
const COMMITTED = `('ACCEPTED','ARRIVING','ONGOING','EXCEPTION')`;

/* ------------------------------------------------------------ candidates */

async function loadDriverStates(ctx: Ctx, ride: RideRow): Promise<{ states: DriverState[]; now: Date }> {
  const radius = config.dispatch.searchRadiusM;
  const { rows } = await ctx.db.query(
    `select now() as db_now, d.id, u.display_name, d.is_bot, d.availability_status, d.approval_status, d.capacity,
            d.offers_received, d.offers_accepted, d.last_trip_ended_at, d.online_since,
            l.recorded_at, l.accuracy_m, ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng,
            ST_Distance(l.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) dist,
            exists(select 1 from rides r where r.assigned_driver_id=d.id and r.status in ${COMMITTED}) on_trip,
            exists(select 1 from dispatch_offers o where o.driver_id=d.id and o.status='PENDING') holding,
            exists(select 1 from dispatch_offers o where o.driver_id=d.id and o.ride_id=$4 and o.offered_at > now()-interval '120 seconds') recently_offered,
            (select count(*) from rides r where r.assigned_driver_id=d.id and r.completed_at > now()-interval '60 minutes') recent_trips
       from drivers d join users u on u.id=d.user_id join driver_locations l on l.driver_id=d.id
      where ST_DWithin(l.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
      order by dist limit 40`,
    [ride.p_lng, ride.p_lat, radius * 1.5, ride.id],
  );
  const now: Date = rows[0]?.db_now ?? new Date();
  return {
    now,
    states: rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      isBot: r.is_bot,
      availability: r.availability_status,
      approval: r.approval_status,
      capacity: r.capacity,
      recordedAt: r.recorded_at,
      accuracyM: Number(r.accuracy_m),
      straightDistanceM: Math.round(r.dist),
      onTrip: r.on_trip,
      holdingOffer: r.holding,
      recentlyOffered: r.recently_offered,
      lat: r.lat,
      lng: r.lng,
      lastTripEndedAt: r.last_trip_ended_at,
      onlineSince: r.online_since,
      offersReceived: r.offers_received,
      offersAccepted: r.offers_accepted,
      recentTrips: Number(r.recent_trips),
    })),
  };
}

export async function buildDecision(ctx: Ctx, ride: RideRow, opts: { targetDriverId?: string; attempt: number }) {
  const t0 = Date.now();
  const { states, now } = await loadDriverStates(ctx, ride);
  const background = !!ride.passenger_is_bot;
  const withReasons = states.map((s) => ({ s, reasons: ineligibleReasons(s, { now, seats: ride.seats, backgroundRequest: background }) }));
  const eligible = withReasons.filter((x) => !x.reasons.length).map((x) => x.s);
  const shortlist = eligible.slice(0, config.dispatch.shortlistSize);
  const routes = shortlist.length ? await ctx.routing.matrix(shortlist.map((d) => ({ lat: d.lat, lng: d.lng })), { lat: ride.p_lat, lng: ride.p_lng }) : [];
  if (routes.some((r) => r.fallback)) metrics.inc('routingFallbacks');
  let ranked: Ranked[] = rankCandidates(
    shortlist.map((d, i) => ({
      driverId: d.id,
      etaSeconds: routes[i].durationS,
      roadDistanceM: routes[i].distanceM,
      idleMinutes: Math.max(0, (now.getTime() - (d.lastTripEndedAt ?? d.onlineSince ?? now).getTime()) / 60000),
      recentTrips: d.recentTrips,
      reliability: d.offersReceived >= 5 ? d.offersAccepted / d.offersReceived : 0.9,
      routeFallback: routes[i].fallback,
    })),
  );
  const names = Object.fromEntries(states.map((s) => [s.id, s.name]));
  let note = '';
  if (opts.targetDriverId) {
    const t = ranked.find((r) => r.driverId === opts.targetDriverId);
    if (t) ranked = [{ ...t, reasonCodes: ['OPERATOR_SELECTED', ...t.reasonCodes] }];
    else note = ' The operator-selected driver was no longer eligible, so normal ranking was used.';
  }
  const byId = new Map(ranked.map((r) => [r.driverId, r]));
  const candidates: DispatchCandidate[] = withReasons
    .map(({ s, reasons }) => {
      const r = byId.get(s.id);
      return {
        driverId: s.id,
        driverName: s.name,
        eligible: !reasons.length,
        ineligibleReasons: reasons,
        straightDistanceM: s.straightDistanceM,
        ...(r && {
          etaSeconds: r.etaSeconds,
          roadDistanceM: r.roadDistanceM,
          idleMinutes: Math.round(r.idleMinutes),
          reliability: Number(r.reliability.toFixed(2)),
          recentTrips: r.recentTrips,
          components: r.components,
          score: r.score,
          rank: r.rank,
          reasonCodes: r.reasonCodes,
          routeFallback: r.routeFallback,
        }),
      };
    })
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.straightDistanceM - b.straightDistanceM)
    .slice(0, 15);
  const decision: DispatchDecision = {
    rideId: ride.id,
    attempt: opts.attempt,
    strategy: 'ETA_FAIRNESS',
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    weights: config.dispatch.weights,
    candidates,
    selectedDriverId: ranked[0]?.driverId ?? null,
    explanation: explain(ranked, names, eligible.length, states.length) + note,
  };
  return { decision, ranked };
}

/* --------------------------------------------------------------- dispatch */

export async function runDispatch(ctx: Ctx, rideId: string, opts: { targetDriverId?: string } = {}) {
  const t0 = Date.now();
  const ride = await getRideRow(ctx.db, rideId);
  if (!DISPATCHABLE.includes(ride.status)) return;
  const { rowCount: pending } = await ctx.db.query(`select 1 from dispatch_offers where ride_id=$1 and status='PENDING'`, [rideId]);
  if (pending) return;

  let poolPlan: PoolPlan | null = null;
  if (ride.pool_opt_in && !opts.targetDriverId) {
    const { rowCount: triedPool } = await ctx.db.query(`select 1 from dispatch_offers where ride_id=$1 and pool_plan is not null`, [rideId]);
    if (!triedPool) {
      poolPlan = (
        await findPoolOptions(ctx, {
          pickup: { lat: ride.p_lat, lng: ride.p_lng },
          dropoff: { lat: ride.d_lat, lng: ride.d_lng },
          seats: ride.seats,
          soloDurationS: ride.est_trip_seconds,
          soloDistanceM: ride.est_trip_meters,
          passengerId: ride.passenger_id,
        })
      ).best;
    }
  }
  const { decision, ranked } = await buildDecision(ctx, ride, { targetDriverId: opts.targetDriverId, attempt: ride.offer_count + 1 });
  if (poolPlan) {
    decision.explanation =
      `Shared-ride match: ${poolPlan.driverName} is already carrying ${poolPlan.hostRideIds.length} opted-in rider(s) on a compatible route — ` +
      `~${Math.max(1, Math.round(poolPlan.newPickupEtaS / 60))} min to pickup, +${Math.round(poolPlan.newExtraS / 60)} min vs solo, ` +
      `co-rider detour within the ${Math.round(config.pool.maxDetourSeconds / 60)}-min limit. Solo fallback: ` +
      decision.explanation;
    decision.selectedDriverId = poolPlan.driverId;
  }

  await tx(ctx.db, async (c) => {
    const r = await getRideRow(c, rideId, true);
    if (!DISPATCHABLE.includes(r.status)) return;
    const { rowCount } = await c.query(`select 1 from dispatch_offers where ride_id=$1 and status='PENDING'`, [rideId]);
    if (rowCount) return;
    await c.query(`insert into dispatch_decisions (ride_id, attempt, decision) values ($1,$2,$3)`, [rideId, decision.attempt, JSON.stringify(decision)]);
    if (r.status !== 'DISPATCHING') {
      await transition(c, r, 'DISPATCHING', SYSTEM, { reason: r.status === 'REQUESTED' ? 'DISPATCH_STARTED' : 'RETRYING_NEXT_CANDIDATE' });
    }
    const { rows: round } = await c.query(
      `select count(*) n from dispatch_offers where ride_id=$1 and offered_at > coalesce(
         (select max(created_at) from ride_events where ride_id=$1 and reason_code in ('PASSENGER_RETRY','OPERATOR_REASSIGN')), 'epoch')`,
      [rideId],
    );
    if (Number(round[0].n) >= config.dispatch.maxOfferAttempts) {
      await transition(c, r, 'NO_DRIVER', SYSTEM, { reason: 'MAX_OFFER_ATTEMPTS', metadata: { explanation: `Offered to ${r.offer_count} drivers without acceptance.` } });
      return;
    }
    const tries: { driverId: string; eta: number; dist: number | null; score: number | null; codes: string[]; plan: PoolPlan | null }[] = [];
    if (poolPlan) tries.push({ driverId: poolPlan.driverId, eta: poolPlan.newPickupEtaS, dist: null, score: null, codes: ['POOL_MATCH'], plan: poolPlan });
    for (const k of ranked) tries.push({ driverId: k.driverId, eta: k.etaSeconds, dist: k.roadDistanceM, score: k.score, codes: k.reasonCodes, plan: null });

    for (const t of tries) {
      await c.query('savepoint offer');
      try {
        const { rows } = await c.query(
          `insert into dispatch_offers (ride_id, driver_id, sequence, status, score, eta_seconds, distance_m, reason_codes, pool_plan, expires_at)
           values ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8, now() + make_interval(secs => $9)) returning id, expires_at, offered_at`,
          [rideId, t.driverId, r.offer_count + 1, t.score, t.eta, t.dist, t.codes, t.plan ? JSON.stringify(t.plan) : null, config.dispatch.offerTtlSeconds],
        );
        await c.query('release savepoint offer');
        const offer = rows[0];
        await c.query(`update rides set offer_count=offer_count+1 where id=$1`, [rideId]);
        r.offer_count++;
        const { rows: du } = await c.query(`update drivers set offers_received=offers_received+1 where id=$1 returning user_id`, [t.driverId]);
        await rideEvent(c, rideId, 'OFFER_SENT', SYSTEM, t.plan ? 'POOL_MATCH' : null, {
          offerId: offer.id,
          driverId: t.driverId,
          sequence: r.offer_count,
          etaSeconds: t.eta,
          score: t.score,
          reasonCodes: t.codes,
          expiresAt: offer.expires_at,
        });
        await emit(c, 'ride.offer_received', rideId, r.version, { rideId, offerId: offer.id, driverId: t.driverId, expiresAt: offer.expires_at }, { userIds: [du[0].user_id] });
        await enqueue(c, 'EXPIRE_OFFER', { offerId: offer.id }, { runAt: offer.expires_at, dedupeKey: `expire:${offer.id}` });
        return;
      } catch (e: any) {
        await c.query('rollback to savepoint offer');
        if (e?.code !== '23505') throw e; // driver grabbed by a concurrent dispatch — try next
      }
    }
    await transition(c, r, 'NO_DRIVER', SYSTEM, { reason: 'NO_ELIGIBLE_DRIVERS', metadata: { explanation: decision.explanation } });
    await emit(c, 'ops.exception_created', rideId, r.version, { rideId, kind: 'NO_DRIVER', message: decision.explanation }, {});
  });
  metrics.inc('dispatchRuns');
  metrics.recordDispatch(Date.now() - t0);
}

/* ------------------------------------------------------------ offers API */

async function lockOffer(c: PoolClient, offerId: string) {
  const { rows } = await c.query(
    `select o.*, d.user_id driver_user_id, now() > o.expires_at as is_expired
       from dispatch_offers o join drivers d on d.id=o.driver_id where o.id=$1 for update of o`,
    [offerId],
  );
  if (!rows[0]) throw notFound('Offer');
  return rows[0];
}
async function rideIdForOffer(ctx: Ctx, offerId: string): Promise<string> {
  const { rows } = await ctx.db.query(`select ride_id from dispatch_offers where id=$1`, [offerId]);
  if (!rows[0]) throw notFound('Offer');
  return rows[0].ride_id;
}

export type AcceptOutcome = { outcome: 'ACCEPTED'; ride: ReturnType<typeof toRideDto> } | { outcome: 'POOL_PLAN_STALE'; message: string };

/**
 * Atomic acceptance. Lock order everywhere: ride → offer → driver.
 * Accept only if the offer is pending and unexpired, the ride is still DISPATCHING, and the driver is free
 * (or, for a pooled offer, holds only the host rides). The partial unique index is the last line of defence.
 */
export async function acceptOffer(ctx: Ctx, offerId: string, driverUserId: string, client?: PoolClient): Promise<AcceptOutcome> {
  const rideId = await rideIdForOffer(ctx, offerId);
  try {
    return await inTx(ctx, client, async (c) => {
      const ride = await getRideRow(c, rideId, true);
      const offer = await lockOffer(c, offerId);
      if (offer.driver_user_id !== driverUserId) throw forbidden('This offer belongs to another driver');
      if (offer.status === 'ACCEPTED') return { outcome: 'ACCEPTED' as const, ride: toRideDto(await getRideRow(c, rideId)) };
      if (offer.status !== 'PENDING') throw conflict('OFFER_NOT_PENDING', `This offer was already ${offer.status.toLowerCase()}`);
      if (offer.is_expired) throw conflict('OFFER_EXPIRED', 'This offer has expired');
      if (ride.status !== 'DISPATCHING') throw conflict('RIDE_NOT_DISPATCHING', 'This ride is no longer looking for a driver');
      const { rows: drows } = await c.query(`select * from drivers where id=$1 for update`, [offer.driver_id]);
      const driver = drows[0];
      if (driver.availability_status !== 'ONLINE') throw conflict('DRIVER_OFFLINE', 'Go online to accept rides');
      const { rows: active } = await c.query(`select id from rides where assigned_driver_id=$1 and status in ${COMMITTED} and id<>$2`, [driver.id, rideId]);
      const plan: PoolPlan | null = offer.pool_plan;
      let groupId: string | null = null;
      if (plan) {
        if (active.some((a) => !plan.hostRideIds.includes(a.id))) throw conflict('DRIVER_BUSY', 'Driver already has a conflicting active ride');
        await c.query('savepoint pool');
        try {
          groupId = await applyPoolPlan(c, plan, rideId, ride.quoted_fare_minor);
          await c.query('release savepoint pool');
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== 'POOL_PLAN_STALE') throw e;
          await c.query('rollback to savepoint pool');
          await c.query(`update dispatch_offers set status='WITHDRAWN', responded_at=now(), response_reason='POOL_PLAN_STALE' where id=$1`, [offerId]);
          await transition(c, ride, 'REASSIGNING', SYSTEM, { reason: 'POOL_PLAN_STALE' });
          await enqueue(c, 'DISPATCH_RIDE', { rideId }, { dedupeKey: `dispatch:${rideId}` });
          return { outcome: 'POOL_PLAN_STALE' as const, message: e.message };
        }
      } else if (active.length) {
        throw conflict('DRIVER_BUSY', 'Driver already has an active ride');
      }
      await c.query(`update dispatch_offers set status='ACCEPTED', responded_at=now() where id=$1`, [offerId]);
      await c.query(`update drivers set offers_accepted=offers_accepted+1 where id=$1`, [driver.id]);
      await c.query(`update reposition_recommendations set status='EXPIRED' where driver_id=$1 and status='ACTIVE'`, [driver.id]);
      await transition(c, ride, 'ACCEPTED', { type: 'DRIVER', id: driverUserId }, {
        reason: plan ? 'DRIVER_ACCEPTED_POOL' : 'DRIVER_ACCEPTED',
        set: { assigned_driver_id: driver.id, accepted_at: NOW, pickup_eta_seconds: offer.eta_seconds, pool_group_id: groupId },
        notifyUserIds: [driverUserId],
        metadata: { offerId, sequence: offer.sequence },
      });
      await emit(c, 'ride.assignment_changed', rideId, ride.version, { rideId, driverId: driver.id, change: 'ASSIGNED' }, { userIds: [ride.passenger_id, driverUserId] });
      return { outcome: 'ACCEPTED' as const, ride: toRideDto(await getRideRow(c, rideId)) };
    });
  } catch (e: any) {
    if (e?.code === '23505') {
      metrics.inc('assignmentConflicts');
      throw conflict('DRIVER_BUSY', 'Driver already has an active ride');
    }
    if (e instanceof AppError && ['DRIVER_BUSY', 'RIDE_NOT_DISPATCHING', 'OFFER_NOT_PENDING'].includes(e.code)) metrics.inc('assignmentConflicts');
    throw e;
  }
}

export async function rejectOffer(ctx: Ctx, offerId: string, driverUserId: string, reason?: string, client?: PoolClient) {
  const rideId = await rideIdForOffer(ctx, offerId);
  return inTx(ctx, client, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    const offer = await lockOffer(c, offerId);
    if (offer.driver_user_id !== driverUserId) throw forbidden('This offer belongs to another driver');
    if (offer.status === 'REJECTED') return { ok: true };
    if (offer.status !== 'PENDING') throw conflict('OFFER_NOT_PENDING', `This offer was already ${offer.status.toLowerCase()}`);
    await c.query(`update dispatch_offers set status='REJECTED', responded_at=now(), response_reason=$2 where id=$1`, [offerId, reason ?? 'DRIVER_REJECTED']);
    if (ride.status === 'DISPATCHING') {
      await transition(c, ride, 'REASSIGNING', { type: 'DRIVER', id: driverUserId }, {
        reason: 'DRIVER_REJECTED',
        metadata: { offerId, driverId: offer.driver_id, sequence: offer.sequence, note: reason ?? null },
      });
      await enqueue(c, 'DISPATCH_RIDE', { rideId }, { dedupeKey: `dispatch:${rideId}` });
    }
    return { ok: true };
  });
}

/** Idempotent: safe to run many times / early; only a still-pending, past-due offer is expired. */
export async function expireOffer(ctx: Ctx, offerId: string) {
  const rideId = await rideIdForOffer(ctx, offerId).catch(() => null);
  if (!rideId) return;
  await tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    const offer = await lockOffer(c, offerId);
    if (offer.status !== 'PENDING') return;
    if (!offer.is_expired) {
      await enqueue(c, 'EXPIRE_OFFER', { offerId }, { runAt: offer.expires_at, dedupeKey: `expire:${offerId}:late` });
      return;
    }
    await c.query(`update dispatch_offers set status='EXPIRED', responded_at=now(), response_reason='NO_RESPONSE' where id=$1`, [offerId]);
    metrics.inc('offerTimeouts');
    await emit(c, 'ride.offer_expired', rideId, ride.version, { rideId, offerId, reason: 'NO_RESPONSE' }, { userIds: [offer.driver_user_id] });
    if (ride.status === 'DISPATCHING') {
      await transition(c, ride, 'REASSIGNING', SYSTEM, { reason: 'OFFER_TIMEOUT', metadata: { offerId, driverId: offer.driver_id, sequence: offer.sequence } });
      await enqueue(c, 'DISPATCH_RIDE', { rideId }, { dedupeKey: `dispatch:${rideId}` });
    }
  });
}

/** Withdraw a pending offer inside the caller's tx (ride must already be locked). */
export async function withdrawPendingOffer(c: PoolClient, ride: RideRow, reason: string, redispatch: boolean) {
  const { rows } = await c.query(
    `update dispatch_offers o set status='WITHDRAWN', responded_at=now(), response_reason=$2 from drivers d
      where o.ride_id=$1 and o.status='PENDING' and d.id=o.driver_id returning o.id, o.driver_id, d.user_id`,
    [ride.id, reason],
  );
  for (const o of rows) {
    await emit(c, 'ride.offer_expired', ride.id, ride.version, { rideId: ride.id, offerId: o.id, reason }, { userIds: [o.user_id] });
    await rideEvent(c, ride.id, 'OFFER_WITHDRAWN', SYSTEM, reason, { offerId: o.id, driverId: o.driver_id });
  }
  if (rows.length && redispatch && ride.status === 'DISPATCHING') {
    await transition(c, ride, 'REASSIGNING', SYSTEM, { reason });
    await enqueue(c, 'DISPATCH_RIDE', { rideId: ride.id }, { dedupeKey: `dispatch:${ride.id}` });
  }
  return rows.length;
}

/** Offers held by drivers who went offline or whose GPS went stale are invalidated and re-dispatched. */
export async function withdrawStaleOffers(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select o.ride_id, case when d.availability_status<>'ONLINE' then 'DRIVER_OFFLINE' else 'DRIVER_LOCATION_STALE' end reason
       from dispatch_offers o join drivers d on d.id=o.driver_id left join driver_locations l on l.driver_id=d.id
      where o.status='PENDING' and (d.availability_status<>'ONLINE' or l.recorded_at is null or l.recorded_at < now() - make_interval(secs => $1))`,
    [config.dispatch.staleLocationSeconds],
  );
  for (const r of rows) {
    await tx(ctx.db, async (c) => {
      const ride = await getRideRow(c, r.ride_id, true);
      const n = await withdrawPendingOffer(c, ride, r.reason, true);
      if (n) metrics.inc('staleWithdrawals');
    });
  }
  return rows.length;
}

/** Driver cancels after accepting: release, record, re-dispatch (excluding them) if the trip hasn't started. */
export async function driverCancel(ctx: Ctx, rideId: string, driverUserId: string, reason?: string) {
  return tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    if (ride.driver_user_id !== driverUserId) throw forbidden('Not your ride');
    if (!['ACCEPTED', 'ARRIVING'].includes(ride.status)) throw conflict('INVALID_TRANSITION', 'Trips that have started cannot be cancelled by the driver; contact operations');
    await advancePoolPlan(c, ride.pool_group_id, rideId, 'ALL');
    await c.query(`delete from pool_members where ride_id=$1`, [rideId]);
    await c.query(`update drivers set last_trip_ended_at=now() where id=$1`, [ride.assigned_driver_id]);
    await transition(c, ride, 'REASSIGNING', { type: 'DRIVER', id: driverUserId }, {
      reason: 'DRIVER_CANCELLED',
      set: { assigned_driver_id: null, pickup_eta_seconds: null, pool_group_id: null, exception_reason: null },
      metadata: { note: reason ?? null },
    });
    await emit(c, 'ride.assignment_changed', rideId, ride.version, { rideId, change: 'DRIVER_CANCELLED' }, { userIds: [ride.passenger_id, driverUserId] });
    await enqueue(c, 'DISPATCH_RIDE', { rideId }, { dedupeKey: `dispatch:${rideId}` });
    return toRideDto(await getRideRow(c, rideId));
  });
}

/** Operator-initiated reassignment (always confirmed in the UI, always audited, never silent). */
export async function opsReassign(ctx: Ctx, rideId: string, operator: ActorRef, input: { driverId?: string; reason?: string }) {
  await tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    if (ride.started_at) throw conflict('INVALID_TRANSITION', 'Trip already started; reassignment is not possible');
    const oldDriverUser = ride.driver_user_id;
    if (ride.status === 'DISPATCHING') {
      await withdrawPendingOffer(c, ride, 'OPERATOR_REASSIGN', false);
    } else if (ride.assigned_driver_id) {
      await advancePoolPlan(c, ride.pool_group_id, rideId, 'ALL');
      await c.query(`delete from pool_members where ride_id=$1`, [rideId]);
    }
    await transition(c, ride, 'REASSIGNING', operator, {
      reason: 'OPERATOR_REASSIGN',
      set: { assigned_driver_id: null, pickup_eta_seconds: null, pool_group_id: null, exception_reason: null, exception_prev_status: null },
      notifyUserIds: [oldDriverUser],
      metadata: { note: input.reason ?? null, targetDriverId: input.driverId ?? null },
    });
    if (oldDriverUser) await emit(c, 'ride.assignment_changed', rideId, ride.version, { rideId, change: 'UNASSIGNED' }, { userIds: [oldDriverUser, ride.passenger_id] });
    await c.query(`insert into audit_log (actor_id, action, entity, entity_id, metadata) values ($1,'RIDE_REASSIGN','ride',$2,$3)`, [operator.id, rideId, JSON.stringify(input)]);
    await enqueue(c, 'DISPATCH_RIDE', { rideId, targetDriverId: input.driverId ?? null }, { dedupeKey: `dispatch:${rideId}` });
  });
}

/** Safety net: anything dispatchable with no pending offer and no queued job gets re-queued. */
export async function requeueOrphans(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select r.id from rides r where r.status in ('REQUESTED','DISPATCHING','REASSIGNING') and r.updated_at < now()-interval '4 seconds'
       and not exists(select 1 from dispatch_offers o where o.ride_id=r.id and o.status='PENDING')
       and not exists(select 1 from jobs j where j.dedupe_key='dispatch:'||r.id and j.status in ('QUEUED','RUNNING'))`,
  );
  for (const r of rows) {
    logger.warn('dispatch.orphan_requeued', { rideId: r.id });
    await enqueue(ctx.db, 'DISPATCH_RIDE', { rideId: r.id }, { dedupeKey: `dispatch:${r.id}` });
  }
}
