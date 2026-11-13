import type { IneligibleCode } from '@relay/contracts';
import { config } from '../../config.js';

export interface DriverState {
  id: string;
  name: string;
  isBot: boolean;
  availability: 'ONLINE' | 'OFFLINE';
  approval: string;
  capacity: number;
  recordedAt: Date | null;
  accuracyM: number;
  straightDistanceM: number;
  onTrip: boolean;
  holdingOffer: boolean;
  recentlyOffered: boolean;
  lat: number;
  lng: number;
  lastTripEndedAt: Date | null;
  onlineSince: Date | null;
  offersReceived: number;
  offersAccepted: number;
  recentTrips: number;
}

export interface EligibilityContext {
  now: Date;
  seats: number;
  radiusM?: number;
  staleSeconds?: number;
  maxAccuracyM?: number;
  backgroundRequest?: boolean;
}

/** Hard filters. Returns every failing reason (empty ⇒ eligible) so the operator sees why a driver was skipped. */
export function ineligibleReasons(d: DriverState, x: EligibilityContext): IneligibleCode[] {
  const r: IneligibleCode[] = [];
  const stale = x.staleSeconds ?? config.dispatch.staleLocationSeconds;
  if (d.availability !== 'ONLINE') r.push('OFFLINE');
  if (d.approval !== 'APPROVED') r.push('NOT_APPROVED');
  if (!d.recordedAt || (x.now.getTime() - d.recordedAt.getTime()) / 1000 > stale) r.push('LOCATION_STALE');
  if (d.accuracyM > (x.maxAccuracyM ?? config.dispatch.maxAccuracyM)) r.push('LOW_ACCURACY');
  if (d.capacity < x.seats) r.push('CAPACITY');
  if (d.onTrip) r.push('ON_ACTIVE_TRIP');
  if (d.holdingOffer) r.push('HOLDING_OFFER');
  if (d.recentlyOffered) r.push('PREVIOUSLY_OFFERED');
  if (d.straightDistanceM > (x.radiusM ?? config.dispatch.searchRadiusM)) r.push('OUT_OF_RADIUS');
  if (x.backgroundRequest && !d.isBot && config.dispatch.reserveHumanDriversForDemo) r.push('RESERVED_FOR_DEMO');
  return r;
}

export function isLocationFresh(recordedAt: Date | null, now: Date, staleSeconds = config.dispatch.staleLocationSeconds) {
  return !!recordedAt && (now.getTime() - recordedAt.getTime()) / 1000 <= staleSeconds;
}
