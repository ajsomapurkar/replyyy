import { config } from './config.js';
import { getPool } from './database/db.js';
import { buildApp } from './app.js';
import { createRouting } from './modules/routing/routing.js';
import { loadZones } from './modules/zones/zones.cache.js';
import { Gateway, OutboxPublisher } from './gateway/gateway.js';
import { JobRunner } from './workers/jobs.js';
import { expireOffer, requeueOrphans, runDispatch, withdrawStaleOffers } from './modules/dispatch/dispatch.service.js';
import { detectExceptions } from './modules/rides/rides.service.js';
import { runZoneCycle } from './modules/zones/intelligence.service.js';
import { Simulator } from './modules/demo/simulator.js';
import { seedDatabase, seedPoolScenario } from './seed/seed.js';
import { logger } from './common/logger.js';
import type { Ctx } from './common/context.js';

const db = getPool();
const ctx: Ctx = { db, routing: createRouting() };
await loadZones(db);

const gateway = new Gateway(ctx);
const jobs = new JobRunner(db, {
  DISPATCH_RIDE: (p) => runDispatch(ctx, p.rideId, { targetDriverId: p.targetDriverId ?? undefined }),
  EXPIRE_OFFER: (p) => expireOffer(ctx, p.offerId),
});
const outbox = new OutboxPublisher(db, gateway);
const simulator = new Simulator(ctx, gateway);
const loops: NodeJS.Timeout[] = [];

function startWorkers() {
  jobs.start();
  outbox.start();
  if (config.simulationEnabled) simulator.start();
  const safe = (name: string, fn: () => Promise<unknown>) => () => void fn().catch((e) => logger.error(`loop.${name}`, { error: String(e?.stack ?? e) }));
  loops.push(setInterval(safe('maintenance', async () => { await withdrawStaleOffers(ctx); await detectExceptions(ctx); await requeueOrphans(ctx); }), 2000));
  loops.push(setInterval(safe('zones', () => runZoneCycle(ctx)), 30_000));
  void runZoneCycle(ctx).catch((e) => logger.error('zones.initial', { error: String(e) }));
}
function stopWorkers() {
  jobs.stop();
  outbox.stop();
  simulator.stop();
  loops.splice(0).forEach(clearInterval);
}

const app = await buildApp(ctx, {
  jobs,
  outbox,
  gateway,
  simulator,
  poolScenario: () => seedPoolScenario(db),
  reset: async () => {
    stopWorkers();
    await new Promise((r) => setTimeout(r, 400));
    await seedDatabase(db, { preserveSessions: true });
    await loadZones(db);
    startWorkers();
  },
});
await app.listen({ port: config.port, host: '0.0.0.0' });
gateway.attach(app.server);
if (config.workersEnabled) startWorkers();
logger.info('relay.api.started', { port: config.port, routing: ctx.routing.name, simulation: config.simulationEnabled, simSpeed: config.simulation.speed });

const shutdown = async () => {
  stopWorkers();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
