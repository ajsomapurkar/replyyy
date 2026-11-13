import { describe, expect, it } from 'vitest';
import { EventVersionGate } from '@relay/contracts';
import { canTransition, assertTransition } from '../src/modules/rides/state-machine.js';
import { ineligibleReasons, type DriverState } from '../src/modules/dispatch/eligibility.js';
import { normalize, rankCandidates } from '../src/modules/dispatch/scoring.js';
import { computeFare } from '../src/modules/pricing/fare.js';
import { nextMultiplier, targetMultiplier } from '../src/modules/pricing/surge.js';
import { baseForecast, errorMetrics, expectedGap, forecast } from '../src/modules/forecasting/baseline.js';
import { bestInsertion } from '../src/modules/pooling/insertion.js';
import { gridDistanceM } from '../src/common/geo.js';
import { evaluateStrategies } from '../src/modules/analytics/evaluation.js';

describe('ride state machine', () => {
  it('allows the happy path and only by the right actor', () => {
    expect(canTransition('REQUESTED', 'DISPATCHING', 'SYSTEM')).toBe(true);
    expect(canTransition('DISPATCHING', 'ACCEPTED', 'DRIVER')).toBe(true);
    expect(canTransition('ACCEPTED', 'ARRIVING', 'DRIVER')).toBe(true);
    expect(canTransition('ARRIVING', 'ONGOING', 'DRIVER')).toBe(true);
    expect(canTransition('ONGOING', 'COMPLETED', 'DRIVER')).toBe(true);
    expect(canTransition('DISPATCHING', 'REASSIGNING', 'SYSTEM')).toBe(true);
    expect(canTransition('DISPATCHING', 'NO_DRIVER', 'SYSTEM')).toBe(true);
  });
  it('forbids skipping states, terminal exits and wrong actors', () => {
    expect(canTransition('REQUESTED', 'COMPLETED', 'DRIVER')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED', 'OPERATOR')).toBe(false);
    expect(canTransition('ONGOING', 'CANCELLED', 'PASSENGER')).toBe(false);
    expect(canTransition('ACCEPTED', 'ARRIVING', 'PASSENGER')).toBe(false);
    expect(() => assertTransition('CANCELLED', 'ONGOING', 'OPERATOR')).toThrow(/cannot move/);
  });
});

const drv = (o: Partial<DriverState> = {}): DriverState => ({
  id: 'd', name: 'D', isBot: true, availability: 'ONLINE', approval: 'APPROVED', capacity: 4, recordedAt: new Date(), accuracyM: 8,
  straightDistanceM: 500, onTrip: false, holdingOffer: false, recentlyOffered: false, lat: 0, lng: 0, lastTripEndedAt: null, onlineSince: null,
  offersReceived: 10, offersAccepted: 9, recentTrips: 0, ...o,
});
describe('eligibility', () => {
  const now = new Date();
  it('eligible driver has no reasons', () => expect(ineligibleReasons(drv(), { now, seats: 1 })).toEqual([]));
  it('rejects stale, offline, busy, far, low-capacity drivers', () => {
    expect(ineligibleReasons(drv({ recordedAt: new Date(now.getTime() - 60_000) }), { now, seats: 1 })).toContain('LOCATION_STALE');
    expect(ineligibleReasons(drv({ availability: 'OFFLINE' }), { now, seats: 1 })).toContain('OFFLINE');
    expect(ineligibleReasons(drv({ onTrip: true, holdingOffer: true }), { now, seats: 1 })).toEqual(['ON_ACTIVE_TRIP', 'HOLDING_OFFER']);
    expect(ineligibleReasons(drv({ straightDistanceM: 9000 }), { now, seats: 1 })).toContain('OUT_OF_RADIUS');
    expect(ineligibleReasons(drv({ capacity: 3 }), { now, seats: 4 })).toContain('CAPACITY');
    expect(ineligibleReasons(drv({ accuracyM: 500 }), { now, seats: 1 })).toContain('LOW_ACCURACY');
  });
});

describe('ranking', () => {
  it('normalises to [0,1] and treats equal values as 0', () => {
    expect(normalize([10, 20, 30])).toEqual([0, 0.5, 1]);
    expect(normalize([5, 5])).toEqual([0, 0]);
  });
  const base = { roadDistanceM: 1000, idleMinutes: 0, recentTrips: 0, reliability: 0.9, routeFallback: false };
  it('ETA dominates', () => {
    const r = rankCandidates([{ driverId: 'slow', etaSeconds: 600, ...base }, { driverId: 'fast', etaSeconds: 120, ...base }]);
    expect(r[0].driverId).toBe('fast');
    expect(r[0].reasonCodes).toContain('LOWEST_PICKUP_ETA');
  });
  it('fairness bonus breaks a near-tie toward the long-idle driver', () => {
    const r = rankCandidates([{ driverId: 'busy', etaSeconds: 180, ...base }, { driverId: 'idle', etaSeconds: 185, ...base, idleMinutes: 25 }, { driverId: 'far', etaSeconds: 900, ...base }]);
    expect(r[0].driverId).toBe('idle');
    expect(r[0].reasonCodes).toContain('LONG_IDLE_TIME');
  });
});

describe('fare', () => {
  it('sums lines to total, rounds once, integer minor units', () => {
    const f = computeFare({ distanceM: 4321, durationS: 777, surgeMultiplier: 1.25, provider: 'mock', fallback: false });
    expect(Number.isInteger(f.totalMinor)).toBe(true);
    expect(f.lines.reduce((a, l) => a + l.amountMinor, 0)).toBe(f.totalMinor);
    expect(f.lines.some((l) => l.code === 'ZONE_ADJUSTMENT')).toBe(true);
  });
  it('applies floor and cap', () => {
    expect(computeFare({ distanceM: 100, durationS: 30, surgeMultiplier: 1, provider: 'm', fallback: false }).totalMinor).toBe(6000);
    expect(computeFare({ distanceM: 900_000, durationS: 36_000, surgeMultiplier: 1.6, provider: 'm', fallback: false }).totalMinor).toBe(150000);
  });
  it('pool discount lowers the price', () => {
    const solo = computeFare({ distanceM: 5000, durationS: 900, surgeMultiplier: 1, provider: 'm', fallback: false });
    const pool = computeFare({ distanceM: 5000, durationS: 900, surgeMultiplier: 1, poolDiscount: 0.3, provider: 'm', fallback: false });
    expect(pool.totalMinor).toBeLessThan(solo.totalMinor);
  });
});

describe('simulated surge', () => {
  it('is bounded', () => {
    expect(targetMultiplier(0.5)).toBe(1);
    expect(targetMultiplier(50)).toBe(1.6);
  });
  it('smooths and ignores tiny changes (no-change band)', () => {
    expect(nextMultiplier(1, 1.05).multiplier).toBe(1);
    const step = nextMultiplier(1, 3).multiplier;
    expect(step).toBeGreaterThan(1);
    expect(step).toBeLessThan(1.6);
  });
});

describe('forecasting & zone gap', () => {
  const B = 15 * 60_000, D = 86_400_000, t = 100 * D;
  const s = new Map<number, number>([[t - 7 * D, 10], [t - 14 * D, 12], [t - D, 8], [t - 2 * D, 8]]);
  it('seasonal baseline blends weekly and daily means', () => expect(baseForecast(s, t)).toBeCloseTo(0.6 * 11 + 0.4 * 8));
  it('produces a range around the point forecast', () => {
    const f = forecast(s, t, t - B, B)!;
    expect(f.low).toBeLessThan(f.value);
    expect(f.high).toBeGreaterThan(f.value);
  });
  it('MAE/WAPE', () => expect(errorMetrics([{ actual: 10, forecast: 8 }, { actual: 10, forecast: 12 }])).toEqual({ mae: 2, wape: 0.2, n: 2 }));
  it('gap = max(0, demand − supply × factor)', () => {
    expect(expectedGap(10, 4, 1.5)).toBe(4);
    expect(expectedGap(3, 4, 1.5)).toBe(0);
  });
});

describe('pool insertion', () => {
  const travel = (a: any, b: any) => gridDistanceM(a, b) / 5; // 5 m/s
  const P0 = { lat: 12.95, lng: 77.58 };
  const hostDrop = { lat: 12.95, lng: 77.62 };
  const stops = [{ rideId: 'host', kind: 'DROPOFF' as const, point: hostDrop, seats: 1 }];
  const limits = { maxDetourSeconds: 480, maxDetourRatio: 0.5, maxNewRiderRatio: 1.6, maxPickupWaitSeconds: 600 };
  it('accepts an on-the-way rider and keeps pickup before dropoff', () => {
    const r = bestInsertion({ driverPos: P0, capacity: 4, onboardSeats: 1, stops, travel, limits, newRide: { rideId: 'new', pickup: { lat: 12.95, lng: 77.59 }, dropoff: { lat: 12.95, lng: 77.61 }, seats: 1, soloDurationS: travel({ lat: 12.95, lng: 77.59 }, { lat: 12.95, lng: 77.61 }) } });
    expect(r.feasible).toBe(true);
    const idx = (k: string) => r.stops!.findIndex((s) => s.rideId === 'new' && s.kind === k);
    expect(idx('PICKUP')).toBeLessThan(idx('DROPOFF'));
  });
  it('rejects when capacity is exceeded', () => {
    const r = bestInsertion({ driverPos: P0, capacity: 3, onboardSeats: 3, stops: [{ ...stops[0], seats: 3 }], travel, limits: { ...limits, maxPickupWaitSeconds: 60 }, newRide: { rideId: 'new', pickup: { lat: 12.95, lng: 77.585 }, dropoff: { lat: 12.95, lng: 77.61 }, seats: 1, soloDurationS: 500 } });
    expect(r.feasible).toBe(false);
    expect(r.violation!.code).toBe('CAPACITY_EXCEEDED');
  });
  it('rejects when an existing rider would exceed the detour limit', () => {
    const r = bestInsertion({ driverPos: P0, capacity: 4, onboardSeats: 1, stops, travel, limits: { ...limits, maxPickupWaitSeconds: 120 }, newRide: { rideId: 'new', pickup: { lat: 12.98, lng: 77.58 }, dropoff: { lat: 12.98, lng: 77.62 }, seats: 1, soloDurationS: 900 } });
    expect(r.feasible).toBe(false);
    expect(['DETOUR_LIMIT', 'NEW_RIDER_DETOUR', 'PICKUP_WAIT']).toContain(r.violation!.code);
  });
});

describe('event ordering', () => {
  it('drops duplicates and older versions', () => {
    const g = new EventVersionGate();
    expect(g.accept({ eventId: 'a', entityId: 'r1', version: 3, type: 'ride.status_changed' })).toBe(true);
    expect(g.accept({ eventId: 'a', entityId: 'r1', version: 3, type: 'ride.status_changed' })).toBe(false);
    expect(g.accept({ eventId: 'b', entityId: 'r1', version: 2, type: 'ride.status_changed' })).toBe(false);
    expect(g.accept({ eventId: 'c', entityId: 'r1', version: 4, type: 'ride.status_changed' })).toBe(true);
  });
});

describe('strategy evaluation', () => {
  it('is reproducible for a seed', () => expect(evaluateStrategies(7)).toEqual(evaluateStrategies(7)));
});
