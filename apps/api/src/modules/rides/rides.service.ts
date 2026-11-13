import type { CreateRideInput, LatLng, Role } from '@relay/contracts';
import type { PoolClient } from 'pg';
import type { Ctx } from '../../common/context.js';
import { tx } from '../../database/db.js';
import { AppError, conflict, forbidden } from '../../common/errors.js';
import { haversineM } from '../../common/geo.js';
import { config } from '../../config.js';
import { enqueue } from '../../workers/jobs.js';
import { emit } from '../notifications/outbox.js';
import { quoteTrip } from '../pricing/pricing.service.js';
import { findPoolOptions } from '../pooling/pooling.service.js';
import { advancePoolPlan } from '../pooling/pooling.service.js';
import { withdrawPendingOffer } from '../dispatch/dispatch.service.js';
import { zoneForPoint } from '../zones/zones.cache.js';
import { RIDE_SELECT, getRideRow, toRideDto } from './rides.repo.js';
import { NOW, rideEvent, transition, type ActorRef } from './transition.js';
import { allowedNext } from './state-machine.js';

export interface AuthUser {
  id: string;
  role: Role;
  displayName: string;
  driverId?: string | null;
  isBot?: boolean;
}

function validateServiceArea(p: LatLng, label: string) {
  if (!zoneForPoint(p)) throw new AppError(422, 'OUTSIDE_SERVICE_AREA', `${label} is outside the Relay demo service area`);
}

/** Solo + (optional) shared quote, with the reasons other shared rides were not offered. */
export async function quote(ctx: Ctx, user: AuthUser, input: { pickup: LatLng; destination: LatLng; seats: number }) {
  validateServiceArea(input.pickup, 'Pickup');
  validateServiceArea(input.destination, 'Destination');
  if (haversineM(input.pickup, input.destination) < 150) throw new AppError(422, 'TRIP_TOO_SHORT', 'Pickup and destination are too close together');
  const solo = await quoteTrip(ctx, input.pickup, input.destination);
  const pool = await findPoolOptions(ctx, {
    pickup: input.pickup,
    dropoff: input.destination,
    seats: input.seats,
    soloDurationS: solo.route.durationS,
    soloDistanceM: solo.route.distanceM,
    passengerId: user.id,
  });
  const { rows } = await ctx.db.query(
    `select count(*) n, min(ST_Distance(l.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)) nearest
       from drivers d join driver_locations l on l.driver_id=d.id
      where d.availability_status='ONLINE' and l.recorded_at > now()-make_interval(secs => $3)
        and ST_DWithin(l.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $4)`,
    [input.pickup.lng, input.pickup.lat, config.dispatch.staleLocationSeconds, config.dispatch.searchRadiusM],
  );
  const nearbyDrivers = Number(rows[0].n);
  // indicative pickup estimate from the nearest online driver (estimate only; dispatch decides)
  const pickupEstimateS = nearbyDrivers ? Math.round((rows[0].nearest * 1.25) / (22 / 3.6) + 30) : null;
  return {
    solo: {
      fare: solo.fare,
      tripDurationS: solo.route.durationS,
      tripDistanceM: solo.route.distanceM,
      pickupEstimateS,
    },
    pool: pool.best
      ? {
          available: true,
          fare: pool.best.pooledFare,
          pickupEstimateS: pool.best.newPickupEtaS,
          tripDurationS: pool.best.newDropoffEtaS - pool.best.newPickupEtaS,
          extraS: pool.best.newExtraS,
          coRiders: pool.best.hostRideIds.length,
          driverName: pool.best.driverName,
        }
      : { available: false },
    poolRejections: pool.rejected,
    nearbyDrivers,
    pickupZone: solo.pickupZone && { id: solo.pickupZone.id, name: solo.pickupZone.name },
    surgeMultiplier: solo.fare.surgeMultiplier,
    cancellationPolicy: `Free cancellation until a driver accepts and for ${config.cancellation.freeWindowSeconds / 60} minutes after. After that a ${(config.cancellation.feeMinor / 100).toFixed(0)} INR demo fee applies.`,
  };
}

/** Create a ride (inside the idempotency transaction). The outbox event and dispatch job commit atomically with it. */
export async function createRide(ctx: Ctx, c: PoolClient, user: AuthUser, input: CreateRideInput) {
  validateServiceArea(input.pickup, 'Pickup');
  validateServiceArea(input.destination, 'Destination');
  if (haversineM(input.pickup, input.destination) < 150) throw new AppError(422, 'TRIP_TOO_SHORT', 'Pickup and destination are too close together');
  const active = await c.query(`select id from rides where passenger_id=$1 and status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING','ONGOING','EXCEPTION') limit 1`, [user.id]);
  if (active.rowCount) throw conflict('ACTIVE_RIDE_EXISTS', 'You already have an active ride', { rideId: active.rows[0].id });

  const solo = await quoteTrip(ctx, input.pickup, input.destination);
  let fare = solo.fare;
  if (input.poolOptIn) {
    // honour the shared price only if a compatible shared ride exists right now
    const pool = await findPoolOptions(ctx, { pickup: input.pickup, dropoff: input.destination, seats: input.seats, soloDurationS: solo.route.durationS, soloDistanceM: solo.route.distanceM, passengerId: user.id });
    if (pool.best) fare = pool.best.pooledFare;
  }
  const { rows } = await c.query(
    `insert into rides (passenger_id, status, pickup, pickup_label, destination, destination_label, pickup_zone_id, destination_zone_id,
                        seats, pool_opt_in, quoted_fare_minor, currency, fare_breakdown, est_trip_seconds, est_trip_meters)
     values ($1,'REQUESTED', ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4, ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16) returning id`,
    [
      user.id, input.pickup.lng, input.pickup.lat, input.pickupLabel, input.destination.lng, input.destination.lat, input.destinationLabel,
      solo.pickupZone?.id ?? null, solo.destinationZone?.id ?? null, input.seats, input.poolOptIn, fare.totalMinor, fare.currency,
      JSON.stringify(fare), solo.route.durationS, solo.route.distanceM,
    ],
  );
  const id = rows[0].id;
  await c.query(
    `insert into ride_events (ride_id, event_type, to_status, actor_type, actor_id, reason_code, metadata) values ($1,'CREATED','REQUESTED','PASSENGER',$2,null,$3)`,
    [id, user.id, JSON.stringify({ quotedFareMinor: fare.totalMinor, poolOptIn: input.poolOptIn, pooledPrice: fare !== solo.fare })],
  );
  await emit(c, 'ride.created', id, 1, { rideId: id, pickupZoneId: solo.pickupZone?.id ?? null }, { userIds: [user.id] });
  await enqueue(c, 'DISPATCH_RIDE', { rideId: id }, { dedupeKey: `dispatch:${id}` });
  return toRideDto(await getRideRow(c, id));
}

export async function assertCanRead(ctx: Ctx, user: AuthUser, rideId: string) {
  const ride = await getRideRow(ctx.db, rideId);
  if (user.role === 'OPERATOR' || user.role === 'ADMIN') return ride;
  if (ride.passenger_id === user.id) return ride;
  if (user.role === 'DRIVER' && user.driverId) {
    if (ride.assigned_driver_id === user.driverId) return ride;
    const { rowCount } = await ctx.db.query(`select 1 from dispatch_offers where ride_id=$1 and driver_id=$2 and status='PENDING'`, [rideId, user.driverId]);
    if (rowCount) return ride;
  }
  throw forbidden('You cannot view this ride');
}

/** Role-shaped view: passengers never see other passengers; drivers get pickup only once offered/assigned. */
export async function getRideView(ctx: Ctx, user: AuthUser, rideId: string) {
  const ride = await assertCanRead(ctx, user, rideId);
  const dto = toRideDto(ride);
  const actor = user.role === 'ADMIN' ? 'OPERATOR' : (user.role as ActorRef['type']);
  const co = ride.pool_group_id
    ? (await ctx.db.query(`select count(*) n from pool_members m join rides r on r.id=m.ride_id where m.pool_group_id=$1 and r.id<>$2 and r.status in ('ACCEPTED','ARRIVING','ONGOING')`, [ride.pool_group_id, rideId])).rows[0].n
    : 0;
  const { rows: loc } = ride.assigned_driver_id
    ? await ctx.db.query(`select ST_Y(location::geometry) lat, ST_X(location::geometry) lng, heading, recorded_at from driver_locations where driver_id=$1`, [ride.assigned_driver_id])
    : { rows: [] as any[] };
  const { rows: offers } = user.role === 'DRIVER'
    ? await ctx.db.query(`select id, status, expires_at, eta_seconds, distance_m, pool_plan is not null pooled from dispatch_offers where ride_id=$1 and driver_id=$2 order by sequence desc limit 1`, [rideId, user.driverId])
    : { rows: [] as any[] };
  return {
    ...dto,
    passenger: user.role === 'DRIVER' ? { id: dto.passenger.id, name: dto.passenger.name.split(' ')[0] } : dto.passenger,
    coRiders: Number(co),
    driverLocation: loc[0] ? { lat: loc[0].lat, lng: loc[0].lng, heading: Number(loc[0].heading ?? 0), recordedAt: loc[0].recorded_at } : null,
    myOffer: offers[0] ?? null,
    allowedActions: allowedNext(ride.status, actor),
  };
}

export async function listMyRides(ctx: Ctx, user: AuthUser, limit = 30) {
  const where = user.role === 'DRIVER' ? 'r.assigned_driver_id = $1' : 'r.passenger_id = $1';
  const { rows } = await ctx.db.query(`${RIDE_SELECT} where ${where} order by r.requested_at desc limit $2`, [user.role === 'DRIVER' ? user.driverId : user.id, limit]);
  return rows.map(toRideDto);
}

export async function rideTimeline(ctx: Ctx, user: AuthUser, rideId: string) {
  await assertCanRead(ctx, user, rideId);
  const ops = user.role === 'OPERATOR' || user.role === 'ADMIN';
  const { rows } = await ctx.db.query(
    `select e.id, e.event_type, e.from_status, e.to_status, e.actor_type, e.reason_code, e.metadata, e.created_at, u.display_name actor_name
       from ride_events e left join users u on u.id=e.actor_id where e.ride_id=$1 order by e.id`,
    [rideId],
  );
  return rows
    .filter((r) => ops || !['OFFER_SENT', 'OFFER_WITHDRAWN'].includes(r.event_type))
    .map((r) => ({
      id: r.id,
      type: r.event_type,
      from: r.from_status,
      to: r.to_status,
      actor: r.actor_type,
      actorName: ops ? r.actor_name : undefined,
      reason: r.reason_code,
      metadata: ops ? r.metadata : {},
      at: r.created_at,
    }));
}

/** Rider or operator cancellation. Records actor + reason, applies the demo fee policy, releases the driver, fixes the pool plan. */
export async function cancelRide(ctx: Ctx, user: AuthUser, rideId: string, reason?: string) {
  return tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    const isOps = user.role === 'OPERATOR' || user.role === 'ADMIN';
    if (!isOps && ride.passenger_id !== user.id) throw forbidden('You cannot cancel this ride');
    const actor: ActorRef = { type: isOps ? 'OPERATOR' : 'PASSENGER', id: user.id };
    let fee = 0;
    if (!isOps && ['ACCEPTED', 'ARRIVING'].includes(ride.status) && ride.accepted_at) {
      const { rows } = await c.query(`select extract(epoch from now()-$1::timestamptz) s`, [ride.accepted_at]);
      if (Number(rows[0].s) > config.cancellation.freeWindowSeconds) fee = config.cancellation.feeMinor;
    }
    await withdrawPendingOffer(c, ride, 'RIDE_CANCELLED', false);
    await advancePoolPlan(c, ride.pool_group_id, rideId, 'ALL');
    if (ride.assigned_driver_id) await c.query(`update drivers set last_trip_ended_at=now() where id=$1`, [ride.assigned_driver_id]);
    const fareLines = fee ? { ...ride.fare_breakdown, lines: [{ code: 'CANCELLATION_FEE', label: 'Late cancellation fee (demo)', amountMinor: fee }], totalMinor: fee } : ride.fare_breakdown;
    await transition(c, ride, 'CANCELLED', actor, {
      reason: isOps ? 'OPERATOR_CANCELLED' : 'RIDER_CANCELLED',
      set: { cancelled_at: NOW, cancelled_by: actor.type, final_fare_minor: fee, fare_breakdown: fareLines, exception_reason: null },
      metadata: { note: reason ?? null, feeMinor: fee },
    });
    if (isOps) await c.query(`insert into audit_log (actor_id, action, entity, entity_id, metadata) values ($1,'RIDE_CANCEL','ride',$2,$3)`, [user.id, rideId, JSON.stringify({ reason })]);
    return toRideDto(await getRideRow(c, rideId));
  });
}

/** NO_DRIVER → retry dispatch. */
export async function retryRide(ctx: Ctx, user: AuthUser, rideId: string) {
  return tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    const isOps = user.role === 'OPERATOR' || user.role === 'ADMIN';
    if (!isOps && ride.passenger_id !== user.id) throw forbidden();
    await transition(c, ride, 'REASSIGNING', { type: isOps ? 'OPERATOR' : 'PASSENGER', id: user.id }, { reason: 'PASSENGER_RETRY' });
    await enqueue(c, 'DISPATCH_RIDE', { rideId }, { dedupeKey: `dispatch:${rideId}` });
    return toRideDto(await getRideRow(c, rideId));
  });
}

type DriverStep = 'arriving' | 'start' | 'complete';
/** Driver progresses the trip. Only the assigned driver may do so, and only along allowed transitions. */
export async function driverStep(ctx: Ctx, user: AuthUser, rideId: string, step: DriverStep) {
  return tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    if (!user.driverId || ride.assigned_driver_id !== user.driverId) throw forbidden('This ride is not assigned to you');
    const actor: ActorRef = { type: 'DRIVER', id: user.id };
    if (step === 'arriving') {
      await transition(c, ride, 'ARRIVING', actor, { reason: 'DRIVER_AT_PICKUP', set: { pickup_at: NOW, exception_reason: null } });
    } else if (step === 'start') {
      await advancePoolPlan(c, ride.pool_group_id, rideId, 'PICKUP');
      await transition(c, ride, 'ONGOING', actor, { reason: 'TRIP_STARTED', set: { started_at: NOW } });
    } else {
      await advancePoolPlan(c, ride.pool_group_id, rideId, 'ALL');
      await c.query(`update drivers set last_trip_ended_at=now() where id=$1`, [user.driverId]);
      // the quoted (agreed) fare is the final fare — no hidden changes after acceptance
      await transition(c, ride, 'COMPLETED', actor, { reason: 'TRIP_COMPLETED', set: { completed_at: NOW, final_fare_minor: ride.quoted_fare_minor } });
    }
    return toRideDto(await getRideRow(c, rideId));
  });
}

/** Maintenance: flag delayed arrivals, raise EXCEPTION for unreachable drivers, auto-recover when GPS returns. */
export async function detectExceptions(ctx: Ctx) {
  const sim = config.simulation.speed;
  const { rows: delayed } = await ctx.db.query(
    `select id from rides where status='ACCEPTED' and exception_reason is null and accepted_at is not null and pickup_eta_seconds is not null
        and extract(epoch from now()-accepted_at) * $1 > pickup_eta_seconds + $2`,
    [sim, config.dispatch.delayedArrivalGraceSeconds],
  );
  for (const r of delayed) {
    await tx(ctx.db, async (c) => {
      const ride = await getRideRow(c, r.id, true);
      if (ride.status !== 'ACCEPTED' || ride.exception_reason) return;
      const { rows } = await c.query(`update rides set exception_reason='DELAYED_ARRIVAL', exception_at=now(), version=version+1 where id=$1 returning version`, [r.id]);
      await rideEvent(c, r.id, 'EXCEPTION_FLAGGED', { type: 'SYSTEM' }, 'DELAYED_ARRIVAL', { note: 'Driver is later than the estimated pickup time' });
      await emit(c, 'ops.exception_created', r.id, rows[0].version, { rideId: r.id, kind: 'DELAYED_ARRIVAL', message: 'Driver is running late to pickup' }, { userIds: [ride.passenger_id] });
    });
  }
  const { rows: unreachable } = await ctx.db.query(
    `select r.id from rides r join driver_locations l on l.driver_id=r.assigned_driver_id
      where r.status in ('ACCEPTED','ARRIVING','ONGOING') and l.recorded_at < now()-interval '90 seconds'`,
  );
  for (const r of unreachable) {
    await tx(ctx.db, async (c) => {
      const ride = await getRideRow(c, r.id, true);
      if (!['ACCEPTED', 'ARRIVING', 'ONGOING'].includes(ride.status)) return;
      await transition(c, ride, 'EXCEPTION', { type: 'SYSTEM' }, { reason: 'DRIVER_UNREACHABLE', set: { exception_reason: 'DRIVER_UNREACHABLE', exception_at: NOW, exception_prev_status: ride.status } });
      await emit(c, 'ops.exception_created', r.id, ride.version, { rideId: r.id, kind: 'DRIVER_UNREACHABLE', message: 'Driver location has not updated for 90 s' }, {});
    });
  }
  const { rows: recovered } = await ctx.db.query(
    `select r.id from rides r join driver_locations l on l.driver_id=r.assigned_driver_id
      where r.status='EXCEPTION' and r.exception_reason='DRIVER_UNREACHABLE' and l.recorded_at > now()-interval '15 seconds'`,
  );
  for (const r of recovered) {
    await tx(ctx.db, async (c) => {
      const ride = await getRideRow(c, r.id, true);
      if (ride.status !== 'EXCEPTION' || !ride.exception_prev_status) return;
      await transition(c, ride, ride.exception_prev_status, { type: 'SYSTEM' }, { reason: 'DRIVER_RECONNECTED', set: { exception_reason: null, exception_prev_status: null } });
    });
  }
}

/** Operator resolves a ride in EXCEPTION back to its prior state. */
export async function resolveException(ctx: Ctx, user: AuthUser, rideId: string) {
  return tx(ctx.db, async (c) => {
    const ride = await getRideRow(c, rideId, true);
    if (ride.status === 'EXCEPTION' && ride.exception_prev_status) {
      await transition(c, ride, ride.exception_prev_status, { type: 'OPERATOR', id: user.id }, { reason: 'OPERATOR_RESOLVED', set: { exception_reason: null, exception_prev_status: null } });
    } else if (ride.exception_reason) {
      const { rows } = await c.query(`update rides set exception_reason=null, version=version+1 where id=$1 returning version`, [rideId]);
      await rideEvent(c, rideId, 'EXCEPTION_CLEARED', { type: 'OPERATOR', id: user.id }, 'OPERATOR_RESOLVED');
      await emit(c, 'ride.status_changed', rideId, rows[0].version, { rideId, from: ride.status, to: ride.status, reason: 'OPERATOR_RESOLVED' }, { userIds: [ride.passenger_id] });
    } else throw conflict('NO_EXCEPTION', 'This ride has no open exception');
    await c.query(`insert into audit_log (actor_id, action, entity, entity_id) values ($1,'EXCEPTION_RESOLVE','ride',$2)`, [user.id, rideId]);
    return toRideDto(await getRideRow(c, rideId));
  });
}
