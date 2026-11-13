import type { Ctx } from '../../common/context.js';
import { config } from '../../config.js';
import { pointInPolygon } from '../../common/geo.js';
import { emit } from '../notifications/outbox.js';
import { simulatedActual } from '../../seed/demand-model.js';
import { errorMetrics, expectedGap, forecast, MODEL_NAME, type Series } from '../forecasting/baseline.js';
import { nextMultiplier } from '../pricing/surge.js';
import { computeFare } from '../pricing/fare.js';
import { getZones, zoneForPoint, type ZoneInfo } from './zones.cache.js';
import { haversineM } from '../../common/geo.js';
import { notFound } from '../../common/errors.js';

const BUCKET = config.zones.bucketMinutes * 60_000;
export const floorBucket = (t: number) => Math.floor(t / BUCKET) * BUCKET;

export async function loadSeries(ctx: Ctx, fromMs: number): Promise<Map<string, Series>> {
  const { rows } = await ctx.db.query(`select zone_id, bucket_start, actual_requests from zone_demand_buckets where bucket_start >= $1 and actual_requests is not null`, [new Date(fromMs)]);
  const out = new Map<string, Series>();
  for (const r of rows) {
    if (!out.has(r.zone_id)) out.set(r.zone_id, new Map());
    out.get(r.zone_id)!.set(new Date(r.bucket_start).getTime(), r.actual_requests);
  }
  return out;
}

/** Idle, dispatchable supply per zone right now. */
export async function availableByZone(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select d.id, d.is_bot, ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng from drivers d join driver_locations l on l.driver_id=d.id
      where d.availability_status='ONLINE' and d.approval_status='APPROVED' and l.recorded_at > now()-make_interval(secs => $1)
        and not exists(select 1 from rides r where r.assigned_driver_id=d.id and r.status in ('ACCEPTED','ARRIVING','ONGOING','EXCEPTION'))
        and not exists(select 1 from dispatch_offers o where o.driver_id=d.id and o.status='PENDING')`,
    [config.dispatch.staleLocationSeconds],
  );
  const by = new Map<string, { id: string; lat: number; lng: number; isBot: boolean }[]>();
  for (const r of rows) {
    const z = zoneForPoint(r);
    if (z) by.set(z.id, [...(by.get(z.id) ?? []), { id: r.id, lat: r.lat, lng: r.lng, isBot: r.is_bot }]);
  }
  return by;
}

/** Periodic zone cycle: simulated actuals → forecasts → supply → bounded surge → advisory repositioning. */
export async function runZoneCycle(ctx: Ctx) {
  const now = Date.now();
  const cur = floorBucket(now);
  const zones = getZones();
  // 1) simulated actuals for elapsed buckets (current bucket counts only the elapsed fraction)
  const { rows: last } = await ctx.db.query(`select zone_id, max(bucket_start) m from zone_demand_buckets where actual_requests is not null group by zone_id`);
  const lastBy = new Map(last.map((r) => [r.zone_id, new Date(r.m).getTime()]));
  for (const z of zones) {
    const from = Math.min(lastBy.get(z.id) ?? cur - 4 * BUCKET, cur);
    for (let t = from; t <= cur; t += BUCKET) {
      const full = simulatedActual(z.code, t);
      const v = t === cur ? Math.round(full * ((now - cur) / BUCKET)) : full;
      await ctx.db.query(
        `insert into zone_demand_buckets (zone_id, bucket_start, actual_requests) values ($1,$2,$3)
         on conflict (zone_id, bucket_start) do update set actual_requests=excluded.actual_requests`,
        [z.id, new Date(t), v],
      );
    }
  }
  // 2) forecasts for the next 4 buckets from origin = current bucket
  const series = await loadSeries(ctx, cur - 15 * 86_400_000);
  const supply = await availableByZone(ctx);
  const summary: any[] = [];
  for (const z of zones) {
    const s = series.get(z.id) ?? new Map();
    s.delete(cur); // partial bucket is not used as history
    for (let k = 1; k <= 4; k++) {
      const t = cur + k * BUCKET;
      const f = forecast(s, t, cur, BUCKET);
      if (!f) continue;
      await ctx.db.query(
        `insert into zone_demand_buckets (zone_id, bucket_start, forecast_requests, forecast_low, forecast_high, forecast_model)
         values ($1,$2,$3,$4,$5,$6) on conflict (zone_id, bucket_start) do update set forecast_requests=excluded.forecast_requests,
         forecast_low=excluded.forecast_low, forecast_high=excluded.forecast_high, forecast_model=excluded.forecast_model`,
        [z.id, new Date(t), f.value, f.low, f.high, MODEL_NAME],
      );
    }
    const available = supply.get(z.id)?.length ?? 0;
    await ctx.db.query(`update zone_demand_buckets set available_driver_count=$3 where zone_id=$1 and bucket_start=$2`, [z.id, new Date(cur), available]);
    const next = forecast(s, cur + BUCKET, cur, BUCKET)?.value ?? 0;
    const ratio = next / Math.max(1, available * config.zones.serviceCapacityFactor);
    const { rows: ps } = await ctx.db.query(`select multiplier from zone_pricing_state where zone_id=$1`, [z.id]);
    const { multiplier, target } = nextMultiplier(ps[0]?.multiplier ?? 1, ratio);
    await ctx.db.query(
      `insert into zone_pricing_state (zone_id, multiplier, target_multiplier, demand_supply_ratio, updated_at) values ($1,$2,$3,$4,now())
       on conflict (zone_id) do update set multiplier=$2, target_multiplier=$3, demand_supply_ratio=$4, updated_at=now()`,
      [z.id, multiplier, target, Number(ratio.toFixed(3))],
    );
    summary.push({ zone: z, next, available, gap: expectedGap(next, available, config.zones.serviceCapacityFactor) });
  }
  await recommendRepositioning(ctx, summary, supply);
  await emit(ctx.db, 'zone.forecast_updated', 'zones', Math.floor(now / 1000), { at: new Date(now).toISOString() }, {});
}

async function recommendRepositioning(ctx: Ctx, summary: { zone: ZoneInfo; next: number; available: number; gap: number }[], supply: Map<string, { id: string; lat: number; lng: number; isBot: boolean }[]>) {
  const cf = config.zones.serviceCapacityFactor;
  await ctx.db.query(`update reposition_recommendations set status='EXPIRED' where status in ('ACTIVE','ACCEPTED') and expires_at < now()`);
  const { rows: busy } = await ctx.db.query(`select driver_id from reposition_recommendations where status in ('ACTIVE','ACCEPTED')`);
  const taken = new Set(busy.map((b) => b.driver_id));
  const deficits = summary.filter((s) => s.gap >= 1).sort((a, b) => b.gap - a.gap);
  const surplus = summary.filter((s) => s.available * cf - s.next >= cf);
  for (const d of deficits) {
    let gap = d.gap;
    const want = Math.min(3, Math.ceil(gap / cf));
    const pool = surplus.flatMap((s) => {
      const spare = Math.floor((s.available * cf - s.next) / cf);
      return (supply.get(s.zone.id) ?? []).filter((x) => !taken.has(x.id)).slice(0, Math.max(0, spare)).map((x) => ({ ...x, from: s.zone }));
    });
    pool.sort((a, b) => haversineM(a, d.zone.centroid) - haversineM(b, d.zone.centroid));
    for (const cand of pool.slice(0, want)) {
      const route = await ctx.routing.route(cand, d.zone.centroid);
      const after = Math.max(0, gap - cf);
      const reason = `Forecast supply gap in ${config.zones.horizonMinutes} min: ~${Math.round(d.next)} pickup requests expected in ${d.zone.name} vs ${d.available} available driver${d.available === 1 ? '' : 's'}. ${cand.from.name} has spare supply.`;
      const { rows } = await ctx.db.query(
        `insert into reposition_recommendations (driver_id, from_zone_id, to_zone_id, reason, distance_m, travel_seconds, gap_before, gap_after, horizon_minutes, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()+make_interval(mins => $10)) on conflict do nothing returning id`,
        [cand.id, cand.from.id, d.zone.id, reason, route.distanceM, route.durationS, gap.toFixed(1), after.toFixed(1), config.zones.horizonMinutes, config.zones.recommendationTtlMinutes],
      );
      if (!rows[0]) continue;
      taken.add(cand.id);
      gap = after;
      const { rows: u } = await ctx.db.query(`select user_id from drivers where id=$1`, [cand.id]);
      await emit(ctx.db, 'zone.reposition_recommended', d.zone.id, Date.now(), { recommendationId: rows[0].id, driverId: cand.id, toZoneId: d.zone.id }, { userIds: [u[0].user_id] });
    }
  }
}

const confidenceLabel = (wape: number | null) => (wape === null ? 'Unknown' : wape < 0.2 ? 'High' : wape < 0.35 ? 'Medium' : 'Low');

export async function zonesOverview(ctx: Ctx) {
  const cur = floorBucket(Date.now());
  const supply = await availableByZone(ctx);
  const { rows } = await ctx.db.query(
    `select z.id, b_next.forecast_requests nf, b_next.forecast_low nl, b_next.forecast_high nh, b_cur.actual_requests ca, p.multiplier, p.demand_supply_ratio,
            (select count(*) from rides r where r.pickup_zone_id=z.id and r.requested_at > now()-interval '15 minutes' and not r.is_history) live_requests,
            (select count(*) from reposition_recommendations rr where rr.to_zone_id=z.id and rr.status in ('ACTIVE','ACCEPTED')) recs
       from zones z left join zone_demand_buckets b_next on b_next.zone_id=z.id and b_next.bucket_start=$1
       left join zone_demand_buckets b_cur on b_cur.zone_id=z.id and b_cur.bucket_start=$2
       left join zone_pricing_state p on p.zone_id=z.id where z.active`,
    [new Date(cur + BUCKET), new Date(cur)],
  );
  const { rows: online } = await ctx.db.query(
    `select ST_Y(l.location::geometry) lat, ST_X(l.location::geometry) lng from drivers d join driver_locations l on l.driver_id=d.id where d.availability_status='ONLINE'`,
  );
  const errs = await forecastErrorByZone(ctx, Date.now() - 7 * 86_400_000, cur);
  return getZones().map((z) => {
    const r = rows.find((x) => x.id === z.id) ?? {};
    const available = supply.get(z.id)?.length ?? 0;
    const next = Number(r.nf ?? 0);
    const err = errs.get(z.id) ?? { mae: null, wape: null, n: 0 };
    return {
      id: z.id,
      code: z.code,
      name: z.name,
      polygon: z.polygon,
      centroid: z.centroid,
      forecastNext: { value: next, low: Number(r.nl ?? 0), high: Number(r.nh ?? 0), bucketStart: new Date(cur + BUCKET).toISOString() },
      actualCurrentPartial: r.ca ?? 0,
      liveDemoRequests15m: Number(r.live_requests ?? 0),
      availableDrivers: available,
      onlineDrivers: online.filter((o) => pointInPolygon(o, z.polygon)).length,
      expectedGap: Number(expectedGap(next, available, config.zones.serviceCapacityFactor).toFixed(1)),
      surgeMultiplier: Number(r.multiplier ?? 1),
      demandSupplyRatio: Number(r.demand_supply_ratio ?? 0),
      activeRecommendations: Number(r.recs ?? 0),
      forecastError: err,
      confidence: confidenceLabel(err.wape),
      model: MODEL_NAME,
      simulated: true,
    };
  });
}

export async function forecastErrorByZone(ctx: Ctx, fromMs: number, toMs: number, zoneId?: string) {
  const { rows } = await ctx.db.query(
    `select zone_id, actual_requests a, forecast_requests f from zone_demand_buckets
      where bucket_start >= $1 and bucket_start < $2 and actual_requests is not null and forecast_requests is not null ${zoneId ? 'and zone_id=$3' : ''}`,
    zoneId ? [new Date(fromMs), new Date(toMs), zoneId] : [new Date(fromMs), new Date(toMs)],
  );
  const by = new Map<string, { actual: number; forecast: number }[]>();
  rows.forEach((r) => by.set(r.zone_id, [...(by.get(r.zone_id) ?? []), { actual: r.a, forecast: Number(r.f) }]));
  return new Map([...by].map(([k, v]) => [k, errorMetrics(v)]));
}

export async function zoneIntelligence(ctx: Ctx, zoneId: string) {
  const overview = (await zonesOverview(ctx)).find((z) => z.id === zoneId);
  if (!overview) throw notFound('Zone');
  const cur = floorBucket(Date.now());
  const { rows: series } = await ctx.db.query(
    `select bucket_start, actual_requests, forecast_requests, forecast_low, forecast_high, available_driver_count from zone_demand_buckets
      where zone_id=$1 and bucket_start >= $2 and bucket_start <= $3 order by bucket_start`,
    [zoneId, new Date(cur - 24 * 3600_000), new Date(cur + 4 * BUCKET)],
  );
  const { rows: recs } = await ctx.db.query(
    `select r.id, r.status, r.reason, r.distance_m, r.travel_seconds, r.gap_before, r.gap_after, r.horizon_minutes, r.expires_at, r.created_at,
            u.display_name driver_name, fz.name from_zone
       from reposition_recommendations r join drivers d on d.id=r.driver_id join users u on u.id=d.user_id left join zones fz on fz.id=r.from_zone_id
      where r.to_zone_id=$1 and r.status in ('ACTIVE','ACCEPTED') order by r.created_at desc`,
    [zoneId],
  );
  const m = overview.surgeMultiplier;
  const sample = { distanceM: 5000, durationS: 900 };
  const base = computeFare({ ...sample, surgeMultiplier: 1, provider: 'sample', fallback: false });
  const withSurge = computeFare({ ...sample, surgeMultiplier: m, provider: 'sample', fallback: false });
  return {
    ...overview,
    series: series.map((r) => ({
      t: r.bucket_start,
      actual: r.actual_requests,
      forecast: r.forecast_requests,
      low: r.forecast_low,
      high: r.forecast_high,
      available: r.available_driver_count,
      partial: new Date(r.bucket_start).getTime() === cur,
    })),
    recommendations: recs.map((r) => ({
      id: r.id,
      status: r.status,
      driverName: r.driver_name,
      fromZone: r.from_zone,
      reason: r.reason,
      distanceM: r.distance_m,
      travelSeconds: r.travel_seconds,
      gapBefore: Number(r.gap_before),
      gapAfter: Number(r.gap_after),
      horizonMinutes: r.horizon_minutes,
      expiresAt: r.expires_at,
    })),
    pricingPreview: { sampleTrip: '5 km · 15 min', baseMinor: base.totalMinor, withMultiplierMinor: withSurge.totalMinor, multiplier: m, bounds: config.surge, simulated: true },
    capacityFactor: config.zones.serviceCapacityFactor,
  };
}
