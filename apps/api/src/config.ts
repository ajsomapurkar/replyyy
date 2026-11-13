import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Load .env (repo root, then apps/api) if present. Real env vars set on the host always win.
for (const f of [join(dirname(fileURLToPath(import.meta.url)), '../../../.env'), join(dirname(fileURLToPath(import.meta.url)), '../.env')]) {
  if (existsSync(f)) { const before = { ...process.env }; process.loadEnvFile(f); Object.assign(process.env, before); }
}
/** Central configuration. Every threshold here is a documented demo default (see docs/BUILD.md). */
const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  port: num('PORT', 4000),
  databaseUrl: env('DATABASE_URL', 'postgres://relay@localhost:5432/relay?host=/tmp'),
  corsOrigin: env('CORS_ORIGIN', '*'),
  logLevel: env('LOG_LEVEL', 'info'),
  cityTimezone: 'Asia/Kolkata',
  currency: 'INR',
  workersEnabled: env('WORKERS', 'on') === 'on',
  simulationEnabled: env('SIMULATION', 'on') === 'on',
  dispatch: {
    offerTtlSeconds: num('OFFER_TTL_SECONDS', 20),
    staleLocationSeconds: num('STALE_LOCATION_SECONDS', 30),
    maxAccuracyM: 100,
    searchRadiusM: num('SEARCH_RADIUS_M', 4000),
    shortlistSize: 8,
    maxOfferAttempts: 6,
    idleCapMinutes: 30,
    longIdleMinutes: 10,
    weights: { pickupEta: 0.55, roadDistance: 0.15, workload: 0.1, reliabilityPenalty: 0.1, idleBonus: 0.1 },
    /** Demo-only: background (bot) passengers are not offered to human-controlled demo drivers. Visible as RESERVED_FOR_DEMO. */
    reserveHumanDriversForDemo: true,
    delayedArrivalGraceSeconds: 180,
  },
  fare: {
    baseMinor: 4000,
    perKmMinor: 1200,
    perMinuteMinor: 150,
    floorMinor: 6000,
    capMinor: 150000,
  },
  surge: { min: 1.0, max: 1.6, sensitivity: 0.5, smoothing: 0.35, noChangeBand: 0.05, step: 0.05 },
  zones: { bucketMinutes: 15, serviceCapacityFactor: 1.5, recommendationTtlMinutes: 15, horizonMinutes: 15 },
  pool: { maxDetourSeconds: 480, maxDetourRatio: 0.5, discount: 0.3, maxPickupGapM: 2500, maxNewRiderRatio: 1.6, maxPickupWaitSeconds: 300 },
  cancellation: { freeWindowSeconds: 120, feeMinor: 5000 },
  simulation: {
    speed: num('SIM_SPEED', 4),
    tickMs: 1000,
    backgroundDemandIntervalMs: num('BACKGROUND_DEMAND_MS', 9000),
    backgroundDemandEnabled: env('BACKGROUND_DEMAND', 'on') === 'on',
  },
  routing: { provider: env('ROUTING_PROVIDER', 'mock') as 'mock' | 'osrm', osrmUrl: env('OSRM_URL', ''), cacheTtlMs: 60_000 },
  rateLimits: { auth: 20, rideCreate: 10, location: 120, offerAction: 30 }, // per minute
};
export type Config = typeof config;
