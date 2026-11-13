import type { Ctx } from '../../common/context.js';
import { median, quantile } from '../../common/stats.js';
import { forecastErrorByZone } from '../zones/intelligence.service.js';
import { errorMetrics } from '../forecasting/baseline.js';
import { getZones } from '../zones/zones.cache.js';

export interface AnalyticsQuery {
  from: Date;
  to: Date;
  zoneId?: string;
}

const bins = (vals: number[], edges: number[], label: (a: number, b: number | null) => string) =>
  edges.map((e, i) => {
    const hi = edges[i + 1] ?? null;
    return { label: label(e, hi), lo: e, hi, count: vals.filter((v) => v >= e && (hi === null || v < hi)).length };
  });

export async function analytics(ctx: Ctx, q: AnalyticsQuery) {
  const params: unknown[] = [q.from, q.to];
  let zoneSql = '';
  if (q.zoneId) {
    params.push(q.zoneId);
    zoneSql = 'and pickup_zone_id=$3';
  }
  const { rows } = await ctx.db.query(
    `select status, requested_at, accepted_at, completed_at, pickup_eta_seconds, offer_count, is_history,
            extract(epoch from accepted_at-requested_at) r2a, final_fare_minor
       from rides where requested_at >= $1 and requested_at < $2 ${zoneSql}`,
    params,
  );
  const terminal = rows.filter((r) => ['COMPLETED', 'CANCELLED', 'NO_DRIVER'].includes(r.status));
  const completed = rows.filter((r) => r.status === 'COMPLETED');
  const dispatched = rows.filter((r) => r.offer_count > 0);
  const etas = rows.filter((r) => r.pickup_eta_seconds != null).map((r) => r.pickup_eta_seconds as number);
  const r2a = rows.filter((r) => r.r2a != null).map((r) => Number(r.r2a));
  const { rows: snaps } = await ctx.db.query(`select ts, online, busy from fleet_snapshots where ts >= $1 and ts < $2 order by ts`, [q.from, q.to]);
  const util = snaps.filter((s) => s.online > 0).map((s) => s.busy / s.online);
  const fe = q.zoneId ? (await forecastErrorByZone(ctx, q.from.getTime(), Math.min(q.to.getTime(), Date.now()), q.zoneId)).get(q.zoneId) : undefined;
  const allFe = await forecastErrorByZone(ctx, q.from.getTime(), Math.min(q.to.getTime(), Date.now()));
  const { rows: fePairs } = await ctx.db.query(
    `select actual_requests a, forecast_requests f from zone_demand_buckets where bucket_start >= $1 and bucket_start < least($2, now()) and actual_requests is not null and forecast_requests is not null ${q.zoneId ? 'and zone_id=$3' : ''}`,
    params,
  );
  const overallFe = fe ?? errorMetrics(fePairs.map((p) => ({ actual: p.a, forecast: Number(p.f) })));

  const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  const days = new Map<string, { completed: number; cancelled: number; noDriver: number; reassigned: number; dispatched: number; total: number }>();
  for (const r of rows) {
    const k = dayKey(r.requested_at);
    const d = days.get(k) ?? { completed: 0, cancelled: 0, noDriver: 0, reassigned: 0, dispatched: 0, total: 0 };
    d.total++;
    if (r.status === 'COMPLETED') d.completed++;
    if (r.status === 'CANCELLED') d.cancelled++;
    if (r.status === 'NO_DRIVER') d.noDriver++;
    if (r.offer_count > 0) d.dispatched++;
    if (r.offer_count > 1) d.reassigned++;
    days.set(k, d);
  }
  const hourly = new Map<string, number[]>();
  snaps.forEach((s) => {
    const k = new Date(Math.floor(new Date(s.ts).getTime() / 3600_000) * 3600_000).toISOString();
    if (s.online) hourly.set(k, [...(hourly.get(k) ?? []), s.busy / s.online]);
  });
  const rate = (n: number, d: number) => (d ? n / d : null);
  return {
    range: { from: q.from, to: q.to, zoneId: q.zoneId ?? null },
    sampleSize: rows.length,
    includesSimulatedHistory: rows.some((r) => r.is_history),
    kpis: {
      rides: rows.length,
      completionRate: rate(completed.length, terminal.length),
      cancellationRate: rate(terminal.filter((r) => r.status === 'CANCELLED').length, terminal.length),
      noDriverRate: rate(terminal.filter((r) => r.status === 'NO_DRIVER').length, terminal.length),
      medianPickupEtaS: median(etas),
      p90PickupEtaS: quantile(etas, 0.9),
      medianRequestToAcceptS: median(r2a),
      p90RequestToAcceptS: quantile(r2a, 0.9),
      reassignmentRate: rate(dispatched.filter((r) => r.offer_count > 1).length, dispatched.length),
      utilization: util.length ? util.reduce((a, b) => a + b, 0) / util.length : null,
      forecastMae: overallFe.mae,
      forecastWape: overallFe.wape,
      grossFareMinor: completed.reduce((a, r) => a + (r.final_fare_minor ?? 0), 0),
    },
    pickupEtaHistogram: bins(etas.map((e) => e / 60), [0, 2, 4, 6, 8, 10, 12], (a, b) => (b === null ? `${a}+ min` : `${a}–${b}`)),
    requestToAcceptHistogram: bins(r2a, [0, 10, 20, 30, 45, 60, 90], (a, b) => (b === null ? `${a}+ s` : `${a}–${b}`)),
    outcomesByDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d, reassignmentRate: rate(d.reassigned, d.dispatched) })),
    utilizationByHour: [...hourly].sort(([a], [b]) => a.localeCompare(b)).map(([hour, v]) => ({ hour, utilization: v.reduce((a, b) => a + b, 0) / v.length })),
    forecastErrorByZone: getZones().map((z) => ({ zoneId: z.id, zone: z.name, ...(allFe.get(z.id) ?? { mae: null, wape: null, n: 0 }) })),
    definitions: {
      completionRate: 'Completed ÷ rides that reached a terminal state (completed, cancelled, no driver).',
      medianPickupEtaS: 'Median routing-estimated pickup time at the moment a driver accepted.',
      medianRequestToAcceptS: 'Median wall-clock time from request to driver acceptance, including rejected/expired offers.',
      reassignmentRate: 'Share of dispatched rides that needed more than one offer.',
      utilization: 'Average share of online drivers on an assigned trip, from 30-second fleet snapshots.',
      forecastWape: 'Weighted absolute percentage error: Σ|actual − forecast| ÷ Σ actual over 15-min zone buckets.',
    },
  };
}

export function analyticsCsv(a: Awaited<ReturnType<typeof analytics>>) {
  const head = 'day,total,completed,cancelled,no_driver,dispatched,reassigned,reassignment_rate';
  const lines = a.outcomesByDay.map((d) => [d.day, d.total, d.completed, d.cancelled, d.noDriver, d.dispatched, d.reassigned, d.reassignmentRate?.toFixed(3) ?? ''].join(','));
  return [`# Relay demo metrics (includes simulated data) ${a.range.from.toISOString()}..${a.range.to.toISOString()}`, head, ...lines].join('\n') + '\n';
}
