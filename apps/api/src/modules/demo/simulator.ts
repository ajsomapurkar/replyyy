import type { LatLng } from '@relay/contracts';
import type { Ctx } from '../../common/context.js';
import { tx } from '../../database/db.js';
import { config } from '../../config.js';
import { logger } from '../../common/logger.js';
import { haversineM, stepAlongGrid } from '../../common/geo.js';
import { hashUnit, mulberry32 } from '../../common/prng.js';
import { acceptOffer, rejectOffer } from '../dispatch/dispatch.service.js';
import { cancelRide, createRide, driverStep, retryRide, type AuthUser } from '../rides/rides.service.js';
import { batchUpdateLocations } from '../drivers/drivers.service.js';
import { congestionFactor } from '../routing/routing.js';
import { getZones, zoneForPoint } from '../zones/zones.cache.js';
import { DEMO_HUB, HUB_EXCLUSION_M, inZone, placePoint } from '../../seed/city.js';
import { demandRate } from '../../seed/demand-model.js';
import type { Gateway } from '../../gateway/gateway.js';
import type { PoolStop } from '../pooling/insertion.js';

const ARRIVE_M = 35;

/**
 * Demo simulator: moves drivers along the mock street grid, makes bot drivers answer offers and
 * progress trips through the SAME service calls a human would, and generates background demand.
 * Human demo drivers move automatically (simulated GPS) but every state change waits for their button.
 */
export class Simulator {
  private timer: NodeJS.Timeout | null = null;
  private last = Date.now();
  private wander = new Map<string, LatLng>();
  private arrivedAt = new Map<string, number>();
  private lastDemand = 0;
  private lastSnapshot = 0;
  private retried = new Set<string>();
  private rand = mulberry32(7);
  private busy = false;
  backgroundDemand = config.simulation.backgroundDemandEnabled;
  lastTickAt = 0;

  constructor(private ctx: Ctx, private gateway: Gateway | null) {}

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => logger.error('sim.tick', { error: String(e?.stack ?? e) })), config.simulation.tickMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private botUser(r: { user_id: string; id: string }): AuthUser {
    return { id: r.user_id, role: 'DRIVER', displayName: 'bot', driverId: r.id, isBot: true };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      const dt = Math.min(3, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.lastTickAt = now;
      await this.moveFleet(dt, now);
      await this.botOffers(now);
      await this.botPassengers();
      if (this.backgroundDemand && now - this.lastDemand > config.simulation.backgroundDemandIntervalMs) {
        this.lastDemand = now;
        await this.spawnBackgroundRide().catch((e) => logger.debug('sim.spawn_skipped', { error: String(e?.message ?? e) }));
      }
      if (now - this.lastSnapshot > 30_000) {
        this.lastSnapshot = now;
        await this.snapshot();
      }
    } finally {
      this.busy = false;
    }
  }

  private async moveFleet(dt: number, now: number) {
    const { rows: drivers } = await this.ctx.db.query(
      `select d.id, d.user_id, d.is_bot, d.sim_gps_frozen, d.availability_status, z.code home,
              ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng
         from drivers d join driver_locations l on l.driver_id=d.id left join zones z on z.id=d.home_zone_id`,
    );
    const { rows: rides } = await this.ctx.db.query(
      `select r.id, r.status, r.assigned_driver_id, r.pool_group_id, r.seats, g.stop_plan,
              ST_Y(r.pickup::geometry) p_lat, ST_X(r.pickup::geometry) p_lng, ST_Y(r.destination::geometry) d_lat, ST_X(r.destination::geometry) d_lng
         from rides r left join pool_groups g on g.id=r.pool_group_id and g.status='ACTIVE'
        where r.status in ('ACCEPTED','ARRIVING','ONGOING') order by r.accepted_at`,
    );
    const { rows: recs } = await this.ctx.db.query(
      `select r.id, r.driver_id, r.status, ST_Y(z.centroid::geometry) lat, ST_X(z.centroid::geometry) lng
         from reposition_recommendations r join zones z on z.id=r.to_zone_id where r.status in ('ACTIVE','ACCEPTED')`,
    );
    const byDriver = new Map<string, any[]>();
    rides.forEach((r) => byDriver.set(r.assigned_driver_id, [...(byDriver.get(r.assigned_driver_id) ?? []), r]));
    const hub = placePoint(DEMO_HUB);
    const updates: { driverId: string; lat: number; lng: number; heading: number; speed: number }[] = [];
    const actions: (() => Promise<unknown>)[] = [];

    for (const d of drivers) {
      if (d.availability_status !== 'ONLINE' || d.sim_gps_frozen) continue;
      const pos = { lat: d.lat, lng: d.lng };
      const mine = byDriver.get(d.id) ?? [];
      let target: LatLng | null = null;
      let stop: PoolStop | null = null;
      if (mine.length) {
        const plan: PoolStop[] = mine[0].stop_plan
          ? (mine[0].stop_plan as PoolStop[]).filter((s) => mine.some((r) => r.id === s.rideId && !(s.kind === 'PICKUP' && r.status === 'ONGOING')))
          : mine.flatMap<PoolStop>((r) =>
              r.status === 'ONGOING'
                ? [{ rideId: r.id, kind: 'DROPOFF' as const, point: { lat: r.d_lat, lng: r.d_lng }, seats: r.seats }]
                : [{ rideId: r.id, kind: 'PICKUP' as const, point: { lat: r.p_lat, lng: r.p_lng }, seats: r.seats }],
            );
        stop = plan[0] ?? null;
        target = stop?.point ?? null;
      } else {
        const rec = recs.find((r) => r.driver_id === d.id);
        if (rec && d.is_bot && rec.status === 'ACTIVE' && hashUnit(rec.id) < 0.5) {
          actions.push(() => this.ctx.db.query(`update reposition_recommendations set status='ACCEPTED' where id=$1 and status='ACTIVE'`, [rec.id]));
        }
        if (rec && (rec.status === 'ACCEPTED' || (d.is_bot && hashUnit(rec.id) < 0.5))) {
          target = { lat: rec.lat, lng: rec.lng };
          if (haversineM(pos, target) < 150) actions.push(() => this.ctx.db.query(`update reposition_recommendations set status='EXPIRED' where id=$1`, [rec.id]));
        } else if (d.is_bot) {
          let w = this.wander.get(d.id);
          if (!w || haversineM(pos, w) < 40) {
            for (let k = 0; k < 8; k++) {
              w = inZone(d.home ?? 'MRKT', 0.1 + this.rand() * 0.8, 0.1 + this.rand() * 0.8);
              if (haversineM(w, hub) > HUB_EXCLUSION_M) break;
            }
            this.wander.set(d.id, w!);
          }
          target = w!;
        }
      }
      let next = pos, heading = 0, speed = 0;
      if (target) {
        const kmh = (zoneForPoint(pos)?.baseSpeedKmh ?? 22) * congestionFactor(new Date(now)) * (mine.length ? 1 : 0.5);
        const step = stepAlongGrid(pos, target, (kmh / 3.6) * config.simulation.speed * dt);
        next = step.pos;
        heading = step.heading;
        speed = kmh / 3.6;
      }
      updates.push({ driverId: d.id, lat: next.lat, lng: next.lng, heading, speed });

      if (d.is_bot && stop && haversineM(next, stop.point) <= ARRIVE_M) {
        const ride = mine.find((r) => r.id === stop!.rideId);
        const u = this.botUser(d);
        if (stop.kind === 'PICKUP' && ride?.status === 'ACCEPTED') {
          this.arrivedAt.set(ride.id, now);
          actions.push(() => driverStep(this.ctx, u, ride.id, 'arriving'));
        } else if (stop.kind === 'PICKUP' && ride?.status === 'ARRIVING' && now - (this.arrivedAt.get(ride.id) ?? 0) > 2500) {
          actions.push(() => driverStep(this.ctx, u, ride.id, 'start'));
        } else if (stop.kind === 'DROPOFF' && ride?.status === 'ONGOING') {
          actions.push(() => driverStep(this.ctx, u, ride.id, 'complete'));
        }
      }
    }
    await batchUpdateLocations(this.ctx, updates);
    for (const a of actions) await a().catch((e) => logger.debug('sim.action_failed', { error: String(e?.message ?? e) }));
    if (this.gateway) {
      const { rows: pd } = await this.ctx.db.query(`select passenger_id, assigned_driver_id from rides where status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION')`);
      this.gateway.setPassengerDrivers(new Map(pd.map((r) => [r.passenger_id, r.assigned_driver_id])));
      this.gateway.broadcastLocations(updates);
    }
  }

  /** Bot drivers answer offers after 2–6 s; ~7% never answer (timeout path), the rest accept by reliability. */
  private async botOffers(now: number) {
    const { rows } = await this.ctx.db.query(
      `select o.id, o.offered_at, o.eta_seconds, d.id driver_id, d.user_id from dispatch_offers o join drivers d on d.id=o.driver_id
        where o.status='PENDING' and d.is_bot`,
    );
    for (const o of rows) {
      if (hashUnit(`${o.id}:timeout`) < 0.07) continue;
      const delay = 2000 + hashUnit(o.id) * 4000;
      if (now - new Date(o.offered_at).getTime() < delay) continue;
      const pAccept = (o.eta_seconds ?? 0) > 600 ? 0.6 : 0.86;
      const u = this.botUser({ id: o.driver_id, user_id: o.user_id });
      try {
        if (hashUnit(`${o.id}:accept`) < pAccept) await acceptOffer(this.ctx, o.id, o.user_id);
        else await rejectOffer(this.ctx, o.id, u.id, 'Simulated driver declined');
      } catch (e: any) {
        logger.debug('sim.offer_response_failed', { offerId: o.id, error: String(e?.message ?? e) });
      }
    }
  }

  /** Simulated riders: retry or give up after NO_DRIVER, and lose patience during long searches. */
  private async botPassengers() {
    const { rows } = await this.ctx.db.query(
      `select r.id, r.status, r.passenger_id, r.exception_reason, extract(epoch from now()-r.updated_at) age, extract(epoch from now()-r.requested_at) total
         from rides r join users u on u.id=r.passenger_id
        where u.is_bot and not r.is_history and r.status in ('NO_DRIVER','DISPATCHING','REASSIGNING','ACCEPTED')`,
    );
    for (const r of rows) {
      const user: AuthUser = { id: r.passenger_id, role: 'PASSENGER', displayName: 'bot', isBot: true };
      try {
        if (r.status === 'NO_DRIVER' && r.age > 8 && r.total < 1800) {
          if (!this.retried.has(r.id) && hashUnit(`${r.id}:retry`) < 0.5) {
            this.retried.add(r.id);
            await retryRide(this.ctx, user, r.id);
          }
        } else if ((r.status === 'DISPATCHING' || r.status === 'REASSIGNING') && r.total > 75 && hashUnit(`${r.id}:patience`) < 0.6) {
          await cancelRide(this.ctx, user, r.id, 'Simulated rider gave up waiting');
        } else if (r.status === 'ACCEPTED' && r.exception_reason === 'DELAYED_ARRIVAL' && r.age > 10 && hashUnit(`${r.id}:late`) < 0.3) {
          await cancelRide(this.ctx, user, r.id, 'Simulated rider cancelled: driver late');
        }
      } catch {}
    }
  }

  async spawnBackgroundRide() {
    const zones = getZones();
    const now = Date.now();
    const w = zones.map((z) => demandRate(z.code, now));
    const pick = () => {
      let x = this.rand() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < zones.length; i++) if ((x -= w[i]) <= 0) return zones[i];
      return zones[0];
    };
    const zp = pick();
    let zd = pick();
    if (zd.id === zp.id && this.rand() < 0.6) zd = zones[(zones.indexOf(zp) + 1 + Math.floor(this.rand() * 5)) % zones.length];
    const { rows } = await this.ctx.db.query(
      `select u.id from users u where u.is_bot and u.role='PASSENGER'
          and not exists(select 1 from rides r where r.passenger_id=u.id and r.status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING','ONGOING','EXCEPTION'))
        order by random() limit 1`,
    );
    if (!rows[0]) return;
    const user: AuthUser = { id: rows[0].id, role: 'PASSENGER', displayName: 'bot', isBot: true };
    let pickup = inZone(zp.code, 0.12 + this.rand() * 0.76, 0.12 + this.rand() * 0.76);
    const dest = inZone(zd.code, 0.12 + this.rand() * 0.76, 0.12 + this.rand() * 0.76);
    if (haversineM(pickup, placePoint(DEMO_HUB)) < 700) pickup = inZone(zp.code, 0.2, 0.25);
    if (haversineM(pickup, dest) < 400) return;
    await tx(this.ctx.db, (c) =>
      createRide(this.ctx, c, user, {
        pickup,
        pickupLabel: `${zp.name} · street pickup`,
        destination: dest,
        destinationLabel: `${zd.name} · drop-off`,
        seats: this.rand() < 0.1 ? 2 : 1,
        poolOptIn: this.rand() < 0.3,
      }),
    );
  }

  private async snapshot() {
    await this.ctx.db.query(
      `insert into fleet_snapshots (ts, online, busy, available)
       select date_trunc('second', now()),
              count(*) filter (where d.availability_status='ONLINE'),
              count(*) filter (where d.availability_status='ONLINE' and exists(select 1 from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING'))),
              count(*) filter (where d.availability_status='ONLINE' and not exists(select 1 from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING')))
         from drivers d on conflict do nothing`,
    );
  }
}
