import type { LatLng } from '@relay/contracts';
import { gridDistanceM, haversineM } from '../../common/geo.js';
import { hashString } from '../../common/prng.js';
import { config } from '../../config.js';
import { logger } from '../../common/logger.js';
import { zoneForPoint } from '../zones/zones.cache.js';

export interface RouteEstimate {
  durationS: number;
  distanceM: number;
  provider: string;
  fallback: boolean;
}

export interface RoutingProvider {
  readonly name: string;
  route(from: LatLng, to: LatLng): Promise<RouteEstimate>;
  /** Many origins to one destination — used for the dispatch shortlist. */
  matrix(origins: LatLng[], to: LatLng): Promise<RouteEstimate[]>;
  healthy(): Promise<boolean>;
}

/** Time-of-day congestion factor in city local time (deterministic). */
export function congestionFactor(at: Date): number {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: config.cityTimezone }).format(at));
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 0.78;
  if (h >= 23 || h < 6) return 1.2;
  return 1.0;
}

/**
 * Deterministic mock road model for local demo mode. The demo city is a street grid,
 * so road distance is grid distance (never straight-line) with a small per-pair detour,
 * and speed is the mean of the zone speeds of origin and destination.
 */
export class MockGridRouting implements RoutingProvider {
  readonly name = 'mock-grid-v1';
  constructor(private clock: () => Date = () => new Date()) {}
  estimate(from: LatLng, to: LatLng): RouteEstimate {
    const key = `${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
    const detour = 1.04 + (hashString(key) % 1000) / 1000 * 0.08;
    const distanceM = Math.round(gridDistanceM(from, to) * detour + (haversineM(from, to) > 30 ? 60 : 0));
    const s1 = zoneForPoint(from)?.baseSpeedKmh ?? 22;
    const s2 = zoneForPoint(to)?.baseSpeedKmh ?? 22;
    const kmh = ((s1 + s2) / 2) * congestionFactor(this.clock());
    const durationS = Math.round(distanceM / (kmh / 3.6) + (distanceM > 50 ? 25 : 0));
    return { durationS, distanceM, provider: this.name, fallback: false };
  }
  async route(from: LatLng, to: LatLng) {
    return this.estimate(from, to);
  }
  async matrix(origins: LatLng[], to: LatLng) {
    return origins.map((o) => this.estimate(o, to));
  }
  async healthy() {
    return true;
  }
}

/** Labeled fallback when a real provider fails: straight-line × circuity at a conservative speed. */
export function fallbackEstimate(from: LatLng, to: LatLng): RouteEstimate {
  const distanceM = Math.round(haversineM(from, to) * 1.4);
  return { distanceM, durationS: Math.round(distanceM / (18 / 3.6) + 30), provider: 'fallback-speed-model', fallback: true };
}

/** OSRM table/route adapter. Degrades to the labeled fallback model on any failure. */
export class OsrmRouting implements RoutingProvider {
  readonly name = 'osrm';
  constructor(private baseUrl: string) {}
  async matrix(origins: LatLng[], to: LatLng): Promise<RouteEstimate[]> {
    try {
      const coords = [...origins, to].map((p) => `${p.lng},${p.lat}`).join(';');
      const dst = origins.length;
      const url = `${this.baseUrl}/table/v1/driving/${coords}?destinations=${dst}&annotations=duration,distance`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`osrm ${res.status}`);
      const j: any = await res.json();
      return origins.map((_, i) => ({
        durationS: Math.round(j.durations[i][0]),
        distanceM: Math.round(j.distances[i][0]),
        provider: this.name,
        fallback: false,
      }));
    } catch (e) {
      logger.warn('routing.fallback', { provider: this.name, error: String(e) });
      return origins.map((o) => fallbackEstimate(o, to));
    }
  }
  async route(from: LatLng, to: LatLng) {
    return (await this.matrix([from], to))[0];
  }
  async healthy() {
    try {
      const r = await fetch(`${this.baseUrl}/nearest/v1/driving/0,0`, { signal: AbortSignal.timeout(800) });
      return r.status < 500;
    } catch {
      return false;
    }
  }
}

/** Short-lived cache keyed by rounded origin/destination + minute bucket. */
export class CachedRouting implements RoutingProvider {
  private cache = new Map<string, { v: RouteEstimate; at: number }>();
  constructor(private inner: RoutingProvider, private ttlMs = config.routing.cacheTtlMs) {}
  get name() {
    return this.inner.name;
  }
  private key(a: LatLng, b: LatLng) {
    return `${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${b.lat.toFixed(4)},${b.lng.toFixed(4)}|${Math.floor(Date.now() / 60000)}`;
  }
  async matrix(origins: LatLng[], to: LatLng) {
    const now = Date.now();
    const out: (RouteEstimate | null)[] = origins.map((o) => {
      const hit = this.cache.get(this.key(o, to));
      return hit && now - hit.at < this.ttlMs ? hit.v : null;
    });
    const missIdx = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (missIdx.length) {
      const fresh = await this.inner.matrix(missIdx.map((i) => origins[i]), to);
      missIdx.forEach((i, k) => {
        out[i] = fresh[k];
        if (!fresh[k].fallback) this.cache.set(this.key(origins[i], to), { v: fresh[k], at: now });
      });
    }
    if (this.cache.size > 5000) this.cache.clear();
    return out as RouteEstimate[];
  }
  async route(a: LatLng, b: LatLng) {
    return (await this.matrix([a], b))[0];
  }
  healthy() {
    return this.inner.healthy();
  }
}

export function createRouting(): RoutingProvider {
  const inner = config.routing.provider === 'osrm' && config.routing.osrmUrl ? new OsrmRouting(config.routing.osrmUrl) : new MockGridRouting();
  return new CachedRouting(inner);
}
