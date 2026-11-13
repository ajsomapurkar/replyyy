import { hashString, mulberry32, poisson } from '../common/prng.js';

/** Synthetic city-scale demand (requests per 15-min bucket). Deterministic per zone & bucket. */
const peak = (h: number, c: number, w: number) => Math.exp(-((h - c) ** 2) / (2 * w * w));

function localParts(t: number) {
  const ist = new Date(t + 5.5 * 3600_000); // Asia/Kolkata has no DST
  return { hour: ist.getUTCHours() + ist.getUTCMinutes() / 60, dow: ist.getUTCDay(), dayKey: Math.floor((t + 5.5 * 3600_000) / 86_400_000) };
}

export function demandRate(zone: string, t: number): number {
  const { hour: h, dow } = localParts(t);
  const weekend = dow === 0 || dow === 6;
  let v: number;
  switch (zone) {
    case 'TECH': v = 4 + 9 * peak(h, 9, 1.2) + 8 * peak(h, 18.5, 1.5); if (weekend) v *= 0.45; break;
    case 'OLD': v = 3 + 6 * peak(h, 13, 2) + 9 * peak(h, 21, 2); if (weekend) v *= 1.3; break;
    case 'UNIV': v = 2 + 6 * peak(h, 12, 3) + 3 * peak(h, 17, 1.5); if (weekend) v *= 0.5; break;
    case 'HARB': v = 2 + 4 * peak(h, 19, 2.5); if (weekend) v *= 1.6; break;
    case 'MRKT': v = 3 + 6 * peak(h, 11.5, 2.5) + 4 * peak(h, 18, 2); if (weekend) v *= 1.4; break;
    case 'AIRP': v = 2 + 6 * peak(h, 6, 1.5) + 5 * peak(h, 22, 2); break;
    default: v = 2;
  }
  if ((h < 6 || h >= 23.5) && zone !== 'AIRP') v *= 0.35;
  return v;
}

/** Simulated "actual" requests for a bucket: rate × day-level factor + Poisson noise. */
export function simulatedActual(zone: string, bucketStart: number): number {
  const { dayKey } = localParts(bucketStart);
  const dayFactor = 0.9 + mulberry32(hashString(`${zone}:${dayKey}`))() * 0.2;
  return poisson(mulberry32(hashString(`${zone}:${bucketStart}`)), demandRate(zone, bucketStart) * dayFactor);
}
