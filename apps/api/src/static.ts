import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Production single-origin hosting: the API also serves the three built UIs.
 *   /rider/   → apps/rider/dist     /driver/  → apps/driver/dist     /console/ → apps/web/dist
 * Same origin means relative /api/v1 calls and the /api/v1/live WebSocket just work — no CORS, no proxy.
 * Skipped automatically when the dist folders don't exist (local dev uses the Vite dev servers).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const APPS = [
  { prefix: '/rider/', dir: join(root, 'apps/rider/dist'), label: 'Rider app', hint: 'Book and track rides' },
  { prefix: '/driver/', dir: join(root, 'apps/driver/dist'), label: 'Driver app', hint: 'Go on duty, accept trips' },
  { prefix: '/console/', dir: join(root, 'apps/web/dist'), label: 'Ops Console', hint: 'Live map, dispatch decisions, zones' },
];

const landing = (apps: typeof APPS) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#1c1c1c;color:#fff}
main{width:min(420px,90vw)}h1{margin:0 0 4px;font-size:32px}p{color:#aaa;margin:0 0 24px}
a{display:block;padding:18px 20px;margin-bottom:12px;border-radius:14px;background:#ffd400;color:#1c1c1c;text-decoration:none}
a b{display:block;font-size:18px}a span{font-size:14px;opacity:.75}small{color:#777}
</style></head><body><main><h1>Relay</h1><p>Ride matching with explainable dispatch</p>
${apps.map((a) => `<a href="${a.prefix}"><b>${a.label} →</b><span>${a.hint}</span></a>`).join('')}
<small>Demo environment · synthetic city, people and demand.</small></main></body></html>`;

export async function registerStaticApps(app: FastifyInstance) {
  const present = APPS.filter((a) => existsSync(join(a.dir, 'index.html')));
  if (!present.length) return;
  present.forEach((a, i) => {
    app.register(fastifyStatic, { root: a.dir, prefix: a.prefix, decorateReply: i === 0, wildcard: true, index: ['index.html'] });
  });
  app.get('/', async (_req, reply) => reply.type('text/html').send(landing(present)));
  for (const a of present) app.get(a.prefix.slice(0, -1), async (_req, reply) => reply.redirect(a.prefix));
  // SPA fallback: client-side routes (e.g. /console/ops/zones) get that app's index.html
  app.setNotFoundHandler((req, reply) => {
    const a = present.find((x) => req.url.startsWith(x.prefix));
    if (a && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html', a.dir);
    return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' });
  });
}
