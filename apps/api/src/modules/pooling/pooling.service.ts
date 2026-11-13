import type { LatLng } from '@relay/contracts';
import type { PoolClient } from 'pg';
import type { Ctx } from '../../common/context.js';
import type { Queryable } from '../../database/db.js';
import { bearingDeg, haversineM } from '../../common/geo.js';
import { conflict } from '../../common/errors.js';
import { config } from '../../config.js';
import { computeFare } from '../pricing/fare.js';
import { zoneMultiplier } from '../pricing/pricing.service.js';
import { zoneForPoint } from '../zones/zones.cache.js';
import { isLocationFresh } from '../dispatch/eligibility.js';
import { bestInsertion, type PoolStop, type RiderEstimate } from './insertion.js';
import { emit } from '../notifications/outbox.js';
import { rideEvent, SYSTEM } from '../rides/transition.js';

export interface PoolPlan {
  driverId: string;
  driverName: string;
  groupId: string | null;
  routeVersion: number;
  hostRideIds: string[];
  stops: PoolStop[];
  riders: RiderEstimate[];
  newPickupEtaS: number;
  newDropoffEtaS: number;
  newExtraS: number;
  pooledFareMinor: number;
  pooledFare: ReturnType<typeof computeFare>;
}
export interface PoolRejection {
  rideId: string;
  shortId: string;
  driverName: string;
  code: string;
  message: string;
}

const short = (id: string) => id.slice(0, 6).toUpperCase();
const NEW = 'NEW';

/** Remaining stop plan for a driver's current committed rides. */
export async function currentStops(c: Queryable, groupId: string | null, rides: any[]): Promise<{ stops: PoolStop[]; onboard: number; version: number }> {
  let version = 0;
  let stops: PoolStop[];
  if (groupId) {
    const { rows } = await c.query(`select stop_plan, route_version from pool_groups where id=$1`, [groupId]);
    version = rows[0]?.route_version ?? 0;
    stops = (rows[0]?.stop_plan ?? []) as PoolStop[];
  } else {
    stops = rides.flatMap((r) => [
      { rideId: r.id, kind: 'PICKUP' as const, point: { lat: r.p_lat, lng: r.p_lng }, seats: r.seats },
      { rideId: r.id, kind: 'DROPOFF' as const, point: { lat: r.d_lat, lng: r.d_lng }, seats: r.seats },
    ]);
  }
  const started = new Set(rides.filter((r) => r.status === 'ONGOING').map((r) => r.id));
  const alive = new Set(rides.map((r) => r.id));
  stops = stops.filter((s) => alive.has(s.rideId) && !(s.kind === 'PICKUP' && started.has(s.rideId)));
  const onboard = rides.filter((r) => started.has(r.id)).reduce((a, r) => a + r.seats, 0);
  return { stops, onboard, version };
}

export async function findPoolOptions(
  ctx: Ctx,
  req: { pickup: LatLng; dropoff: LatLng; seats: number; soloDurationS: number; soloDistanceM: number; passengerId: string },
): Promise<{ best: PoolPlan | null; rejected: PoolRejection[]; evaluatedHosts: number }> {
  const { rows } = await ctx.db.query(
    `select r.id, r.status, r.seats, r.pool_group_id, r.assigned_driver_id driver_id,
            ST_Y(r.pickup::geometry) p_lat, ST_X(r.pickup::geometry) p_lng, ST_Y(r.destination::geometry) d_lat, ST_X(r.destination::geometry) d_lng,
            v.seat_capacity, u.display_name driver_name, d.availability_status, l.recorded_at,
            ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng,
            exists(select 1 from dispatch_offers o where o.driver_id=d.id and o.status='PENDING') holding
       from rides r join drivers d on d.id=r.assigned_driver_id join users u on u.id=d.user_id
       join vehicles v on v.id=d.vehicle_id join driver_locations l on l.driver_id=d.id
      where r.pool_opt_in and r.status in ('ACCEPTED','ARRIVING','ONGOING') and r.passenger_id <> $1
        and ST_DWithin(l.location, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, 6000)`,
    [req.passengerId, req.pickup.lng, req.pickup.lat],
  );
  // Drivers whose committed set includes a non-opted-in ride cannot host.
  const { rows: blockers } = await ctx.db.query(
    `select distinct assigned_driver_id from rides where status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION') and not pool_opt_in and assigned_driver_id = any($1)`,
    [[...new Set(rows.map((r) => r.driver_id))]],
  );
  const blocked = new Set(blockers.map((b) => b.assigned_driver_id));
  const byDriver = new Map<string, any[]>();
  rows.forEach((r) => byDriver.set(r.driver_id, [...(byDriver.get(r.driver_id) ?? []), r]));

  const rejected: PoolRejection[] = [];
  let best: (PoolPlan & { cost: number }) | null = null;
  const now = new Date();
  const newBearing = bearingDeg(req.pickup, req.dropoff);
  const m = await zoneMultiplier(ctx.db, zoneForPoint(req.pickup)?.id);

  for (const [driverId, rides] of byDriver) {
    const head = rides[0];
    const reject = (code: string, message: string) => rides.forEach((r) => rejected.push({ rideId: r.id, shortId: short(r.id), driverName: head.driver_name, code, message }));
    if (blocked.has(driverId)) continue;
    if (head.availability_status !== 'ONLINE' || !isLocationFresh(head.recorded_at, now) || head.holding) {
      reject('DRIVER_UNAVAILABLE', 'Host driver is busy with another offer or has a stale location');
      continue;
    }
    const driverPos = { lat: head.lat, lng: head.lng };
    const { stops, onboard, version } = await currentStops(ctx.db, head.pool_group_id, rides);
    const nearest = Math.min(haversineM(req.pickup, driverPos), ...stops.map((s) => haversineM(req.pickup, s.point)));
    if (nearest > config.pool.maxPickupGapM) {
      reject('PICKUP_TOO_FAR', `Your pickup is ${(nearest / 1000).toFixed(1)} km from this vehicle's route (limit ${(config.pool.maxPickupGapM / 1000).toFixed(1)} km)`);
      continue;
    }
    const hostBearing = bearingDeg(driverPos, stops[stops.length - 1]?.point ?? driverPos);
    const diff = Math.abs(((newBearing - hostBearing + 540) % 360) - 180);
    if (diff > 110) {
      reject('INCOMPATIBLE_DIRECTION', `Heading the opposite way (${Math.round(diff)}° apart)`);
      continue;
    }
    // pairwise travel matrix over the few points involved (cached provider)
    const pts = [driverPos, ...stops.map((s) => s.point), req.pickup, req.dropoff];
    const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    const mat = new Map<string, number>();
    for (const b of pts) {
      const est = await ctx.routing.matrix(pts, b);
      pts.forEach((a, i) => mat.set(`${key(a)}>${key(b)}`, est[i].durationS));
    }
    const result = bestInsertion({
      driverPos,
      capacity: head.seat_capacity,
      onboardSeats: onboard,
      stops,
      newRide: { rideId: NEW, pickup: req.pickup, dropoff: req.dropoff, seats: req.seats, soloDurationS: req.soloDurationS },
      travel: (a, b) => (key(a) === key(b) ? 0 : mat.get(`${key(a)}>${key(b)}`) ?? 0),
    });
    if (!result.feasible) {
      reject(result.violation!.code, result.violation!.message);
      continue;
    }
    const mine = result.riders!.find((r) => r.rideId === NEW)!;
    const pooledFare = computeFare({ distanceM: req.soloDistanceM, durationS: req.soloDurationS, surgeMultiplier: m, poolDiscount: config.pool.discount, provider: ctx.routing.name, fallback: false });
    const plan = {
      driverId,
      driverName: head.driver_name,
      groupId: head.pool_group_id,
      routeVersion: version,
      hostRideIds: rides.map((r) => r.id),
      stops: result.stops!,
      riders: result.riders!,
      newPickupEtaS: mine.pickupEtaS!,
      newDropoffEtaS: mine.dropoffEtaS,
      newExtraS: mine.extraS,
      pooledFareMinor: pooledFare.totalMinor,
      pooledFare,
      cost: result.costS!,
    };
    if (!best || plan.cost < best.cost) best = plan;
  }
  rejected.sort((a, b) => a.code.localeCompare(b.code));
  return { best, rejected: rejected.slice(0, 8), evaluatedHosts: byDriver.size };
}

/** Commit a plan inside the acceptance transaction. Fails if the host's route changed since the offer. */
export async function applyPoolPlan(c: PoolClient, plan: PoolPlan, newRideId: string, newFareMinor: number): Promise<string> {
  const stops = plan.stops.map((s) => (s.rideId === NEW ? { ...s, rideId: newRideId } : s));
  let groupId = plan.groupId;
  let version: number;
  if (groupId) {
    const { rows } = await c.query(`select route_version, status from pool_groups where id=$1 for update`, [groupId]);
    if (!rows[0] || rows[0].status !== 'ACTIVE' || rows[0].route_version !== plan.routeVersion) throw conflict('POOL_PLAN_STALE', "The shared ride's route changed; finding another option");
    version = plan.routeVersion + 1;
    await c.query(`update pool_groups set stop_plan=$2, route_version=$3, updated_at=now() where id=$1`, [groupId, JSON.stringify(stops), version]);
  } else {
    const { rows: hosts } = await c.query(`select id, pool_group_id, status, quoted_fare_minor from rides where id = any($1) for update`, [plan.hostRideIds]);
    if (hosts.some((h) => h.pool_group_id || !['ACCEPTED', 'ARRIVING', 'ONGOING'].includes(h.status))) throw conflict('POOL_PLAN_STALE', "The shared ride's route changed; finding another option");
    version = 1;
    const { rows: cap } = await c.query(`select v.seat_capacity from drivers d join vehicles v on v.id=d.vehicle_id where d.id=$1`, [plan.driverId]);
    const { rows } = await c.query(`insert into pool_groups (driver_id, capacity, stop_plan, route_version) values ($1,$2,$3,1) returning id`, [plan.driverId, cap[0].seat_capacity, JSON.stringify(stops)]);
    groupId = rows[0].id as string;
    await c.query(`update rides set pool_group_id=$1, version=version+1, updated_at=now() where id = any($2)`, [groupId, plan.hostRideIds]);
    for (const h of hosts) {
      await c.query(
        `insert into pool_members (pool_group_id, ride_id, pickup_seq, dropoff_seq, agreed_fare_minor, route_version) values ($1,$2,0,1,$3,1) on conflict do nothing`,
        [groupId, h.id, h.quoted_fare_minor],
      );
    }
  }
  const seq = (id: string, k: string) => stops.findIndex((s) => s.rideId === id && s.kind === k);
  const me = plan.riders.find((r) => r.rideId === NEW)!;
  await c.query(
    `insert into pool_members (pool_group_id, ride_id, pickup_seq, dropoff_seq, detour_seconds, agreed_fare_minor, est_dropoff_seconds, route_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [groupId, newRideId, seq(newRideId, 'PICKUP'), seq(newRideId, 'DROPOFF'), me.extraS, newFareMinor, me.dropoffEtaS, version],
  );
  for (const r of plan.riders.filter((x) => x.rideId !== NEW)) {
    await c.query(`update pool_members set detour_seconds=detour_seconds+$3, est_dropoff_seconds=$4, route_version=$5 where pool_group_id=$1 and ride_id=$2`, [groupId, r.rideId, r.extraS, r.dropoffEtaS, version]);
    await rideEvent(c, r.rideId, 'POOL_RIDER_JOINED', SYSTEM, 'POOL_MATCH', { addedSeconds: r.extraS, routeVersion: version });
    const { rows } = await c.query(`update rides set version=version+1 where id=$1 returning version, passenger_id`, [r.rideId]);
    await emit(c, 'ride.assignment_changed', r.rideId, rows[0].version, { rideId: r.rideId, change: 'POOL_RIDER_JOINED', addedSeconds: r.extraS }, { userIds: [rows[0].passenger_id] });
  }
  return groupId!;
}

/** Drop a ride's stops from its group (on pickup, completion, or cancellation); close the group when empty. */
export async function advancePoolPlan(c: Queryable, groupId: string | null, rideId: string, which: 'PICKUP' | 'ALL') {
  if (!groupId) return;
  const { rows } = await c.query(`select stop_plan from pool_groups where id=$1 for update`, [groupId]);
  if (!rows[0]) return;
  const plan = (rows[0].stop_plan as PoolStop[]).filter((s) => !(s.rideId === rideId && (which === 'ALL' || s.kind === 'PICKUP')));
  await c.query(`update pool_groups set stop_plan=$2, route_version=route_version+1, status=$3, updated_at=now() where id=$1`, [groupId, JSON.stringify(plan), plan.length ? 'ACTIVE' : 'CLOSED']);
}
