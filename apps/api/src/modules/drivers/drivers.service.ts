import type { LatLng } from '@relay/contracts';
import type { Ctx } from '../../common/context.js';
import { tx } from '../../database/db.js';
import { conflict, forbidden, notFound } from '../../common/errors.js';
import { config } from '../../config.js';
import { emit } from '../notifications/outbox.js';
import { getRideRow } from '../rides/rides.repo.js';
import { withdrawPendingOffer } from '../dispatch/dispatch.service.js';
import { currentStops } from '../pooling/pooling.service.js';
import { zoneById, zoneForPoint } from '../zones/zones.cache.js';
import type { AuthUser } from '../rides/rides.service.js';

export const DRIVER_SHARE = 0.8; // simulated earnings share

export async function driverProfile(ctx: Ctx, user: AuthUser) {
  if (!user.driverId) throw forbidden('Not a driver');
  const { rows } = await ctx.db.query(
    `select d.*, u.display_name, v.make_model, v.color, v.plate_label, v.seat_capacity,
            ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng, l.recorded_at, l.accuracy_m, l.heading,
            extract(epoch from now()-l.recorded_at) age_s
       from drivers d join users u on u.id=d.user_id join vehicles v on v.id=d.vehicle_id left join driver_locations l on l.driver_id=d.id
      where d.id=$1`,
    [user.driverId],
  );
  const d = rows[0];
  if (!d) throw notFound('Driver');
  const { rows: offerRows } = await ctx.db.query(
    `select o.id, o.ride_id, o.expires_at, o.offered_at, o.eta_seconds, o.distance_m, o.pool_plan is not null pooled, o.reason_codes,
            r.pickup_label, r.destination_label, r.quoted_fare_minor, r.est_trip_seconds, r.est_trip_meters, r.seats,
            ST_Y(r.pickup::geometry) p_lat, ST_X(r.pickup::geometry) p_lng, ST_Y(r.destination::geometry) d_lat, ST_X(r.destination::geometry) d_lng,
            greatest(0, extract(epoch from o.expires_at-now())) remaining_s
       from dispatch_offers o join rides r on r.id=o.ride_id where o.driver_id=$1 and o.status='PENDING'`,
    [user.driverId],
  );
  const { rows: active } = await ctx.db.query(
    `select r.id, r.status, r.seats, r.pool_group_id, r.pickup_label, r.destination_label, r.quoted_fare_minor, r.pickup_eta_seconds,
            r.exception_reason, split_part(pu.display_name,' ',1) passenger_first_name,
            ST_Y(r.pickup::geometry) p_lat, ST_X(r.pickup::geometry) p_lng, ST_Y(r.destination::geometry) d_lat, ST_X(r.destination::geometry) d_lng
       from rides r join users pu on pu.id=r.passenger_id
      where r.assigned_driver_id=$1 and r.status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION') order by r.accepted_at`,
    [user.driverId],
  );
  const stops = active.length ? (await currentStops(ctx.db, active[0].pool_group_id, active)).stops : [];
  const { rows: rec } = await ctx.db.query(
    `select r.*, z.name to_zone_name, fz.name from_zone_name from reposition_recommendations r join zones z on z.id=r.to_zone_id
       left join zones fz on fz.id=r.from_zone_id where r.driver_id=$1 and r.status in ('ACTIVE','ACCEPTED') and r.expires_at>now() order by created_at desc limit 1`,
    [user.driverId],
  );
  const { rows: earn } = await ctx.db.query(
    `select count(*) trips, coalesce(sum(final_fare_minor),0) gross from rides
      where assigned_driver_id=$1 and status='COMPLETED' and completed_at > date_trunc('day', now() at time zone $2) at time zone $2`,
    [user.driverId, config.cityTimezone],
  );
  const offer = offerRows[0];
  const pos = d.lat != null ? { lat: d.lat, lng: d.lng } : null;
  return {
    id: d.id,
    name: d.display_name,
    availability: d.availability_status,
    approval: d.approval_status,
    rating: Number(d.rating),
    vehicle: { makeModel: d.make_model, color: d.color, plate: d.plate_label, seats: d.seat_capacity },
    location: pos && { ...pos, heading: Number(d.heading ?? 0), recordedAt: d.recorded_at, ageSeconds: Math.round(Number(d.age_s)), accuracyM: Number(d.accuracy_m) },
    locationFresh: d.age_s != null && Number(d.age_s) <= config.dispatch.staleLocationSeconds,
    zone: pos ? zoneForPoint(pos)?.name ?? null : null,
    offer: offer && {
      id: offer.id,
      rideId: offer.ride_id,
      expiresAt: offer.expires_at,
      offeredAt: offer.offered_at,
      remainingSeconds: Math.round(Number(offer.remaining_s)),
      ttlSeconds: config.dispatch.offerTtlSeconds,
      pickupEtaSeconds: offer.eta_seconds,
      pickupDistanceM: offer.distance_m,
      pickup: { lat: offer.p_lat, lng: offer.p_lng, label: offer.pickup_label },
      destination: { lat: offer.d_lat, lng: offer.d_lng, label: offer.destination_label },
      tripSeconds: offer.est_trip_seconds,
      tripMeters: offer.est_trip_meters,
      seats: offer.seats,
      pooled: offer.pooled,
      estEarningsMinor: Math.round(offer.quoted_fare_minor * DRIVER_SHARE),
    },
    activeRides: active.map((r) => ({
      id: r.id,
      status: r.status,
      seats: r.seats,
      passengerFirstName: r.passenger_first_name,
      pickup: { lat: r.p_lat, lng: r.p_lng, label: r.pickup_label },
      destination: { lat: r.d_lat, lng: r.d_lng, label: r.destination_label },
      estEarningsMinor: Math.round(r.quoted_fare_minor * DRIVER_SHARE),
      pickupEtaSeconds: r.pickup_eta_seconds,
      exceptionReason: r.exception_reason,
    })),
    stops,
    recommendation: rec[0] && {
      id: rec[0].id,
      status: rec[0].status,
      toZone: rec[0].to_zone_name,
      toZoneId: rec[0].to_zone_id,
      fromZone: rec[0].from_zone_name,
      reason: rec[0].reason,
      distanceM: rec[0].distance_m,
      travelSeconds: rec[0].travel_seconds,
      gapBefore: Number(rec[0].gap_before),
      gapAfter: Number(rec[0].gap_after),
      horizonMinutes: rec[0].horizon_minutes,
      expiresAt: rec[0].expires_at,
    },
    earningsToday: { trips: Number(earn[0].trips), estEarningsMinor: Math.round(Number(earn[0].gross) * DRIVER_SHARE), simulated: true },
  };
}

export async function setAvailability(ctx: Ctx, user: AuthUser, status: 'ONLINE' | 'OFFLINE') {
  if (!user.driverId) throw forbidden('Not a driver');
  return tx(ctx.db, async (c) => {
    const { rows } = await c.query(`select * from drivers where id=$1 for update`, [user.driverId]);
    const d = rows[0];
    if (d.approval_status !== 'APPROVED') throw conflict('NOT_APPROVED', 'Your account is pending approval');
    if (status === 'OFFLINE') {
      const { rowCount } = await c.query(`select 1 from rides where assigned_driver_id=$1 and status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION')`, [user.driverId]);
      if (rowCount) throw conflict('ACTIVE_RIDE', 'Finish or hand back your current trip before going offline');
      const { rows: pend } = await c.query(`select ride_id from dispatch_offers where driver_id=$1 and status='PENDING'`, [user.driverId]);
      for (const p of pend) {
        const ride = await getRideRow(c, p.ride_id, true);
        await withdrawPendingOffer(c, ride, 'DRIVER_OFFLINE', true);
      }
      await c.query(`update reposition_recommendations set status='EXPIRED' where driver_id=$1 and status in ('ACTIVE','ACCEPTED')`, [user.driverId]);
    }
    await c.query(`update drivers set availability_status=$2, online_since=case when $2='ONLINE' then coalesce(online_since, now()) else null end where id=$1`, [user.driverId, status]);
    await emit(c, 'driver.availability_changed', user.driverId!, Date.now(), { driverId: user.driverId, status }, { userIds: [user.id] });
    return { availability: status };
  });
}

export async function updateLocation(ctx: Ctx, user: AuthUser, p: LatLng & { heading?: number; speed?: number; accuracyM?: number }, source = 'DEVICE') {
  if (!user.driverId) throw forbidden('Not a driver');
  await batchUpdateLocations(ctx, [{ driverId: user.driverId, ...p }], source);
  return { ok: true, zone: zoneForPoint(p)?.name ?? null };
}

export async function batchUpdateLocations(ctx: Ctx, items: (LatLng & { driverId: string; heading?: number; speed?: number; accuracyM?: number })[], source = 'SIMULATED') {
  if (!items.length) return;
  await ctx.db.query(
    `with v as (select * from unnest($1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::float8[], $6::float8[]) as t(id, lat, lng, heading, speed, acc))
     insert into driver_locations (driver_id, location, heading, speed, accuracy_m, recorded_at, source)
     select id, ST_SetSRID(ST_MakePoint(lng, lat),4326)::geography, heading, speed, acc, now(), $7 from v
     on conflict (driver_id) do update set location=excluded.location, heading=excluded.heading, speed=excluded.speed,
       accuracy_m=excluded.accuracy_m, recorded_at=excluded.recorded_at, source=excluded.source`,
    [
      items.map((i) => i.driverId),
      items.map((i) => i.lat),
      items.map((i) => i.lng),
      items.map((i) => i.heading ?? 0),
      items.map((i) => i.speed ?? 0),
      items.map((i) => i.accuracyM ?? 8),
      source,
    ],
  );
  await ctx.db.query(`update drivers set last_seen_at=now() where id = any($1)`, [items.map((i) => i.driverId)]);
}

/** Approximate positions of nearby available drivers for the rider map — no identities. */
export async function nearbyDrivers(ctx: Ctx, p: LatLng, radiusM: number) {
  const { rows } = await ctx.db.query(
    `select round(ST_Y(l.location::geometry)::numeric, 3) lat, round(ST_X(l.location::geometry)::numeric, 3) lng
       from drivers d join driver_locations l on l.driver_id=d.id
      where d.availability_status='ONLINE' and d.approval_status='APPROVED' and l.recorded_at > now()-make_interval(secs => $4)
        and ST_DWithin(l.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
        and not exists(select 1 from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING'))
      limit 30`,
    [p.lng, p.lat, Math.min(radiusM, 6000), config.dispatch.staleLocationSeconds],
  );
  return { count: rows.length, drivers: rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) })) };
}

export async function respondRecommendation(ctx: Ctx, user: AuthUser, recId: string, action: 'ACCEPTED' | 'DISMISSED') {
  const { rowCount } = await ctx.db.query(`update reposition_recommendations set status=$3 where id=$1 and driver_id=$2 and status='ACTIVE'`, [recId, user.driverId, action]);
  if (!rowCount) throw conflict('RECOMMENDATION_INACTIVE', 'This suggestion has expired');
  return { ok: true, zone: action === 'ACCEPTED' ? zoneById((await ctx.db.query(`select to_zone_id from reposition_recommendations where id=$1`, [recId])).rows[0].to_zone_id)?.name : null };
}
