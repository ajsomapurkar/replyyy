import type { LatLng } from '@relay/contracts';
import { mulberry32, hashUnit } from '../../common/prng.js';
import { haversineM } from '../../common/geo.js';
import { median, quantile, gini, mean } from '../../common/stats.js';
import { rankCandidates, type Strategy } from '../dispatch/scoring.js';
import { MockGridRouting } from '../routing/routing.js';
import { ZONES, inZone } from '../../seed/city.js';
import { demandRate } from '../../seed/demand-model.js';

export interface StrategyResult {
  strategy: Strategy;
  label: string;
  requests: number;
  completed: number;
  cancelled: number;
  noDriver: number;
  completionRate: number;
  cancellationRate: number;
  medianPickupEtaS: number | null;
  p90PickupEtaS: number | null;
  medianRequestToAcceptS: number | null;
  utilization: number;
  tripGini: number;
  meanOffersPerRide: number | null;
}

const LABELS: Record<Strategy, string> = { NEAREST: 'Nearest driver (straight line)', ETA_ONLY: 'ETA only', ETA_FAIRNESS: 'ETA + fairness/workload' };

/**
 * Reproducible discrete-event simulation. Every strategy sees the identical seeded fleet, request stream,
 * and per-(request, driver) acceptance draws, so differences come only from the ranking policy.
 * SIMULATION — not field evidence.
 */
export function evaluateStrategies(seed = 42, opts: { drivers?: number; requests?: number; horizonMin?: number } = {}): { seed: number; results: StrategyResult[]; assumptions: string[] } {
  const nDrivers = opts.drivers ?? 30, nReq = opts.requests ?? 260, horizon = (opts.horizonMin ?? 120) * 60;
  const routing = new MockGridRouting(() => new Date('2026-01-14T12:30:00Z')); // fixed clock ⇒ deterministic congestion
  const rand = mulberry32(seed);
  const codes = ZONES.map((z) => z.code);
  const weights = codes.map((c) => demandRate(c, Date.parse('2026-01-14T12:30:00Z')));
  const pickZone = () => {
    let x = rand() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < codes.length; i++) if ((x -= weights[i]) <= 0) return codes[i];
    return codes[0];
  };
  const homeBias = ['OLD', 'OLD', 'TECH', 'UNIV', 'UNIV', 'HARB', 'HARB', 'HARB', 'MRKT', 'MRKT', 'AIRP', 'AIRP'];
  const fleet = Array.from({ length: nDrivers }, (_, i) => ({ id: `d${i}`, pos: inZone(homeBias[i % homeBias.length], 0.15 + rand() * 0.7, 0.15 + rand() * 0.7), reliability: 0.72 + rand() * 0.26 }));
  const reqs = Array.from({ length: nReq }, (_, i) => {
    const z = pickZone();
    let dz = pickZone();
    if (dz === z && rand() < 0.5) dz = codes[(codes.indexOf(z) + 1 + Math.floor(rand() * 5)) % 6];
    return { id: `r${i}`, t: Math.round((i / nReq) * horizon + rand() * 20), pickup: inZone(z, 0.1 + rand() * 0.8, 0.1 + rand() * 0.8), dest: inZone(dz, 0.1 + rand() * 0.8, 0.1 + rand() * 0.8), patience: 60 + rand() * 120 };
  });

  const run = (strategy: Strategy): StrategyResult => {
    const ds = fleet.map((d) => ({ ...d, pos: { ...d.pos }, freeAt: 0, lastFree: 0, busy: 0, trips: 0 }));
    const etas: number[] = [], r2a: number[] = [], offers: number[] = [];
    let completed = 0, cancelled = 0, noDriver = 0;
    for (const q of reqs) {
      const free = ds.filter((d) => d.freeAt <= q.t && haversineM(d.pos, q.pickup) <= 4000);
      if (!free.length) { noDriver++; continue; }
      const est = free.map((d) => routing.estimate(d.pos, q.pickup));
      const ranked = rankCandidates(
        free.map((d, i) => ({
          driverId: d.id,
          etaSeconds: strategy === 'NEAREST' ? haversineM(d.pos, q.pickup) : est[i].durationS,
          roadDistanceM: strategy === 'NEAREST' ? haversineM(d.pos, q.pickup) : est[i].distanceM,
          idleMinutes: (q.t - d.lastFree) / 60,
          recentTrips: d.trips,
          reliability: d.reliability,
          routeFallback: false,
        })),
        undefined,
        strategy,
      );
      let wait = 0, chosen: (typeof ds)[number] | null = null, n = 0;
      for (const r of ranked.slice(0, 5)) {
        n++;
        const d = ds.find((x) => x.id === r.driverId)!;
        const eta = routing.estimate(d.pos, q.pickup).durationS;
        const pAccept = d.reliability * (1 - Math.min(0.45, eta / 1500));
        const u = hashUnit(`${seed}:${q.id}:${d.id}`);
        if (u < pAccept) { wait += 4 + u * 6; chosen = d; break; }
        wait += u > 0.9 ? 20 : 7; // timeout vs explicit reject
        if (wait > q.patience) break;
      }
      offers.push(n);
      if (!chosen) { if (wait > q.patience) cancelled++; else noDriver++; continue; }
      const pick = routing.estimate(chosen.pos, q.pickup).durationS;
      r2a.push(wait);
      if (pick > 720 && hashUnit(`${seed}:${q.id}:cancel`) < 0.5) { cancelled++; chosen.freeAt = q.t + wait + 60; continue; }
      const trip = routing.estimate(q.pickup, q.dest).durationS;
      etas.push(pick);
      completed++;
      const busy = pick + trip + 60;
      chosen.busy += busy;
      chosen.trips++;
      chosen.freeAt = q.t + wait + busy;
      chosen.lastFree = chosen.freeAt;
      chosen.pos = { ...q.dest } as LatLng;
    }
    return {
      strategy,
      label: LABELS[strategy],
      requests: nReq,
      completed,
      cancelled,
      noDriver,
      completionRate: completed / nReq,
      cancellationRate: cancelled / nReq,
      medianPickupEtaS: median(etas),
      p90PickupEtaS: quantile(etas, 0.9),
      medianRequestToAcceptS: median(r2a),
      utilization: Math.min(1, ds.reduce((a, d) => a + Math.min(d.busy, horizon), 0) / (nDrivers * horizon)),
      tripGini: Number(gini(ds.map((d) => d.trips)).toFixed(3)),
      meanOffersPerRide: mean(offers),
    };
  };
  return {
    seed,
    results: (['NEAREST', 'ETA_ONLY', 'ETA_FAIRNESS'] as Strategy[]).map(run),
    assumptions: [
      `${nDrivers} drivers, ${nReq} requests over ${horizon / 60} min, zone-weighted demand, seed ${seed}.`,
      'Acceptance probability = driver reliability × (1 − min(0.45, pickup ETA / 25 min)); identical random draws per (request, driver) across strategies.',
      'Rejection costs 7 s, timeout 20 s; riders cancel when wait exceeds patience (60–180 s) or, 50% of the time, when pickup ETA > 12 min.',
      'Routing uses the same deterministic mock grid model as the live demo. Results are simulated, not field evidence.',
    ],
  };
}
