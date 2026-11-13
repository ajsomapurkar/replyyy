# Architecture

Modular monolith (Fastify + TypeScript) — one API process that also runs the worker loops — plus a React/Vite client. PostgreSQL + PostGIS is the single source of truth.

```
apps/api/src
  modules/  auth drivers rides dispatch routing pricing zones forecasting pooling notifications analytics ops demo
  database/ (pool, tx helper, migration runner)   gateway/ (WebSocket + outbox publisher)   workers/ (DB job queue)   seed/
apps/web/src  pages/ (Login, Passenger, Driver, Ops)  components/ (CityMap, DecisionCard, RideTimeline, FareBreakdown, …)  lib/ (api, live socket)
packages/contracts  enums, zod schemas, event types, EventVersionGate, formatters
infra/migrations/001_init.sql   infra/docker-compose.yml
```

**Dispatch flow:** `POST /rides` (idempotent) writes the ride `REQUESTED` + outbox event + `DISPATCH_RIDE` job in one transaction → job computes candidates outside the lock, then locks the ride, transitions to `DISPATCHING`, inserts the offer (savepoint per candidate; unique indexes stop races) and schedules `EXPIRE_OFFER` → driver accept/reject → state machine transition (the only code path that changes status) appends `ride_events` and writes outbox events.

**Ride states** (`modules/rides/state-machine.ts`): REQUESTED → DISPATCHING → ACCEPTED → ARRIVING (driver at pickup) → ONGOING → COMPLETED; DISPATCHING ⇄ REASSIGNING; NO_DRIVER → REASSIGNING (retry); any active → EXCEPTION → back / reassign / cancel; CANCELLED per actor policy.

**Supabase:** the system of record can be a Supabase project (managed Postgres + PostGIS). TLS is auto-enabled for Supabase hosts; RLS is enabled on every table with no policies so the Data API exposes nothing. Supabase Auth/Realtime are not used — demo auth and the role-scoped WebSocket gateway stay in the Node API (the outbox, row-lock assignment and job queue all need server-side transactions).

**Redis:** not required. Spec allows a PostgreSQL-only mode; driver locations use a PostGIS GiST index and jobs use a DB queue. `/api/v1/health` reports this.

**Routing:** `RoutingProvider` interface with a deterministic street-grid mock (default, labelled `mock-grid-v1`), an OSRM adapter (`ROUTING_PROVIDER=osrm`), a labelled fallback speed model on failure, and a 60 s cache.

## Demo defaults (all in `apps/api/src/config.ts`)

| Setting | Value |
|---|---|
| Offer TTL | 20 s |
| Stale GPS | > 30 s |
| Max GPS accuracy | 100 m |
| Search radius | 4 km (shortlist 8 for routing) |
| Max offers per round | 6 |
| Weights | ETA .55 · distance .15 · workload .10 · reliability .10 · idle bonus .10 |
| Fare | ₹40 base + ₹12/km + ₹1.5/min, floor ₹60, cap ₹1500 |
| Zone multiplier (simulated) | 1.0–1.6, sensitivity .5, smoothing .35, no-change band .05 |
| Capacity factor | 1.5 rides / driver / 15 min |
| Pooling | co-rider detour ≤ 8 min and ≤ 50 %, new rider ≤ +60 % vs solo, pickup ≤ 5 min, 30 % discount |
| Cancellation | free before acceptance and 2 min after; ₹50 demo fee after |
| Simulation | drivers move 4× real time; simulated rider every 9 s |

## Known limitations
- Rate limiting and WebSocket fan-out are in-process (single API instance).
- Forecasts are a transparent baseline on synthetic data; no ML claims.
- Demo auth is account picking; tokens are opaque DB sessions (12 h).
- No location history is retained (current position only).
