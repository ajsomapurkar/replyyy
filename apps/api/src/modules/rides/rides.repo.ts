import type { RideStatus } from '@relay/contracts';
import type { Queryable } from '../../database/db.js';
import { notFound } from '../../common/errors.js';

export const RIDE_SELECT = `
  select r.*,
    ST_Y(r.pickup::geometry) p_lat, ST_X(r.pickup::geometry) p_lng,
    ST_Y(r.destination::geometry) d_lat, ST_X(r.destination::geometry) d_lng,
    pu.display_name passenger_name, pu.is_bot passenger_is_bot,
    d.user_id driver_user_id, du.display_name driver_name, d.rating driver_rating, d.is_bot driver_is_bot,
    v.make_model, v.color vehicle_color, v.plate_label, v.seat_capacity
  from rides r
  join users pu on pu.id = r.passenger_id
  left join drivers d on d.id = r.assigned_driver_id
  left join users du on du.id = d.user_id
  left join vehicles v on v.id = d.vehicle_id`;

export interface RideRow {
  id: string;
  passenger_id: string;
  status: RideStatus;
  version: number;
  assigned_driver_id: string | null;
  driver_user_id: string | null;
  pool_group_id: string | null;
  pool_opt_in: boolean;
  seats: number;
  p_lat: number;
  p_lng: number;
  d_lat: number;
  d_lng: number;
  accepted_at: Date | null;
  started_at: Date | null;
  quoted_fare_minor: number;
  exception_prev_status: RideStatus | null;
  passenger_is_bot: boolean;
  [k: string]: any;
}

export async function getRideRow(c: Queryable, id: string, lock = false): Promise<RideRow> {
  const { rows } = await c.query(`${RIDE_SELECT} where r.id = $1 ${lock ? 'for update of r' : ''}`, [id]);
  if (!rows[0]) throw notFound('Ride');
  return rows[0];
}

export function toRideDto(r: RideRow) {
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    passenger: { id: r.passenger_id, name: r.passenger_name },
    pickup: { lat: r.p_lat, lng: r.p_lng, label: r.pickup_label },
    destination: { lat: r.d_lat, lng: r.d_lng, label: r.destination_label },
    pickupZoneId: r.pickup_zone_id,
    destinationZoneId: r.destination_zone_id,
    seats: r.seats,
    poolOptIn: r.pool_opt_in,
    poolGroupId: r.pool_group_id,
    quotedFareMinor: r.quoted_fare_minor,
    finalFareMinor: r.final_fare_minor,
    currency: r.currency,
    fareBreakdown: r.fare_breakdown,
    estTripSeconds: r.est_trip_seconds,
    estTripMeters: r.est_trip_meters,
    pickupEtaSeconds: r.pickup_eta_seconds,
    requestedAt: r.requested_at,
    acceptedAt: r.accepted_at,
    pickupAt: r.pickup_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    statusReason: r.status_reason,
    exceptionReason: r.exception_reason,
    exceptionAt: r.exception_at,
    offerCount: r.offer_count,
    driver: r.assigned_driver_id
      ? {
          id: r.assigned_driver_id,
          userId: r.driver_user_id,
          name: r.driver_name,
          rating: Number(r.driver_rating),
          vehicle: { makeModel: r.make_model, color: r.vehicle_color, plate: r.plate_label, seats: r.seat_capacity },
        }
      : null,
  };
}
export type RideDto = ReturnType<typeof toRideDto>;
