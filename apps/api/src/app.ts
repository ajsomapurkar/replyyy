import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { registerStaticApps } from './static.js';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import {
  availabilitySchema, cancelSchema, createRideSchema, demoSessionSchema, latLngSchema, locationUpdateSchema, quoteSchema, reassignSchema, rejectSchema,
} from '@relay/contracts';
import type { Ctx } from './common/context.js';
import { AppError, badRequest } from './common/errors.js';
import { withIdempotency } from './common/idempotency.js';
import { rateLimit } from './common/rate-limit.js';
import { metrics } from './common/metrics.js';
import { logger } from './common/logger.js';
import { config } from './config.js';
import { authHook, createDemoSession, demoAccounts, requireRole } from './modules/auth/auth.service.js';
import * as rides from './modules/rides/rides.service.js';
import * as dispatch from './modules/dispatch/dispatch.service.js';
import * as drivers from './modules/drivers/drivers.service.js';
import * as ops from './modules/ops/ops.service.js';
import { zoneIntelligence, zonesOverview } from './modules/zones/intelligence.service.js';
import { analytics, analyticsCsv } from './modules/analytics/analytics.service.js';
import { evaluateStrategies } from './modules/analytics/evaluation.js';
import { CITY_BOUNDS, DEMO_DESTINATION, DEMO_HUB } from './seed/city.js';

export interface Runtime {
  jobs?: { lastTickAt: number; lagSeconds(): Promise<number> };
  outbox?: { lagSeconds(): Promise<number> };
  gateway?: { connectionCount: number };
  simulator?: { lastTickAt: number; backgroundDemand: boolean; spawnBackgroundRide(): Promise<void> };
  reset?: () => Promise<void>;
  poolScenario?: () => Promise<unknown>;
}

const parse = <S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> => schema.parse(v ?? {});
const user = (req: FastifyRequest) => req.user!;
const OPS = requireRole('OPERATOR', 'ADMIN');
const DRIVER = requireRole('DRIVER');
const PASSENGER = requireRole('PASSENGER');
const ANY = requireRole();
const idParam = z.object({ id: z.string().uuid() });

export async function buildApp(ctx: Ctx, rt: Runtime = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','), allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] });
  app.addHook('onRequest', authHook(ctx));
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.includes('/location') || req.url.includes('/health')) return;
    logger.info('http', { requestId: req.id, method: req.method, route: req.routeOptions?.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime), userId: req.user?.id });
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION_FAILED', message: 'Request validation failed', details: err.issues, requestId: req.id });
    if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details, requestId: req.id });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ code: 'BAD_REQUEST', message: err.message, requestId: req.id });
    logger.error('unhandled', { requestId: req.id, error: String(err?.stack ?? err) });
    return reply.status(500).send({ code: 'INTERNAL', message: 'Something went wrong on our side', requestId: req.id });
  });

  app.register(
    async (r) => {
      /* ---------- public */
      r.get('/health', async () => {
        const db = await ctx.db.query('select 1').then(() => 'ok').catch(() => 'down');
        const routing = (await ctx.routing.healthy()) ? 'ok' : 'degraded';
        const now = Date.now();
        return {
          status: db === 'ok' ? 'ok' : 'degraded',
          api: 'ok',
          database: db,
          redis: 'not configured — PostgreSQL-only mode (location index uses PostGIS GiST)',
          worker: rt.jobs ? (now - rt.jobs.lastTickAt < 5000 ? 'ok' : 'stalled') : 'disabled',
          simulator: rt.simulator ? (now - rt.simulator.lastTickAt < 5000 ? 'ok' : 'stalled') : 'disabled',
          routing: { provider: ctx.routing.name, status: routing },
          websocket: { connections: rt.gateway?.connectionCount ?? 0 },
          queueLagSeconds: rt.jobs ? await rt.jobs.lagSeconds() : null,
          outboxLagSeconds: rt.outbox ? await rt.outbox.lagSeconds() : null,
          counters: metrics.counters,
          dispatchLatencyMs: metrics.dispatchLatency(),
        };
      });
      r.get('/auth/demo-accounts', async () => ({ accounts: await demoAccounts(ctx), notice: 'Demo sign-in only — no identity verification.' }));
      r.post('/auth/demo-session', { preHandler: rateLimit('auth', config.rateLimits.auth) }, async (req) => createDemoSession(ctx, parse(demoSessionSchema, req.body).userId));
      r.get('/places', async () => {
        const { rows } = await ctx.db.query(`select id, label, zone_code, ST_Y(location::geometry) lat, ST_X(location::geometry) lng from demo_places order by label`);
        return { places: rows, hub: DEMO_HUB, suggestedDestination: DEMO_DESTINATION, bounds: CITY_BOUNDS };
      });
      r.get('/config', async () => ({
        simulationSpeed: config.simulation.speed,
        offerTtlSeconds: config.dispatch.offerTtlSeconds,
        staleLocationSeconds: config.dispatch.staleLocationSeconds,
        searchRadiusM: config.dispatch.searchRadiusM,
        weights: config.dispatch.weights,
        fare: config.fare,
        surge: config.surge,
        pool: config.pool,
        cancellation: config.cancellation,
        currency: config.currency,
        routingProvider: ctx.routing.name,
      }));
      r.get('/zones', { preHandler: ANY }, async () => ({
        zones: (await zonesOverview(ctx)).map((z) => ({ id: z.id, code: z.code, name: z.name, polygon: z.polygon, centroid: z.centroid })),
      }));

      /* ---------- me */
      r.get('/me', { preHandler: ANY }, async (req) => ({ user: user(req) }));

      /* ---------- drivers */
      r.get('/drivers/me', { preHandler: DRIVER }, async (req) => drivers.driverProfile(ctx, user(req)));
      r.patch('/drivers/me/availability', { preHandler: [DRIVER, rateLimit('availability', 30)] }, async (req) => drivers.setAvailability(ctx, user(req), parse(availabilitySchema, req.body).status));
      r.post('/drivers/me/location', { preHandler: [DRIVER, rateLimit('location', config.rateLimits.location)] }, async (req) => drivers.updateLocation(ctx, user(req), parse(locationUpdateSchema, req.body), 'DEVICE'));
      r.post('/drivers/me/recommendations/:id/:action', { preHandler: DRIVER }, async (req) => {
        const p = z.object({ id: z.string().uuid(), action: z.enum(['accept', 'dismiss']) }).parse(req.params);
        return drivers.respondRecommendation(ctx, user(req), p.id, p.action === 'accept' ? 'ACCEPTED' : 'DISMISSED');
      });
      r.get('/drivers/nearby', { preHandler: ANY }, async (req) => {
        const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), radiusM: z.coerce.number().min(100).max(10000).default(3000) }).parse(req.query);
        latLngSchema.parse(q);
        return drivers.nearbyDrivers(ctx, q, q.radiusM);
      });

      /* ---------- rides */
      r.post('/rides/quote', { preHandler: PASSENGER }, async (req) => rides.quote(ctx, user(req), parse(quoteSchema, req.body)));
      r.post('/rides', { preHandler: [PASSENGER, rateLimit('ride-create', config.rateLimits.rideCreate)] }, async (req, reply) => {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string') throw badRequest('Idempotency-Key header is required');
        const input = parse(createRideSchema, req.body);
        const out = await withIdempotency(ctx.db, user(req).id, 'POST /rides', key, input, async (c) => ({ status: 201, body: await rides.createRide(ctx, c, user(req), input) }));
        reply.header('Idempotent-Replayed', String(out.replayed));
        return reply.status(out.status).send(out.body);
      });
      r.get('/rides', { preHandler: ANY }, async (req) => ({ items: await rides.listMyRides(ctx, user(req)) }));
      r.get('/rides/:id', { preHandler: ANY }, async (req) => rides.getRideView(ctx, user(req), idParam.parse(req.params).id));
      r.get('/rides/:id/events', { preHandler: ANY }, async (req) => ({ events: await rides.rideTimeline(ctx, user(req), idParam.parse(req.params).id) }));
      r.post('/rides/:id/cancel', { preHandler: ANY }, async (req) => rides.cancelRide(ctx, user(req), idParam.parse(req.params).id, parse(cancelSchema, req.body).reason));
      r.post('/rides/:id/retry', { preHandler: ANY }, async (req) => rides.retryRide(ctx, user(req), idParam.parse(req.params).id));
      r.post('/rides/:id/opt-in-pooling', { preHandler: PASSENGER }, async (req) => {
        const { id } = idParam.parse(req.params);
        const { rowCount } = await ctx.db.query(
          `update rides set pool_opt_in=true, version=version+1 where id=$1 and passenger_id=$2 and status in ('REQUESTED','DISPATCHING','REASSIGNING','ACCEPTED','ARRIVING') returning id`,
          [id, user(req).id],
        );
        if (!rowCount) throw new AppError(409, 'POOL_OPT_IN_UNAVAILABLE', 'Shared rides can only be enabled before your trip starts');
        await ctx.db.query(`insert into ride_events (ride_id, event_type, actor_type, actor_id, reason_code) values ($1,'POOL_OPT_IN','PASSENGER',$2,'PASSENGER_OPTED_IN')`, [id, user(req).id]);
        return { ok: true };
      });

      /* ---------- driver actions */
      const offerAction = (fn: 'accept' | 'reject') => async (req: FastifyRequest, reply: any) => {
        const { id } = idParam.parse(req.params);
        const key = req.headers['idempotency-key'];
        const run = async (c?: any) => {
          if (fn === 'accept') {
            const out = await dispatch.acceptOffer(ctx, id, user(req).id, c);
            return out.outcome === 'ACCEPTED' ? { status: 200, body: out.ride as any } : { status: 409, body: { code: 'POOL_PLAN_STALE', message: out.message, requestId: req.id } };
          }
          return { status: 200, body: await dispatch.rejectOffer(ctx, id, user(req).id, parse(rejectSchema, req.body).reason, c) };
        };
        const out = typeof key === 'string' ? await withIdempotency(ctx.db, user(req).id, `offer:${fn}`, key, { id }, run) : await run();
        return reply.status(out.status).send(out.body);
      };
      r.post('/driver/offers/:id/accept', { preHandler: [DRIVER, rateLimit('offer', config.rateLimits.offerAction)] }, offerAction('accept'));
      r.post('/driver/offers/:id/reject', { preHandler: [DRIVER, rateLimit('offer', config.rateLimits.offerAction)] }, offerAction('reject'));
      for (const step of ['arriving', 'start', 'complete'] as const) {
        r.post(`/driver/rides/:id/${step}`, { preHandler: DRIVER }, async (req) => rides.driverStep(ctx, user(req), idParam.parse(req.params).id, step));
      }
      r.post('/driver/rides/:id/cancel', { preHandler: DRIVER }, async (req) => dispatch.driverCancel(ctx, idParam.parse(req.params).id, user(req).id, parse(cancelSchema, req.body).reason));

      /* ---------- operations */
      r.get('/ops/overview', { preHandler: OPS }, async () => ops.overview(ctx));
      r.get('/ops/rides', { preHandler: OPS }, async (req) =>
        ops.listRides(ctx, z.object({ status: z.string().optional(), zoneId: z.string().uuid().optional(), search: z.string().max(60).optional(), cursor: z.string().optional(), limit: z.coerce.number().optional() }).parse(req.query)),
      );
      r.get('/ops/rides/:id', { preHandler: OPS }, async (req) => ops.rideDetail(ctx, idParam.parse(req.params).id));
      r.get('/ops/rides/:id/dispatch-candidates', { preHandler: OPS }, async (req) => ops.previewCandidates(ctx, idParam.parse(req.params).id));
      r.post('/ops/rides/:id/reassign', { preHandler: OPS }, async (req) => {
        const { id } = idParam.parse(req.params);
        await dispatch.opsReassign(ctx, id, { type: 'OPERATOR', id: user(req).id }, parse(reassignSchema, req.body));
        return ops.rideDetail(ctx, id);
      });
      r.post('/ops/rides/:id/cancel', { preHandler: OPS }, async (req) => rides.cancelRide(ctx, user(req), idParam.parse(req.params).id, parse(cancelSchema, req.body).reason));
      r.post('/ops/rides/:id/resolve', { preHandler: OPS }, async (req) => rides.resolveException(ctx, user(req), idParam.parse(req.params).id));
      r.get('/ops/zones', { preHandler: OPS }, async () => ({ zones: await zonesOverview(ctx) }));
      r.get('/ops/zones/:id/intelligence', { preHandler: OPS }, async (req) => zoneIntelligence(ctx, idParam.parse(req.params).id));
      const analyticsQuery = (req: FastifyRequest) => {
        const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), zoneId: z.string().uuid().optional() }).parse(req.query);
        return { from: q.from ?? new Date(Date.now() - 4 * 86_400_000), to: q.to ?? new Date(Date.now() + 60_000), zoneId: q.zoneId };
      };
      r.get('/ops/analytics', { preHandler: OPS }, async (req) => analytics(ctx, analyticsQuery(req)));
      r.get('/ops/analytics.csv', { preHandler: OPS }, async (req, reply) => reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="relay-metrics.csv"').send(analyticsCsv(await analytics(ctx, analyticsQuery(req)))));
      r.get('/ops/simulation/strategies', { preHandler: OPS }, async (req) => {
        const q = z.object({ seed: z.coerce.number().int().min(1).max(1e6).default(42) }).parse(req.query);
        return evaluateStrategies(q.seed);
      });
      r.get('/ops/audit', { preHandler: OPS }, async () => {
        const { rows } = await ctx.db.query(`select a.*, u.display_name actor_name from audit_log a left join users u on u.id=a.actor_id order by a.id desc limit 100`);
        return { items: rows };
      });

      /* ---------- demo controls (operator/admin, clearly labelled in UI) */
      r.get('/demo/state', { preHandler: OPS }, async () => ({ backgroundDemand: rt.simulator?.backgroundDemand ?? false, simulationSpeed: config.simulation.speed }));
      r.post('/demo/background', { preHandler: OPS }, async (req) => {
        const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
        if (rt.simulator) rt.simulator.backgroundDemand = enabled;
        return { backgroundDemand: enabled };
      });
      r.post('/demo/spawn-ride', { preHandler: OPS }, async () => {
        await rt.simulator?.spawnBackgroundRide();
        return { ok: true };
      });
      r.post('/demo/pool-scenario', { preHandler: OPS }, async () => ({ scenario: await rt.poolScenario?.() }));
      r.post('/demo/reset', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async () => {
        await rt.reset?.();
        return { ok: true };
      });
      r.post('/demo/drivers/:id/gps', { preHandler: OPS }, async (req) => {
        const { id } = idParam.parse(req.params);
        const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);
        await ctx.db.query(`update drivers set sim_gps_frozen=$2 where id=$1`, [id, frozen]);
        await ctx.db.query(`insert into audit_log (actor_id, action, entity, entity_id, metadata) values ($1,'DEMO_GPS_TOGGLE','driver',$2,$3)`, [user(req).id, id, JSON.stringify({ frozen })]);
        return { ok: true };
      });
    },
    { prefix: '/api/v1' },
  );
  await registerStaticApps(app);
  return app;
}
