# API (`/api/v1`)

Errors: `{ code, message, details?, requestId }`. Auth: `Authorization: Bearer <token>` from `POST /auth/demo-session`.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | /health | — | DB, worker, simulator, routing, WS, queue/outbox lag, counters |
| GET | /auth/demo-accounts · POST /auth/demo-session | — | demo only |
| GET | /me · /places · /config · /zones | any | |
| GET/PATCH/POST | /drivers/me · /drivers/me/availability · /drivers/me/location | driver | |
| POST | /drivers/me/recommendations/:id/(accept\|dismiss) | driver | advisory only |
| GET | /drivers/nearby?lat&lng&radiusM | any | anonymised, rounded |
| POST | /rides/quote | passenger | solo + shared + rejected shared candidates |
| POST | /rides | passenger | **Idempotency-Key required** |
| GET | /rides · /rides/:id · /rides/:id/events | owner/assigned driver/ops | role-shaped |
| POST | /rides/:id/cancel · /retry · /opt-in-pooling | owner/ops | |
| POST | /driver/offers/:id/(accept\|reject) | driver | optional Idempotency-Key |
| POST | /driver/rides/:id/(arriving\|start\|complete\|cancel) | assigned driver | |
| GET | /ops/overview · /ops/rides · /ops/rides/:id · /ops/rides/:id/dispatch-candidates | ops | |
| POST | /ops/rides/:id/(reassign\|cancel\|resolve) | ops | audited |
| GET | /ops/zones · /ops/zones/:id/intelligence · /ops/analytics · /ops/analytics.csv · /ops/simulation/strategies · /ops/audit | ops | |
| POST | /demo/(background\|spawn-ride\|pool-scenario\|reset) · /demo/drivers/:id/gps | ops/admin | demo tooling |

WebSocket `GET /api/v1/live?token=…` → `{type:'event', event:{eventId,type,occurredAt,entityId,version,payload}}` for `ride.created`, `ride.status_changed`, `ride.offer_received`, `ride.offer_expired`, `ride.assignment_changed`, `driver.location_updated`, `driver.availability_changed`, `zone.forecast_updated`, `zone.reposition_recommended`, `ops.exception_created`.
