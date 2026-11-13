import type { LatLng } from '@relay/contracts';
import { config } from '../../config.js';

export interface PoolStop {
  rideId: string;
  kind: 'PICKUP' | 'DROPOFF';
  point: LatLng;
  seats: number;
}
export interface InsertionLimits {
  maxDetourSeconds: number;
  maxDetourRatio: number;
  maxNewRiderRatio: number;
  maxPickupWaitSeconds: number;
}
export interface InsertionInput {
  driverPos: LatLng;
  capacity: number;
  onboardSeats: number;
  stops: PoolStop[];
  newRide: { rideId: string; pickup: LatLng; dropoff: LatLng; seats: number; soloDurationS: number };
  travel: (a: LatLng, b: LatLng) => number;
  limits?: InsertionLimits;
}
export type ViolationCode = 'CAPACITY_EXCEEDED' | 'DETOUR_LIMIT' | 'NEW_RIDER_DETOUR' | 'PICKUP_WAIT';
/** When several rules fail across insertions, report the most explanatory one. */
const PRIORITY: ViolationCode[] = ['CAPACITY_EXCEEDED', 'DETOUR_LIMIT', 'NEW_RIDER_DETOUR', 'PICKUP_WAIT'];
export interface RiderEstimate {
  rideId: string;
  pickupEtaS: number | null;
  dropoffEtaS: number;
  extraS: number;
}
export interface InsertionResult {
  feasible: boolean;
  stops?: PoolStop[];
  costS?: number;
  riders?: RiderEstimate[];
  evaluated: number;
  violation?: { code: ViolationCode; message: string; rideId?: string; extraS?: number; limitS?: number };
}

export function arrivalTimes(start: LatLng, stops: PoolStop[], travel: InsertionInput['travel']): number[] {
  let t = 0;
  let at = start;
  return stops.map((s) => {
    t += travel(at, s.point);
    at = s.point;
    return t;
  });
}

/**
 * Exhaustive insertion of (pickup, dropoff) into the remaining stop list, preserving
 * pickup-before-dropoff for every rider, enforcing capacity at every leg and the detour
 * limits of each existing rider. Returns the lowest-cost feasible plan, or the binding violation.
 */
export function bestInsertion(input: InsertionInput): InsertionResult {
  const lim = input.limits ?? config.pool;
  const { stops, newRide, travel, driverPos } = input;
  const base = arrivalTimes(driverPos, stops, travel);
  const baseDrop = new Map<string, number>();
  stops.forEach((s, i) => s.kind === 'DROPOFF' && baseDrop.set(s.rideId, base[i]));
  const P: PoolStop = { rideId: newRide.rideId, kind: 'PICKUP', point: newRide.pickup, seats: newRide.seats };
  const D: PoolStop = { rideId: newRide.rideId, kind: 'DROPOFF', point: newRide.dropoff, seats: newRide.seats };

  let best: InsertionResult | null = null;
  let leastBad: { excess: number; v: NonNullable<InsertionResult['violation']> } | null = null;
  let evaluated = 0;
  const note = (excess: number, v: NonNullable<InsertionResult['violation']>) => {
    const cur = leastBad as { excess: number; v: NonNullable<InsertionResult['violation']> } | null;
    const better = !cur || PRIORITY.indexOf(v.code) < PRIORITY.indexOf(cur.v.code) || (v.code === cur.v.code && excess < cur.excess);
    if (better) leastBad = { excess, v };
  };

  for (let i = 0; i <= stops.length; i++) {
    for (let j = i; j <= stops.length; j++) {
      evaluated++;
      const cand = [...stops.slice(0, i), P, ...stops.slice(i, j), D, ...stops.slice(j)];
      // capacity at every leg
      let load = input.onboardSeats, over = 0;
      for (const s of cand) {
        load += s.kind === 'PICKUP' ? s.seats : -s.seats;
        over = Math.max(over, load - input.capacity);
      }
      if (over > 0) {
        note(over, { code: 'CAPACITY_EXCEEDED', message: `Vehicle is full: ${input.capacity} seats, ${input.capacity + over - newRide.seats} already occupied, you need ${newRide.seats}` });
        continue;
      }
      const t = arrivalTimes(driverPos, cand, travel);
      const riders: RiderEstimate[] = [];
      let violated = false, cost = 0;
      cand.forEach((s, k) => {
        if (s.kind !== 'DROPOFF' || s.rideId === newRide.rideId || violated) return;
        const before = baseDrop.get(s.rideId)!;
        const extra = t[k] - before;
        const limit = Math.min(lim.maxDetourSeconds, Math.max(60, lim.maxDetourRatio * before));
        if (extra > limit) {
          violated = true;
          note(extra - limit, { code: 'DETOUR_LIMIT', rideId: s.rideId, extraS: Math.round(extra), limitS: Math.round(limit), message: `Would add ${Math.round(extra / 60)} min to an existing rider's trip (limit ${Math.round(limit / 60)} min)` });
        }
        const pIdx = cand.findIndex((x) => x.rideId === s.rideId && x.kind === 'PICKUP');
        riders.push({ rideId: s.rideId, pickupEtaS: pIdx >= 0 ? Math.round(t[pIdx]) : null, dropoffEtaS: Math.round(t[k]), extraS: Math.round(Math.max(0, extra)) });
        cost += Math.max(0, extra);
      });
      if (violated) continue;
      const tP = t[cand.indexOf(P)], tD = t[cand.indexOf(D)];
      if (tP > lim.maxPickupWaitSeconds) {
        note(tP - lim.maxPickupWaitSeconds, { code: 'PICKUP_WAIT', rideId: newRide.rideId, extraS: Math.round(tP), limitS: lim.maxPickupWaitSeconds, message: `Pickup would take ${Math.round(tP / 60)} min (shared-ride limit ${Math.round(lim.maxPickupWaitSeconds / 60)} min)` });
        continue;
      }
      const inVehicle = tD - tP;
      const maxNew = newRide.soloDurationS * lim.maxNewRiderRatio;
      if (inVehicle > maxNew) {
        note(inVehicle - maxNew, { code: 'NEW_RIDER_DETOUR', rideId: newRide.rideId, extraS: Math.round(inVehicle - newRide.soloDurationS), limitS: Math.round(maxNew - newRide.soloDurationS), message: `Your trip would take ${Math.round(inVehicle / 60)} min vs ${Math.round(newRide.soloDurationS / 60)} min solo (limit +${Math.round((lim.maxNewRiderRatio - 1) * 100)}%)` });
        continue;
      }
      cost += inVehicle - newRide.soloDurationS + 0.5 * tP;
      riders.push({ rideId: newRide.rideId, pickupEtaS: Math.round(tP), dropoffEtaS: Math.round(tD), extraS: Math.round(Math.max(0, inVehicle - newRide.soloDurationS)) });
      if (!best || cost < best.costS!) best = { feasible: true, stops: cand, costS: Math.round(cost), riders, evaluated: 0 };
    }
  }
  if (best) return { ...best, evaluated };
  const lb = leastBad as { excess: number; v: NonNullable<InsertionResult['violation']> } | null;
  return { feasible: false, evaluated, violation: lb?.v ?? { code: 'DETOUR_LIMIT', message: 'No feasible insertion' } };
}
