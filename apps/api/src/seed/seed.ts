import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { LatLng } from '@relay/contracts';
import { ZONES, PLACES, inZone, placePoint, DEMO_HUB } from './city.js';
import { simulatedActual } from './demand-model.js';
import { mulberry32 } from '../common/prng.js';
import { loadZones } from '../modules/zones/zones.cache.js';
import { MockGridRouting } from '../modules/routing/routing.js';
import { computeFare } from '../modules/pricing/fare.js';
import { forecast, MODEL_NAME, type Series } from '../modules/forecasting/baseline.js';

/** Deterministic UUID from a name so demo accounts (and sessions) survive a reset. */
export function uid(name: string): string {
  const h = createHash('sha1').update(`relay:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const wkt = (poly: LatLng[]) => `POLYGON((${poly.map((p) => `${p.lng} ${p.lat}`).join(', ')}))`;
const BUCKET = 15 * 60_000;
const DAY = 86_400_000;

const BOT_NAMES = [
  'Vikram S.', 'Ananya P.', 'Rohan D.', 'Sneha K.', 'Farhan A.', 'Divya M.', 'Karthik R.', 'Ishita B.', 'Nikhil J.', 'Pooja T.',
  'Sameer H.', 'Lakshmi V.', 'Aditya N.', 'Tanvi G.', 'Imran Q.', 'Neha C.', 'Suresh L.', 'Ritika O.', 'Manoj E.', 'Zoya F.',
  'Harish W.', 'Kavitha Y.', 'Deepak U.', 'Swati I.', 'Gautam Z.', 'Priyanka X.', 'Arvind K.', 'Meghna S.', 'Rajesh P.', 'Fatima R.',
];
const HOMES = ['OLD', 'OLD', 'OLD', 'OLD', 'TECH', 'TECH', 'UNIV', 'UNIV', 'UNIV', 'UNIV', 'UNIV', 'HARB', 'HARB', 'HARB', 'HARB', 'HARB', 'HARB', 'HARB', 'HARB', 'MRKT', 'MRKT', 'MRKT', 'MRKT', 'MRKT', 'MRKT', 'AIRP', 'AIRP', 'AIRP', 'AIRP', 'AIRP'];
const CARS = [
  ['Maruti Dzire', 'White', 4], ['Hyundai Aura', 'Silver', 4], ['Toyota Etios', 'Grey', 4], ['Honda Amaze', 'Blue', 4], ['Tata Tigor EV', 'Teal', 4],
  ['Kia Carens', 'Black', 6], ['Maruti Ertiga', 'White', 6], ['Renault Kwid', 'Red', 3],
] as const;

export interface SeedOptions {
  now?: Date;
  historyDays?: number;
  historyRides?: boolean;
  preserveSessions?: boolean;
}

export const DEMO = {
  passenger: uid('user:priya'),
  passenger2: uid('user:rahul'),
  driverArjun: uid('user:arjun'),
  driverMeera: uid('user:meera'),
  operator: uid('user:kavya'),
  admin: uid('user:admin'),
};

export async function seedDatabase(db: Pool, opts: SeedOptions = {}) {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const rand = mulberry32(20261113);
  const sessions = opts.preserveSessions ? (await db.query(`select * from sessions where expires_at > now()`)).rows : [];
  await db.query(`truncate users, sessions, zones, vehicles, drivers, driver_locations, pool_groups, pool_members, rides, ride_events, dispatch_offers,
    dispatch_decisions, zone_demand_buckets, zone_pricing_state, reposition_recommendations, fleet_snapshots, idempotency_records, outbox_events, jobs,
    audit_log, demo_places restart identity cascade`);

  // zones + places
  for (const z of ZONES) {
    await db.query(
      `insert into zones (id, code, name, boundary, centroid, base_speed_kmh) values ($1,$2,$3, ST_GeogFromText($4), ST_Centroid(ST_GeomFromText($4,4326))::geography, $5)`,
      [uid(`zone:${z.code}`), z.code, z.name, `SRID=4326;${wkt(z.polygon)}`, z.speed],
    );
    await db.query(`insert into zone_pricing_state (zone_id) values ($1)`, [uid(`zone:${z.code}`)]);
  }
  await loadZones(db);
  for (const p of PLACES) {
    const pt = inZone(p.zone, p.fx, p.fy);
    await db.query(`insert into demo_places (label, location, zone_code) values ($1, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4)`, [p.label, pt.lng, pt.lat, p.zone]);
  }

  // people
  const users: [string, string, string, string, boolean][] = [
    [DEMO.passenger, 'priya@relay.demo', 'Priya Nair', 'PASSENGER', false],
    [DEMO.passenger2, 'rahul@relay.demo', 'Rahul Mehta', 'PASSENGER', false],
    [DEMO.driverArjun, 'arjun@relay.demo', 'Arjun Rao', 'DRIVER', false],
    [DEMO.driverMeera, 'meera@relay.demo', 'Meera Iyer', 'DRIVER', false],
    [DEMO.operator, 'kavya@relay.demo', 'Kavya Menon', 'OPERATOR', false],
    [DEMO.admin, 'admin@relay.demo', 'Demo Admin', 'ADMIN', false],
  ];
  BOT_NAMES.forEach((n, i) => users.push([uid(`user:bot-driver:${i}`), `sim-driver-${i}@relay.demo`, n, 'DRIVER', true]));
  for (let i = 0; i < 28; i++) users.push([uid(`user:bot-rider:${i}`), `sim-rider-${i}@relay.demo`, `Sim rider ${String(i + 1).padStart(2, '0')}`, 'PASSENGER', true]);
  await db.query(
    `insert into users (id, email, display_name, role, is_bot) select * from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::bool[])`,
    [users.map((u) => u[0]), users.map((u) => u[1]), users.map((u) => u[2]), users.map((u) => u[3]), users.map((u) => u[4])],
  );
  for (const s of sessions) await db.query(`insert into sessions values ($1,$2,$3,$4) on conflict do nothing`, [s.token, s.user_id, s.created_at, s.expires_at]);

  // fleet
  const hub = placePoint(DEMO_HUB);
  const humans = [
    { user: DEMO.driverArjun, car: ['Tata Nexon EV', 'Teal', 4] as const, plate: 'RL 01 AR 2041', pos: { lat: hub.lat + 0.0012, lng: hub.lng - 0.0042 }, idleMin: 14 },
    { user: DEMO.driverMeera, car: ['Hyundai Verna', 'Pearl White', 4] as const, plate: 'RL 01 MI 7720', pos: { lat: hub.lat - 0.0046, lng: hub.lng - 0.0035 }, idleMin: 3 },
  ];
  const fleet: { id: string; user: string; home: string; isBot: boolean }[] = [];
  const addDriver = async (key: string, user: string, car: readonly [string, string, number], plate: string, home: string, pos: LatLng, o: { bot: boolean; online: boolean; approved: boolean; frozen: boolean; idleMin: number; recv: number; acc: number; rating: number }) => {
    const vid = uid(`vehicle:${key}`), did = uid(`driver:${key}`);
    await db.query(`insert into vehicles (id, make_model, color, plate_label, seat_capacity) values ($1,$2,$3,$4,$5)`, [vid, car[0], car[1], plate, car[2]]);
    await db.query(
      `insert into drivers (id, user_id, vehicle_id, capacity, approval_status, availability_status, online_since, last_trip_ended_at, last_seen_at,
                            offers_received, offers_accepted, rating, is_bot, sim_gps_frozen, home_zone_id)
       values ($1,$2,$3,$4,$5,$6, case when $7 then now()-interval '2 hours' end, now()-make_interval(mins => $8), now(), $9,$10,$11,$12,$13,$14)`,
      [did, user, vid, car[2], o.approved ? 'APPROVED' : 'PENDING', o.online ? 'ONLINE' : 'OFFLINE', o.online, o.idleMin, o.recv, o.acc, o.rating, o.bot, o.frozen, uid(`zone:${home}`)],
    );
    await db.query(
      `insert into driver_locations (driver_id, location, heading, speed, accuracy_m, recorded_at, source)
       values ($1, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, 0, 0, 8, now() - make_interval(secs => $4), 'SIMULATED')`,
      [did, pos.lng, pos.lat, o.frozen ? 240 : 0],
    );
    fleet.push({ id: did, user, home, isBot: o.bot });
  };
  for (const [i, h] of humans.entries()) {
    await addDriver(`human:${i}`, h.user, h.car, h.plate, 'OLD', h.pos, { bot: false, online: true, approved: true, frozen: false, idleMin: h.idleMin, recv: 40, acc: 37 - i * 3, rating: 4.9 - i * 0.05 });
  }
  for (let i = 0; i < BOT_NAMES.length; i++) {
    const home = HOMES[i];
    let pos = inZone(home, 0.12 + rand() * 0.76, 0.12 + rand() * 0.76);
    if (home === 'OLD') pos = inZone('OLD', 0.08 + rand() * 0.3, 0.08 + rand() * 0.84); // keep Old Town bots west of the demo hub
    const car = i === 2 ? CARS[7] : CARS[i % 7];
    await addDriver(`bot:${i}`, uid(`user:bot-driver:${i}`), car, `RL ${String(10 + (i % 80)).padStart(2, '0')} SIM ${1000 + i * 37}`, home, pos, {
      bot: true,
      online: ![10, 17, 27].includes(i),
      approved: i !== 9,
      frozen: i === 13 || i === 21,
      idleMin: Math.round(rand() * 28),
      recv: 30 + Math.round(rand() * 40),
      acc: 0,
      rating: 4.5 + Math.round(rand() * 45) / 100,
    });
    await db.query(`update drivers set offers_accepted = round(offers_received * $2::float8) where id=$1`, [uid(`driver:bot:${i}`), 0.7 + rand() * 0.28]);
  }

  // demand history (simulated) + one-step-ahead backtest forecasts
  const days = opts.historyDays ?? 21;
  const cur = Math.floor(nowMs / BUCKET) * BUCKET;
  const start = cur - days * DAY;
  for (const z of ZONES) {
    const zid = uid(`zone:${z.code}`);
    const series: Series = new Map();
    for (let t = start; t < cur; t += BUCKET) series.set(t, simulatedActual(z.code, t));
    const ts: Date[] = [], acts: number[] = [], fc: (number | null)[] = [], lo: (number | null)[] = [], hi: (number | null)[] = [], av: (number | null)[] = [];
    for (let t = start; t < cur; t += BUCKET) {
      const f = t >= cur - 8 * DAY ? forecast(series, t, t - BUCKET, BUCKET) : null;
      ts.push(new Date(t));
      acts.push(series.get(t)!);
      fc.push(f?.value ?? null);
      lo.push(f?.low ?? null);
      hi.push(f?.high ?? null);
      av.push(Math.max(0, Math.round((z.code === 'TECH' ? 2 : 5) + Math.sin(t / 3.6e6) * 1.5)));
    }
    await db.query(
      `insert into zone_demand_buckets (zone_id, bucket_start, actual_requests, forecast_requests, forecast_low, forecast_high, available_driver_count, forecast_model)
       select $1, * , $8 from unnest($2::timestamptz[], $3::int[], $4::numeric[], $5::numeric[], $6::numeric[], $7::int[])`,
      [zid, ts, acts, fc, lo, hi, av, MODEL_NAME],
    );
  }

  // historical rides (simulated) for analytics
  if (opts.historyRides !== false) {
    const routing = new MockGridRouting(() => now);
    const bots = fleet.filter((f) => f.isBot);
    const riders = Array.from({ length: 28 }, (_, i) => uid(`user:bot-rider:${i}`));
    const cols: Record<string, unknown[]> = { id: [], pas: [], status: [], plng: [], plat: [], dlng: [], dlat: [], pl: [], dl: [], pz: [], dz: [], fare: [], fin: [], fb: [], ets: [], etm: [], eta: [], req: [], acc: [], pu: [], st: [], co: [], ca: [], drv: [], oc: [], cby: [] };
    let n = 0;
    for (let t = cur - 3 * DAY; t < cur - 30 * 60_000; t += BUCKET) {
      for (const z of ZONES) {
        const k = Math.round(simulatedActual(z.code, t) / 22 + (rand() < 0.25 ? 1 : 0) - 0.3);
        for (let j = 0; j < k; j++) {
          const dz = ZONES[Math.floor(rand() * ZONES.length)];
          const p = inZone(z.code, 0.1 + rand() * 0.8, 0.1 + rand() * 0.8), d = inZone(dz.code, 0.1 + rand() * 0.8, 0.1 + rand() * 0.8);
          const route = routing.estimate(p, d);
          const fare = computeFare({ distanceM: route.distanceM, durationS: route.durationS, surgeMultiplier: rand() < 0.15 ? 1.2 : 1, provider: route.provider, fallback: false });
          const req = t + rand() * BUCKET;
          const roll = rand();
          const status = roll < 0.06 ? 'NO_DRIVER' : roll < 0.14 ? 'CANCELLED' : 'COMPLETED';
          const offers = status === 'NO_DRIVER' ? 3 + Math.floor(rand() * 3) : rand() < 0.22 ? 2 + Math.floor(rand() * 2) : 1;
          const r2a = 4 + rand() * 12 + (offers - 1) * (8 + rand() * 14);
          const eta = Math.round(120 + rand() * 420 + (z.code === 'TECH' ? 120 : 0));
          const acc = status === 'NO_DRIVER' ? null : req + r2a * 1000;
          cols.id.push(uid(`hist:${n++}`));
          cols.pas.push(riders[Math.floor(rand() * riders.length)]);
          cols.status.push(status);
          cols.plng.push(p.lng); cols.plat.push(p.lat); cols.dlng.push(d.lng); cols.dlat.push(d.lat);
          cols.pl.push(`${z.name} · street pickup`); cols.dl.push(`${dz.name} · drop-off`);
          cols.pz.push(uid(`zone:${z.code}`)); cols.dz.push(uid(`zone:${dz.code}`));
          cols.fare.push(fare.totalMinor);
          cols.fin.push(status === 'COMPLETED' ? fare.totalMinor : status === 'CANCELLED' ? 0 : null);
          cols.fb.push(JSON.stringify(fare));
          cols.ets.push(route.durationS); cols.etm.push(route.distanceM);
          cols.eta.push(acc ? eta : null);
          cols.req.push(new Date(req));
          cols.acc.push(acc ? new Date(acc) : null);
          cols.pu.push(status === 'COMPLETED' ? new Date(acc! + eta * 1000) : null);
          cols.st.push(status === 'COMPLETED' ? new Date(acc! + eta * 1000 + 60_000) : null);
          cols.co.push(status === 'COMPLETED' ? new Date(acc! + eta * 1000 + 60_000 + route.durationS * 1000) : null);
          cols.ca.push(status === 'CANCELLED' ? new Date(req + 90_000) : null);
          cols.drv.push(acc ? bots[Math.floor(rand() * bots.length)].id : null);
          cols.oc.push(offers);
          cols.cby.push(status === 'CANCELLED' ? 'PASSENGER' : null);
        }
      }
    }
    await db.query(
      `insert into rides (id, passenger_id, status, pickup, destination, pickup_label, destination_label, pickup_zone_id, destination_zone_id, quoted_fare_minor,
                          final_fare_minor, fare_breakdown, est_trip_seconds, est_trip_meters, pickup_eta_seconds, requested_at, accepted_at, pickup_at, started_at,
                          completed_at, cancelled_at, assigned_driver_id, offer_count, cancelled_by, is_history, created_at)
       select id, pas, status, ST_SetSRID(ST_MakePoint(plng, plat),4326)::geography, ST_SetSRID(ST_MakePoint(dlng, dlat),4326)::geography, pl, dl, pz, dz, fare,
              fin, fb::jsonb, ets, etm, eta, req, acc, pu, st, co, ca, drv, oc, cby, true, req
         from unnest($1::uuid[], $2::uuid[], $3::text[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::text[], $9::text[], $10::uuid[], $11::uuid[],
                     $12::int[], $13::int[], $14::text[], $15::int[], $16::int[], $17::int[], $18::timestamptz[], $19::timestamptz[], $20::timestamptz[],
                     $21::timestamptz[], $22::timestamptz[], $23::timestamptz[], $24::uuid[], $25::int[], $26::text[])
           as t(id, pas, status, plng, plat, dlng, dlat, pl, dl, pz, dz, fare, fin, fb, ets, etm, eta, req, acc, pu, st, co, ca, drv, oc, cby)`,
      [cols.id, cols.pas, cols.status, cols.plng, cols.plat, cols.dlng, cols.dlat, cols.pl, cols.dl, cols.pz, cols.dz, cols.fare, cols.fin, cols.fb, cols.ets, cols.etm, cols.eta, cols.req, cols.acc, cols.pu, cols.st, cols.co, cols.ca, cols.drv, cols.oc, cols.cby],
    );
    // fleet utilisation snapshots (simulated), every 30 min
    const ts: Date[] = [], on: number[] = [], busy: number[] = [], avail: number[] = [];
    for (let t = cur - 3 * DAY; t < cur; t += 30 * 60_000) {
      const demand = ZONES.reduce((a, z) => a + simulatedActual(z.code, Math.floor(t / BUCKET) * BUCKET), 0);
      const online = 22 + Math.round(rand() * 6);
      const b = Math.min(online, Math.round(online * Math.min(0.92, 0.18 + demand / 110)));
      ts.push(new Date(t)); on.push(online); busy.push(b); avail.push(online - b);
    }
    await db.query(`insert into fleet_snapshots (ts, online, busy, available) select * from unnest($1::timestamptz[], $2::int[], $3::int[], $4::int[])`, [ts, on, busy, avail]);
  }
  await seedPoolScenario(db);
  return { users: users.length, drivers: fleet.length };
}

/**
 * Three in-progress, pool-opted-in rides near the demo hub (all simulated riders):
 *  A — compatible (heading east toward Orbit Towers)        → offered as a shared ride
 *  B — short trip north to Fort Gate                         → rejected: co-rider detour limit
 *  C — 3 riders in a 3-seat car heading east                 → rejected: capacity
 */
export async function seedPoolScenario(db: Pool) {
  const hub = placePoint(DEMO_HUB);
  await db.query(`update rides set status='COMPLETED', completed_at=now(), final_fare_minor=quoted_fare_minor, version=version+1 where status in ('ACCEPTED','ARRIVING','ONGOING') and id in (select ride_id from ride_events where event_type='SCENARIO_SEEDED')`);
  const routing = new MockGridRouting();
  const mk = async (key: string, botIdx: number, riderIdx: number, pickup: LatLng, dest: LatLng, destLabel: string, seats: number, driverPos: LatLng, status: 'ACCEPTED' | 'ONGOING') => {
    const driverId = uid(`driver:bot:${botIdx}`);
    const busy = await db.query(`select 1 from rides where assigned_driver_id=$1 and status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION')`, [driverId]);
    const offer = await db.query(`select 1 from dispatch_offers where driver_id=$1 and status='PENDING'`, [driverId]);
    const rider = uid(`user:bot-rider:${riderIdx}`);
    const riderBusy = await db.query(`select 1 from rides where passenger_id=$1 and status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING','ONGOING','EXCEPTION')`, [rider]);
    if (busy.rowCount || offer.rowCount || riderBusy.rowCount) return null;
    const route = routing.estimate(pickup, dest);
    const fare = computeFare({ distanceM: route.distanceM, durationS: route.durationS, surgeMultiplier: 1, provider: route.provider, fallback: false });
    const { rows } = await db.query(
      `insert into rides (passenger_id, status, pickup, pickup_label, destination, destination_label, pickup_zone_id, destination_zone_id, seats, pool_opt_in,
                          quoted_fare_minor, fare_breakdown, est_trip_seconds, est_trip_meters, pickup_eta_seconds, requested_at, accepted_at, started_at, pickup_at, assigned_driver_id, offer_count)
       values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography, $8,
               (select id from zones where ST_Covers(boundary, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) limit 1),
               (select id from zones where ST_Covers(boundary, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography) limit 1),
               $9, true, $10, $11, $12, $13, 90, now()-interval '50 seconds', now()-interval '40 seconds', case when $2='ONGOING' then now()-interval '10 seconds' end,
               case when $2='ONGOING' then now()-interval '15 seconds' end, $14, 1) returning id`,
      [rider, status, pickup.lng, pickup.lat, `Shared-ride scenario ${key} · pickup`, dest.lng, dest.lat, destLabel, seats, fare.totalMinor, JSON.stringify(fare), route.durationS, route.distanceM, driverId],
    );
    await db.query(`insert into ride_events (ride_id, event_type, to_status, actor_type, reason_code, metadata) values ($1,'SCENARIO_SEEDED',$2,'SYSTEM','DEMO_SCENARIO',$3)`, [rows[0].id, status, JSON.stringify({ scenario: key })]);
    await db.query(`update driver_locations set location=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, recorded_at=now() where driver_id=$1`, [driverId, driverPos.lng, driverPos.lat]);
    await db.query(`update drivers set availability_status='ONLINE', sim_gps_frozen=false where id=$1`, [driverId]);
    return rows[0].id as string;
  };
  const orbit = placePoint('Orbit Towers');
  const a = await mk('A', 0, 0, { lat: hub.lat + 0.0006, lng: hub.lng - 0.006 }, { lat: orbit.lat + 0.001, lng: orbit.lng + 0.002 }, 'Innovation Plaza (east)', 1, { lat: hub.lat + 0.0006, lng: hub.lng - 0.0058 }, 'ONGOING');
  const b = await mk('B', 1, 1, { lat: hub.lat + 0.004, lng: hub.lng - 0.003 }, placePoint('Fort Gate'), 'Fort Gate', 1, { lat: hub.lat + 0.004, lng: hub.lng - 0.0028 }, 'ONGOING');
  const c = await mk('C', 2, 2, { lat: hub.lat - 0.0015, lng: hub.lng - 0.005 }, placePoint('Innovation Plaza'), 'Innovation Plaza', 3, { lat: hub.lat - 0.0015, lng: hub.lng - 0.0048 }, 'ONGOING');
  return { compatible: a, detour: b, capacity: c };
}
