import { z } from 'zod';

/* ---------------------------------------------------------------- enums */

export const ROLES = ['PASSENGER', 'DRIVER', 'OPERATOR', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const RIDE_STATUSES = [
  'REQUESTED',
  'DISPATCHING',
  'REASSIGNING',
  'ACCEPTED',
  'ARRIVING',
  'ONGOING',
  'COMPLETED',
  'CANCELLED',
  'NO_DRIVER',
  'EXCEPTION',
] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

/** Statuses in which a driver is committed to the ride. */
export const DRIVER_COMMITTED_STATUSES: RideStatus[] = ['ACCEPTED', 'ARRIVING', 'ONGOING'];
/** Statuses where the ride is still alive (not terminal). */
export const ACTIVE_STATUSES: RideStatus[] = [
  'REQUESTED',
  'DISPATCHING',
  'REASSIGNING',
  'ACCEPTED',
  'ARRIVING',
  'ONGOING',
  'EXCEPTION',
];
export const TERMINAL_STATUSES: RideStatus[] = ['COMPLETED', 'CANCELLED', 'NO_DRIVER'];

export const OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export type ReasonCode =
  | 'LOWEST_PICKUP_ETA'
  | 'SHORT_ROAD_DISTANCE'
  | 'LONG_IDLE_TIME'
  | 'HIGH_RELIABILITY'
  | 'LOW_RECENT_WORKLOAD'
  | 'ROUTE_FALLBACK'
  | 'POOL_MATCH'
  | 'OPERATOR_SELECTED';

export type IneligibleCode =
  | 'OFFLINE'
  | 'NOT_APPROVED'
  | 'LOCATION_STALE'
  | 'LOW_ACCURACY'
  | 'ON_ACTIVE_TRIP'
  | 'HOLDING_OFFER'
  | 'OUT_OF_RADIUS'
  | 'CAPACITY'
  | 'PREVIOUSLY_OFFERED'
  | 'RESERVED_FOR_DEMO';

export const REASON_LABELS: Record<ReasonCode | IneligibleCode, string> = {
  LOWEST_PICKUP_ETA: 'Lowest estimated pickup time',
  SHORT_ROAD_DISTANCE: 'Short road distance',
  LONG_IDLE_TIME: 'Long idle time (fairness)',
  HIGH_RELIABILITY: 'High acceptance reliability',
  LOW_RECENT_WORKLOAD: 'Low recent workload',
  ROUTE_FALLBACK: 'Fallback ETA (routing unavailable)',
  POOL_MATCH: 'Compatible shared-ride route',
  OPERATOR_SELECTED: 'Selected by operator',
  OFFLINE: 'Offline',
  NOT_APPROVED: 'Not approved',
  LOCATION_STALE: 'Location stale',
  LOW_ACCURACY: 'GPS accuracy too low',
  ON_ACTIVE_TRIP: 'On an active trip',
  HOLDING_OFFER: 'Holding another offer',
  OUT_OF_RADIUS: 'Outside search radius',
  CAPACITY: 'Not enough seats',
  PREVIOUSLY_OFFERED: 'Already offered this ride',
  RESERVED_FOR_DEMO: 'Reserved for scripted demo',
};

export const STATUS_LABELS: Record<RideStatus, string> = {
  REQUESTED: 'Requested',
  DISPATCHING: 'Finding driver',
  REASSIGNING: 'Reassigning',
  ACCEPTED: 'Driver en route',
  ARRIVING: 'Driver at pickup',
  ONGOING: 'On trip',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_DRIVER: 'No driver found',
  EXCEPTION: 'Exception',
};

export type StatusTone = 'blue' | 'green' | 'amber' | 'red' | 'neutral';
export function statusTone(s: RideStatus): StatusTone {
  switch (s) {
    case 'REQUESTED':
    case 'DISPATCHING':
      return 'blue';
    case 'REASSIGNING':
    case 'EXCEPTION':
      return 'amber';
    case 'ACCEPTED':
    case 'ARRIVING':
    case 'ONGOING':
      return 'green';
    case 'CANCELLED':
    case 'NO_DRIVER':
      return 'red';
    default:
      return 'neutral';
  }
}

/* ---------------------------------------------------------------- shapes */

export interface LatLng {
  lat: number;
  lng: number;
}

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export interface FareLine {
  code: 'BASE' | 'DISTANCE' | 'TIME' | 'ZONE_ADJUSTMENT' | 'POOL_DISCOUNT' | 'FLOOR' | 'CAP' | 'ROUNDING' | 'CANCELLATION_FEE';
  label: string;
  amountMinor: number;
}

export interface FareBreakdown {
  currency: string;
  lines: FareLine[];
  totalMinor: number;
  surgeMultiplier: number;
  simulated: true;
  distanceM: number;
  durationS: number;
  routingProvider: string;
  routeFallback: boolean;
}

export interface ScoreComponents {
  pickupEta: number;
  roadDistance: number;
  workload: number;
  reliabilityPenalty: number;
  idleBonus: number;
}

export interface DispatchCandidate {
  driverId: string;
  driverName: string;
  eligible: boolean;
  ineligibleReasons: IneligibleCode[];
  straightDistanceM: number;
  etaSeconds?: number;
  roadDistanceM?: number;
  idleMinutes?: number;
  reliability?: number;
  recentTrips?: number;
  components?: ScoreComponents;
  score?: number;
  rank?: number;
  reasonCodes?: ReasonCode[];
  routeFallback?: boolean;
}

export interface DispatchDecision {
  rideId: string;
  attempt: number;
  strategy: string;
  createdAt: string;
  durationMs: number;
  weights: Record<keyof ScoreComponents, number>;
  candidates: DispatchCandidate[];
  selectedDriverId: string | null;
  explanation: string;
}

/* --------------------------------------------------------------- requests */

export const demoSessionSchema = z.object({ userId: z.string().uuid() });

export const availabilitySchema = z.object({ status: z.enum(['ONLINE', 'OFFLINE']) });

export const locationUpdateSchema = latLngSchema.extend({
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().min(0).max(100).optional(),
  accuracyM: z.number().min(0).max(5000).default(10),
});

export const createRideSchema = z.object({
  pickup: latLngSchema,
  pickupLabel: z.string().min(1).max(120),
  destination: latLngSchema,
  destinationLabel: z.string().min(1).max(120),
  seats: z.number().int().min(1).max(4).default(1),
  poolOptIn: z.boolean().default(false),
});
export type CreateRideInput = z.infer<typeof createRideSchema>;

export const quoteSchema = createRideSchema.pick({ pickup: true, destination: true, seats: true });

export const cancelSchema = z.object({ reason: z.string().max(200).optional() });
export const reassignSchema = z.object({ driverId: z.string().uuid().optional(), reason: z.string().max(200).optional() });
export const rejectSchema = z.object({ reason: z.string().max(200).optional() });

/* ------------------------------------------------------------------ events */

export const EVENT_TYPES = [
  'ride.created',
  'ride.status_changed',
  'ride.offer_received',
  'ride.offer_expired',
  'ride.assignment_changed',
  'driver.location_updated',
  'driver.availability_changed',
  'zone.forecast_updated',
  'zone.reposition_recommended',
  'ops.exception_created',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LiveEvent<T = unknown> {
  eventId: string;
  type: EventType;
  occurredAt: string;
  entityId: string;
  version: number;
  payload: T;
}

/**
 * Client-side guard for at-least-once, possibly out-of-order delivery.
 * Returns true if the event should be applied.
 */
export class EventVersionGate {
  private seen = new Set<string>();
  private versions = new Map<string, number>();
  constructor(private maxSeen = 2000) {}
  accept(e: Pick<LiveEvent, 'eventId' | 'entityId' | 'version' | 'type'>): boolean {
    if (this.seen.has(e.eventId)) return false;
    this.seen.add(e.eventId);
    if (this.seen.size > this.maxSeen) {
      const first = this.seen.values().next().value as string;
      this.seen.delete(first);
    }
    const key = `${e.type.split('.')[0]}:${e.entityId}`;
    const prev = this.versions.get(key);
    if (prev !== undefined && e.version < prev) return false;
    this.versions.set(key, e.version);
    return true;
  }
  reset() {
    this.versions.clear();
  }
}

/* -------------------------------------------------------------- formatting */

export function formatMoney(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    Math.round(minor) / 100,
  );
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}
