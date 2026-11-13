/**
 * Transparent seasonal baseline (model "seasonal-baseline-v1"):
 *   base(t)  = 0.6 × mean(same weekday & time, previous 2 weeks) + 0.4 × mean(same time, previous 6 days)
 *   trend    = clamp(Σ actual / Σ base over the 4 buckets before the forecast origin, 0.75, 1.25)
 *   forecast = base × trend,  range ≈ ±1.28·√(forecast+1)  (≈80% interval under Poisson noise)
 */
export const MODEL_NAME = 'seasonal-baseline-v1';
const DAY = 86_400_000;

export type Series = Map<number, number>; // bucketStartMs → actual requests

const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function baseForecast(history: Series, t: number): number | null {
  const weekly = [7, 14].map((d) => history.get(t - d * DAY)).filter((v): v is number => v !== undefined);
  const daily = [1, 2, 3, 4, 5, 6].map((d) => history.get(t - d * DAY)).filter((v): v is number => v !== undefined);
  const w = avg(weekly), d = avg(daily);
  if (w === null && d === null) return null;
  if (w === null) return d;
  if (d === null) return w;
  return 0.6 * w + 0.4 * d;
}

export function trendFactor(history: Series, origin: number, bucketMs: number): number {
  let act = 0, base = 0;
  for (let k = 1; k <= 4; k++) {
    const t = origin - k * bucketMs;
    const a = history.get(t), b = baseForecast(history, t);
    if (a === undefined || b === null) continue;
    act += a;
    base += b;
  }
  if (base < 1) return 1;
  return Math.min(1.25, Math.max(0.75, act / base));
}

export function forecast(history: Series, t: number, origin: number, bucketMs: number) {
  const base = baseForecast(history, t);
  if (base === null) return null;
  const v = base * trendFactor(history, origin, bucketMs);
  const half = 1.28 * Math.sqrt(v + 1);
  return { value: Number(v.toFixed(2)), low: Number(Math.max(0, v - half).toFixed(2)), high: Number((v + half).toFixed(2)) };
}

export function errorMetrics(pairs: { actual: number; forecast: number }[]) {
  if (!pairs.length) return { mae: null, wape: null, n: 0 };
  const absErr = pairs.reduce((a, p) => a + Math.abs(p.actual - p.forecast), 0);
  const totalActual = pairs.reduce((a, p) => a + p.actual, 0);
  return { mae: Number((absErr / pairs.length).toFixed(2)), wape: totalActual ? Number((absErr / totalActual).toFixed(3)) : null, n: pairs.length };
}

/** Expected supply gap (rides per bucket the zone cannot serve). */
export function expectedGap(forecastDemand: number, availableSupply: number, capacityFactor: number) {
  return Math.max(0, forecastDemand - availableSupply * capacityFactor);
}
