-- Relay schema v1 — PostgreSQL 16 + PostGIS 3
create extension if not exists postgis;
-- gen_random_uuid() is built into PostgreSQL 13+; no pgcrypto needed (Supabase keeps extensions in its own schema).

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  role text not null check (role in ('PASSENGER','DRIVER','OPERATOR','ADMIN')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  is_bot boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_ci on users (lower(email));

create table sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table zones (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  boundary geography(Polygon, 4326) not null,
  centroid geography(Point, 4326) not null,
  base_speed_kmh numeric not null check (base_speed_kmh > 0),
  active boolean not null default true
);
create index zones_boundary_gix on zones using gist (boundary);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  make_model text not null,
  color text not null,
  plate_label text not null,
  seat_capacity int not null check (seat_capacity > 0 and seat_capacity <= 8),
  active boolean not null default true
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id),
  capacity int not null check (capacity > 0),
  approval_status text not null default 'APPROVED' check (approval_status in ('PENDING','APPROVED','SUSPENDED')),
  availability_status text not null default 'OFFLINE' check (availability_status in ('ONLINE','OFFLINE')),
  last_seen_at timestamptz,
  online_since timestamptz,
  last_trip_ended_at timestamptz,
  offers_received int not null default 0 check (offers_received >= 0),
  offers_accepted int not null default 0 check (offers_accepted >= 0),
  rating numeric(3,2) not null default 4.80,
  is_bot boolean not null default false,
  sim_gps_frozen boolean not null default false,
  home_zone_id uuid references zones(id),
  created_at timestamptz not null default now()
);

-- current location only (no history retained by default)
create table driver_locations (
  driver_id uuid primary key references drivers(id) on delete cascade,
  location geography(Point, 4326) not null,
  heading numeric check (heading >= 0 and heading <= 360),
  speed numeric check (speed >= 0),
  accuracy_m numeric not null default 10 check (accuracy_m >= 0),
  recorded_at timestamptz not null,
  source text not null default 'DEVICE'
);
create index driver_locations_gix on driver_locations using gist (location);

create table pool_groups (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  capacity int not null check (capacity > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  stop_plan jsonb not null default '[]',
  route_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pool_groups_one_active_per_driver on pool_groups (driver_id) where status = 'ACTIVE';

create table rides (
  id uuid primary key default gen_random_uuid(),
  passenger_id uuid not null references users(id),
  status text not null check (status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING','ONGOING','COMPLETED','CANCELLED','NO_DRIVER','EXCEPTION')),
  pickup geography(Point, 4326) not null,
  pickup_label text not null,
  destination geography(Point, 4326) not null,
  destination_label text not null,
  pickup_zone_id uuid references zones(id),
  destination_zone_id uuid references zones(id),
  seats int not null default 1 check (seats > 0 and seats <= 4),
  pool_opt_in boolean not null default false,
  quoted_fare_minor int not null check (quoted_fare_minor >= 0),
  final_fare_minor int check (final_fare_minor >= 0),
  currency text not null default 'INR',
  fare_breakdown jsonb not null,
  est_trip_seconds int not null check (est_trip_seconds >= 0),
  est_trip_meters int not null check (est_trip_meters >= 0),
  pickup_eta_seconds int,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  pickup_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  assigned_driver_id uuid references drivers(id),
  pool_group_id uuid references pool_groups(id),
  status_reason text,
  exception_reason text,
  exception_at timestamptz,
  exception_prev_status text,
  offer_count int not null default 0,
  is_history boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rides_status_requested on rides (status, requested_at desc);
create index rides_passenger_created on rides (passenger_id, created_at desc);
create index rides_driver on rides (assigned_driver_id) where assigned_driver_id is not null;
-- Hard guard: a driver holds at most one active solo ride.
create unique index rides_one_active_solo_per_driver on rides (assigned_driver_id)
  where status in ('ACCEPTED','ARRIVING','ONGOING') and pool_group_id is null;

create table pool_members (
  pool_group_id uuid not null references pool_groups(id) on delete cascade,
  ride_id uuid not null references rides(id) on delete cascade,
  pickup_seq int not null,
  dropoff_seq int not null check (dropoff_seq > pickup_seq),
  detour_seconds int not null default 0,
  agreed_fare_minor int not null check (agreed_fare_minor >= 0),
  est_dropoff_seconds int,
  route_version int not null,
  joined_at timestamptz not null default now(),
  primary key (pool_group_id, ride_id)
);

create table ride_events (
  id bigserial primary key,
  ride_id uuid not null references rides(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_type text not null check (actor_type in ('PASSENGER','DRIVER','OPERATOR','SYSTEM')),
  actor_id uuid,
  reason_code text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index ride_events_ride on ride_events (ride_id, id);
-- append-only: forbid updates/deletes of history
create or replace function ride_events_immutable() returns trigger language plpgsql as $$
begin raise exception 'ride_events is append-only'; end $$;
create trigger ride_events_no_update before update on ride_events for each row execute function ride_events_immutable();

create table dispatch_offers (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references rides(id) on delete cascade,
  driver_id uuid not null references drivers(id),
  sequence int not null,
  status text not null check (status in ('PENDING','ACCEPTED','REJECTED','EXPIRED','WITHDRAWN')),
  score numeric,
  eta_seconds int,
  distance_m int,
  reason_codes text[] not null default '{}',
  pool_plan jsonb,
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  response_reason text,
  unique (ride_id, sequence)
);
create unique index offers_one_pending_per_driver on dispatch_offers (driver_id) where status = 'PENDING';
create unique index offers_one_pending_per_ride on dispatch_offers (ride_id) where status = 'PENDING';
create index offers_status_expiry on dispatch_offers (status, expires_at);

create table dispatch_decisions (
  id bigserial primary key,
  ride_id uuid not null references rides(id) on delete cascade,
  attempt int not null,
  decision jsonb not null,
  created_at timestamptz not null default now()
);
create index dispatch_decisions_ride on dispatch_decisions (ride_id, attempt);

create table zone_demand_buckets (
  zone_id uuid not null references zones(id),
  bucket_start timestamptz not null,
  actual_requests int check (actual_requests >= 0),
  forecast_requests numeric,
  forecast_low numeric,
  forecast_high numeric,
  available_driver_count int,
  forecast_model text,
  created_at timestamptz not null default now(),
  primary key (zone_id, bucket_start)
);

create table zone_pricing_state (
  zone_id uuid primary key references zones(id),
  multiplier numeric not null default 1.0 check (multiplier >= 1.0),
  target_multiplier numeric not null default 1.0,
  demand_supply_ratio numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table reposition_recommendations (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  from_zone_id uuid references zones(id),
  to_zone_id uuid not null references zones(id),
  reason text not null,
  distance_m int not null,
  travel_seconds int not null,
  gap_before numeric not null,
  gap_after numeric not null,
  horizon_minutes int not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DISMISSED','EXPIRED','ACCEPTED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create unique index reposition_one_active_per_driver on reposition_recommendations (driver_id) where status = 'ACTIVE';

create table fleet_snapshots (
  ts timestamptz primary key,
  online int not null,
  busy int not null,
  available int not null
);

create table idempotency_records (
  user_id uuid not null references users(id),
  scope text not null,
  key text not null,
  request_hash text not null,
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','COMPLETED')),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, scope, key)
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  entity_id text not null,
  version bigint not null,
  payload jsonb not null,
  audience jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts int not null default 0
);
create index outbox_unpublished on outbox_events (created_at) where published_at is null;

create table jobs (
  id bigserial primary key,
  type text not null,
  payload jsonb not null,
  run_at timestamptz not null default now(),
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','DONE','FAILED')),
  attempts int not null default 0,
  locked_until timestamptz,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index jobs_ready on jobs (run_at) where status = 'QUEUED';
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and status = 'QUEUED';

create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table demo_places (
  id serial primary key,
  label text not null,
  location geography(Point, 4326) not null,
  zone_code text not null
);
