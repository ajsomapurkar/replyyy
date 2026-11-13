# Relay — ride matching with explainable dispatch

Three apps on one backend:

| App | Who | URL (dev) | Folder |
|---|---|---|---|
| **Relay** (rider) | Passengers — book, track, history | http://localhost:5174 | `apps/rider` |
| **Relay Driver** | Drivers — duty toggle, ride requests, trips, earnings | http://localhost:5175 | `apps/driver` |
| **Relay Console** | Operations — live map, dispatch decisions, zones, analytics | http://localhost:5173 | `apps/web` |
| API + worker | Node/Fastify, PostgreSQL + PostGIS (Supabase or local) | http://localhost:4000 | `apps/api` |

All three UIs share one design system (`packages/ui`: tokens in `theme.css`, `StreetMap`, sheet/buttons/rows). Re-skin every app by editing the CSS variables at the top of `theme.css`. Layouts adapt: bottom sheet on phones, floating side panel on tablets/desktop (≥ 820 px).

<p><img src="docs/screenshots/r3-options.png" width="230"> <img src="docs/screenshots/d1-offer.png" width="230"> <img src="docs/screenshots/r5-enroute.png" width="230"></p>

## Run it

**1 · Database — pick one**

*Supabase (no Docker):* create a project → Database → Extensions → enable **postgis** → copy the **Session pooler** connection string.
```bash
export DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```
*Docker:* `docker compose -f infra/docker-compose.yml up -d postgres` then `export DATABASE_URL=postgres://relay:relay@localhost:5432/relay`

**2 · Install, seed, start everything**
```bash
npm install
npm run reset        # creates tables (+ RLS lockdown) and loads the demo city
npm run dev          # API :4000 · Console :5173 · Rider :5174 · Driver :5175
```

Or run pieces in separate terminals: `npm run dev:api`, `npm run dev:rider`, `npm run dev:driver`, `npm run dev:console`.

**3 · Demo it**
- Rider app (http://localhost:5174) → **Priya Nair** → "Where are you going?" → Orbit Towers → Book.
- Driver app (http://localhost:5175) → **Arjun Rao** → Decline (watch it go to the next driver) — or open the driver app in a second browser/profile as **Meera Iyer** and Accept → Arrived → Start ride → End ride.
- Console (http://localhost:5173) → **Kavya Menon** → click the ride to see *why* that driver was chosen.

Each app runs on its own port, so you can be signed in as a rider, a driver and an operator in the same browser at once. **Phone testing:** the dev servers listen on your network, so open `http://<your-laptop-IP>:5174` on a phone on the same Wi-Fi.

```bash
npm test             # 33 unit + integration tests (uses TEST_DATABASE_URL — a local/throwaway DB, it drops Relay's tables)
npm run typecheck    # all packages and apps
npm run build        # production builds of the three UIs
```

Supabase notes: use the Session pooler (5432) or direct connection, not the 6543 transaction pooler. `npm run reset` drops only Relay's tables. Migration `002_lockdown_rls.sql` enables RLS with no policies so Supabase's public Data API can't read anything; the Node API connects as table owner.

## What's in it

| Area | Highlights |
|---|---|
| **Dispatch** | PostGIS radius search → hard eligibility filters (online, approved, fresh GPS ≤30 s, accuracy, seats, not busy, no conflicting offer) → routing ETA for a shortlist → normalised score `0.55·ETA + 0.15·distance + 0.10·workload + 0.10·reliability − 0.10·idle` → reason codes + a plain-language sentence + runner-up comparison. |
| **Reliability** | Atomic acceptance (row locks ride→offer→driver + partial unique indexes: one active solo ride per driver, one pending offer per driver/ride), idempotency keys on ride creation and offer responses, transactional **outbox**, durable DB job queue (`FOR UPDATE SKIP LOCKED`) for dispatch/expiry, idempotent expiry, orphan re-queue safety net. |
| **Recovery** | Reject / timeout / stale GPS / driver offline → withdraw & next candidate; driver hand-back → re-dispatch; delayed arrival flag; driver unreachable → `EXCEPTION` with auto-recovery; `NO_DRIVER` with retry. Nothing silent — every step is in the append-only timeline. |
| **Live** | Authenticated, role-scoped WebSocket; at-least-once events with `eventId`/`version`; clients dedupe & ignore stale versions and resync via REST on reconnect. Passengers only ever see their own driver. |
| **Zone intelligence** | 21 days of seeded 15-min demand; transparent seasonal baseline + trend with ≈80% range; MAE/WAPE backtest; supply gap = `max(0, forecast − available × 1.5)`; advisory, expiring repositioning; bounded, smoothed, banded **simulated** zone multiplier. |
| **Pooling** | Explicit opt-in; exhaustive insertion preserving pickup-before-dropoff, capacity per leg, co-rider detour limits, pickup-wait limit; solo-vs-shared comparison; rejected candidates explained (capacity / detour). Agreed fares never change. |
| **Analytics** | Completion, cancellation, pickup ETA, request→accept, reassignment, utilisation, forecast error; CSV export; reproducible strategy simulation (nearest vs ETA vs ETA+fairness). |

Everything simulated is labelled as such in the UI: city, people, demand, forecasts, pricing and earnings.

See **docs/DEMO.md** (5-minute script), **docs/BUILD.md** (architecture & defaults), **docs/API.md**.
