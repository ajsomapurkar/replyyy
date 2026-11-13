import type { RideStatus } from '@relay/contracts';
import type { Ctx } from '../../common/context.js';
import { config } from '../../config.js';
import { median } from '../../common/stats.js';
import { RIDE_SELECT, getRideRow, toRideDto } from '../rides/rides.repo.js';
import { buildDecision } from '../dispatch/dispatch.service.js';
import { zoneForPoint } from '../zones/zones.cache.js';
import { metrics } from '../../common/metrics.js';

export async function fleet(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select d.id, u.display_name name, d.is_bot, d.availability_status, d.approval_status, v.make_model, v.plate_label, v.seat_capacity,
            ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng, l.heading, extract(epoch from now()-l.recorded_at) age_s,
            (select r.id from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION') limit 1) ride_id,
            (select r.status from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION') limit 1) ride_status,
            (select o.ride_id from dispatch_offers o where o.driver_id=d.id and o.status='PENDING') offer_ride_id,
            (select count(*) from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING')) active_count
       from drivers d join users u on u.id=d.user_id join vehicles v on v.id=d.vehicle_id left join driver_locations l on l.driver_id=d.id
      order by u.display_name`,
  );
  return rows.map((r) => {
    const age = r.age_s == null ? null : Math.round(Number(r.age_s));
    const stale = age === null || age > config.dispatch.staleLocationSeconds;
    let state: string;
    if (r.availability_status !== 'ONLINE') state = 'OFFLINE';
    else if (r.approval_status !== 'APPROVED') state = 'NOT_APPROVED';
    else if (r.ride_status === 'ONGOING') state = 'ON_TRIP';
    else if (r.ride_status) state = 'EN_ROUTE';
    else if (r.offer_ride_id) state = 'OFFERED';
    else state = 'AVAILABLE';
    return {
      id: r.id,
      name: r.name,
      controlledBy: r.is_bot ? 'SIMULATED' : 'DEMO_USER',
      state,
      stale: r.availability_status === 'ONLINE' && stale,
      locationAgeSeconds: age,
      lat: r.lat,
      lng: r.lng,
      heading: Number(r.heading ?? 0),
      zone: r.lat != null ? zoneForPoint({ lat: r.lat, lng: r.lng })?.name ?? null : null,
      vehicle: `${r.make_model} · ${r.plate_label}`,
      seats: r.seat_capacity,
      rideId: r.ride_id,
      offerRideId: r.offer_ride_id,
      activeRides: Number(r.active_count),
    };
  });
}

export async function exceptions(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select r.id, r.status, r.exception_reason, r.status_reason, r.offer_count, r.pickup_label, r.updated_at, r.exception_at, pu.display_name passenger
       from rides r join users pu on pu.id=r.passenger_id
      where not r.is_history and (
            r.status='EXCEPTION'
         or (r.status='NO_DRIVER' and r.updated_at > now()-interval '30 minutes')
         or (r.exception_reason is not null and r.status in ('ACCEPTED','ARRIVING','ONGOING'))
         or (r.status in ('DISPATCHING','REASSIGNING') and r.offer_count >= 3))
      order by coalesce(r.exception_at, r.updated_at) desc limit 50`,
  );
  const items = rows.map((r) => {
    const kind = r.status === 'EXCEPTION' ? r.exception_reason : r.status === 'NO_DRIVER' ? 'NO_DRIVER' : r.exception_reason ?? 'REPEATED_REASSIGNMENT';
    const copy: Record<string, [string, string, 'red' | 'amber']> = {
      DRIVER_UNREACHABLE: ['Driver unreachable', 'Driver GPS silent for 90 s mid-trip. Resolve or reassign.', 'red'],
      NO_DRIVER: ['No driver found', 'No eligible driver accepted. Retry dispatch or cancel.', 'red'],
      DELAYED_ARRIVAL: ['Delayed arrival', 'Driver is later than the estimated pickup. Consider reassignment.', 'amber'],
      REPEATED_REASSIGNMENT: ['Repeated reassignment', `Offered ${r.offer_count} times without acceptance. Inspect candidates.`, 'amber'],
    };
    const [title, nextAction, severity] = copy[kind] ?? [kind, 'Inspect ride', 'amber'];
    return { rideId: r.id, kind, title, nextAction, severity, status: r.status as RideStatus, passenger: r.passenger, pickup: r.pickup_label, at: r.exception_at ?? r.updated_at, offerCount: r.offer_count };
  });
  const { rows: stale } = await ctx.db.query(
    `select d.id, u.display_name, extract(epoch from now()-l.recorded_at) age from drivers d join users u on u.id=d.user_id join driver_locations l on l.driver_id=d.id
      where d.availability_status='ONLINE' and l.recorded_at < now()-make_interval(secs => $1) order by age desc`,
    [config.dispatch.staleLocationSeconds],
  );
  return {
    rides: items,
    staleDrivers: stale.map((s) => ({ driverId: s.id, name: s.display_name, ageSeconds: Math.round(Number(s.age)), nextAction: 'Excluded from dispatch until GPS recovers' })),
  };
}

export async function overview(ctx: Ctx) {
  const [fl, ex, active] = await Promise.all([
    fleet(ctx),
    exceptions(ctx),
    ctx.db.query(`${RIDE_SELECT} where r.status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING','ONGOING','EXCEPTION') order by r.requested_at desc limit 200`),
  ]);
  const { rows: recent } = await ctx.db.query(
    `select pickup_eta_seconds eta, extract(epoch from accepted_at-requested_at) r2a from rides where accepted_at > now()-interval '60 minutes' and not is_history`,
  );
  const { rows: today } = await ctx.db.query(
    `select count(*) filter (where status='COMPLETED') completed, count(*) filter (where status='CANCELLED') cancelled, count(*) filter (where status='NO_DRIVER') no_driver, count(*) total
       from rides where requested_at > now()-interval '60 minutes' and not is_history`,
  );
  return {
    kpis: {
      activeRides: active.rows.length,
      availableDrivers: fl.filter((d) => d.state === 'AVAILABLE' && !d.stale).length,
      onlineDrivers: fl.filter((d) => d.state !== 'OFFLINE').length,
      staleDrivers: fl.filter((d) => d.stale).length,
      medianPickupEtaS: median(recent.filter((r) => r.eta != null).map((r) => r.eta)),
      medianRequestToAcceptS: median(recent.map((r) => Number(r.r2a))),
      exceptions: ex.rides.length + ex.staleDrivers.length,
      lastHour: { completed: Number(today[0].completed), cancelled: Number(today[0].cancelled), noDriver: Number(today[0].no_driver), total: Number(today[0].total) },
    },
    fleet: fl,
    rides: active.rows.map(toRideDto),
    exceptions: ex,
    health: { ...metrics.counters, dispatchLatencyMs: metrics.dispatchLatency() },
    simulation: { speed: config.simulation.speed, offerTtlSeconds: config.dispatch.offerTtlSeconds, staleSeconds: config.dispatch.staleLocationSeconds },
    serverTime: new Date().toISOString(),
  };
}

export async function listRides(ctx: Ctx, q: { status?: string; zoneId?: string; search?: string; cursor?: string; limit?: number }) {
  const where: string[] = ['not r.is_history'];
  const p: unknown[] = [];
  if (q.status) {
    p.push(q.status.split(','));
    where.push(`r.status = any($${p.length})`);
  }
  if (q.zoneId) {
    p.push(q.zoneId);
    where.push(`r.pickup_zone_id = $${p.length}`);
  }
  if (q.search) {
    p.push(`%${q.search.toLowerCase()}%`);
    where.push(`(lower(r.id::text) like $${p.length} or lower(pu.display_name) like $${p.length} or lower(r.pickup_label) like $${p.length} or lower(coalesce(du.display_name,'')) like $${p.length})`);
  }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    p.push(ts, id);
    where.push(`(r.requested_at, r.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
  }
  const limit = Math.min(q.limit ?? 50, 100);
  p.push(limit + 1);
  const { rows } = await ctx.db.query(`${RIDE_SELECT} where ${where.join(' and ')} order by r.requested_at desc, r.id desc limit $${p.length}`, p);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toRideDto),
    nextCursor: rows.length > limit && last ? Buffer.from(`${new Date(last.requested_at).toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

export async function rideDetail(ctx: Ctx, rideId: string) {
  const ride = await getRideRow(ctx.db, rideId);
  const { rows: offers } = await ctx.db.query(
    `select o.id, o.sequence, o.status, o.score, o.eta_seconds, o.distance_m, o.reason_codes, o.offered_at, o.expires_at, o.responded_at, o.response_reason,
            o.pool_plan is not null pooled, u.display_name driver_name, d.id driver_id
       from dispatch_offers o join drivers d on d.id=o.driver_id join users u on u.id=d.user_id where o.ride_id=$1 order by o.sequence`,
    [rideId],
  );
  const { rows: decisions } = await ctx.db.query(`select decision from dispatch_decisions where ride_id=$1 order by attempt, id`, [rideId]);
  const { rows: pool } = ride.pool_group_id
    ? await ctx.db.query(
        `select m.ride_id, m.pickup_seq, m.dropoff_seq, m.detour_seconds, m.agreed_fare_minor, r.status, split_part(u.display_name,' ',1) first_name, g.stop_plan, g.route_version, g.capacity
           from pool_members m join rides r on r.id=m.ride_id join users u on u.id=r.passenger_id join pool_groups g on g.id=m.pool_group_id where m.pool_group_id=$1 order by m.joined_at`,
        [ride.pool_group_id],
      )
    : { rows: [] as any[] };
  return {
    ride: toRideDto(ride),
    offers,
    decisions: decisions.map((d) => d.decision),
    pool: pool.length ? { groupId: ride.pool_group_id, capacity: pool[0].capacity, routeVersion: pool[0].route_version, stops: pool[0].stop_plan, members: pool.map(({ stop_plan, ...m }) => m) } : null,
  };
}

/** Live candidate preview for manual reassignment (does not create offers). */
export async function previewCandidates(ctx: Ctx, rideId: string) {
  const ride = await getRideRow(ctx.db, rideId);
  const { decision } = await buildDecision(ctx, ride, { attempt: ride.offer_count + 1 });
  return decision;
}
