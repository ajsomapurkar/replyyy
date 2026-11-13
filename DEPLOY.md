# Deploying Relay

Production runs as **one Node service on one URL**:

| URL | What |
|---|---|
| `https://<your-app>/` | Landing page with links to all three apps |
| `/rider/` | Rider app |
| `/driver/` | Driver app |
| `/console/` | Ops Console |
| `/api/v1/...` | API · `/api/v1/live` WebSocket |

Each app keeps its own sign-in, so you can be a rider, a driver and an operator in one browser.

**First boot** creates the tables and seeds the demo city, but only if the database is empty. Restarts never wipe data.
To reset the demo, use the Console's reset button, or run `npm run reset` locally against the same `DATABASE_URL`.

## Option A: Render (recommended, free)
1. Push this folder to a GitHub repo.
2. In Supabase, open **Database → Extensions** and enable **postgis**.
3. In Render, go to **New → Blueprint**, pick the repo, and Render reads `render.yaml`.
4. Paste your Supabase **Session pooler** URL as `DATABASE_URL`, then click **Apply**.
5. Build and deploy take about 3–5 min. You get `https://relay-xxxx.onrender.com`.

Free tier: the service sleeps after about 15 min with no traffic, and the first visit after that takes about 30–50 s to wake.
Open the link a minute before a demo, or use the $7/mo Starter plan so it never sleeps.

## Option B: Railway (about $5/mo credit, no sleeping)
**New Project → Deploy from GitHub repo.** Railway uses the `Dockerfile`.
Add `DATABASE_URL` under Variables, then go to **Settings → Networking → Generate Domain**.

## Option C: Fly.io
`fly launch` (it detects the Dockerfile), then `fly secrets set DATABASE_URL=...`, then `fly deploy`.

## Why not Vercel or Netlify?
The API is a long-running process with WebSockets, background job workers and a live simulator.
Serverless platforms kill the process between requests, so live tracking and dispatch would break.
