import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { EventVersionGate } from '@relay/contracts';
import { getPool, closePool, tx } from '../src/database/db.js';
import { migrate } from '../src/database/migrate.js';
import { seedDatabase, DEMO } from '../src/seed/seed.js';
import { placePoint } from '../src/seed/city.js';
import { loadZones } from '../src/modules/zones/zones.cache.js';
import { MockGridRouting } from '../src/modules/routing/routing.js';
import { JobRunner } from '../src/workers/jobs.js';
import { acceptOffer, expireOffer, rejectOffer, runDispatch, withdrawStaleOffers } from '../src/modules/dispatch/dispatch.service.js';
import { createRide, driverStep, type AuthUser } from '../src/modules/rides/rides.service.js';
import { userFromId } from '../src/modules/auth/auth.service.js';
import { buildApp } from '../src/app.js';
import { Gateway, OutboxPublisher } from '../src/gateway/gateway.js';
import type { Ctx } from '../src/common/context.js';

const db = getPool();
const ctx: Ctx = { db, routing: new MockGridRouting() };
const jobs = new JobRunner(db, {
  DISPATCH_RIDE: (p) => runDispatch(ctx, p.rideId, { targetDriverId: p.targetDriverId ?? undefined }),
  EXPIRE_OFFER: (p) => expireOffer(ctx, p.offerId),
});
let app: FastifyInstance;
let priya: AuthUser, rahul: AuthUser, arjun: AuthUser, meera: AuthUser;
const hub = placePoint('Clocktower Square'), orbit = placePoint('Orbit Towers');
const trip = { pickup: hub, pickupLabel: 'Clocktower Square', destination: orbit, destinationLabel: 'Orbit Towers', seats: 1, poolOptIn: false };

async function freshWorld() {
  await seedDatabase(db, { historyDays: 15, historyRides: false });
  await loadZones(db);
  // isolate dispatch to the two human demo drivers unless a test changes it
  await db.query(`update drivers set availability_status='OFFLINE' where is_bot`);
  await db.query(`update driver_locations set recorded_at=now()`);
}
const book = async (u: AuthUser, input = trip) => tx(db, (c) => createRide(ctx, c, u, input));
const pendingOffer = async (rideId: string) => (await db.query(`select o.*, d.user_id from dispatch_offers o join drivers d on d.id=o.driver_id where ride_id=$1 and status='PENDING'`, [rideId])).rows[0];
const status = async (rideId: string) => (await db.query(`select status, assigned_driver_id from rides where id=$1`, [rideId])).rows[0];
async function token(userId: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/demo-session', payload: { userId } });
  return r.json().token as string;
}

beforeAll(async () => {
  await migrate();
  await freshWorld();
  [priya, rahul, arjun, meera] = await Promise.all([DEMO.passenger, DEMO.passenger2, DEMO.driverArjun, DEMO.driverMeera].map((id) => userFromId(ctx, id)));
  app = await buildApp(ctx, {});
});
beforeEach(freshWorld);
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('ride lifecycle', () => {
  it('create → dispatch → accept → arriving → start → complete, with full history', async () => {
    const ride = await book(priya);
    expect(ride.status).toBe('REQUESTED');
    await jobs.drain();
    const offer = await pendingOffer(ride.id);
    expect(offer.driver_id).toBeTruthy();
    const decision = (await db.query(`select decision from dispatch_decisions where ride_id=$1`, [ride.id])).rows[0].decision;
    expect(decision.explanation).toMatch(/was offered this ride/);
    const driver = offer.user_id === arjun.id ? arjun : meera;
    expect((await acceptOffer(ctx, offer.id, driver.id)).outcome).toBe('ACCEPTED');
    for (const s of ['arriving', 'start', 'complete'] as const) await driverStep(ctx, driver, ride.id, s);
    const r = (await db.query(`select status, final_fare_minor, quoted_fare_minor from rides where id=$1`, [ride.id])).rows[0];
    expect(r.status).toBe('COMPLETED');
    expect(r.final_fare_minor).toBe(r.quoted_fare_minor);
    const ev = (await db.query(`select to_status from ride_events where ride_id=$1 and event_type='STATUS_CHANGED' order by id`, [ride.id])).rows.map((e) => e.to_status);
    expect(ev).toEqual(['DISPATCHING', 'ACCEPTED', 'ARRIVING', 'ONGOING', 'COMPLETED']);
    await expect(db.query(`update ride_events set reason_code='x' where ride_id=$1`, [ride.id])).rejects.toThrow(/append-only/);
  });

  it('rejection offers the next candidate automatically', async () => {
    const ride = await book(priya);
    await jobs.drain();
    const first = await pendingOffer(ride.id);
    await rejectOffer(ctx, first.id, first.user_id);
    expect((await status(ride.id)).status).toBe('REASSIGNING');
    await jobs.drain();
    const second = await pendingOffer(ride.id);
    expect(second.driver_id).not.toBe(first.driver_id);
    expect((await status(ride.id)).status).toBe('DISPATCHING');
  });

  it('timeout expires the offer (idempotently) and re-dispatches', async () => {
    const ride = await book(priya);
    await jobs.drain();
    const first = await pendingOffer(ride.id);
    await db.query(`update dispatch_offers set expires_at=now()-interval '1 second' where id=$1`, [first.id]);
    await expireOffer(ctx, first.id);
    await expireOffer(ctx, first.id); // duplicate run is a no-op
    expect((await db.query(`select status from dispatch_offers where id=$1`, [first.id])).rows[0].status).toBe('EXPIRED');
    await jobs.drain();
    expect((await pendingOffer(ride.id)).driver_id).not.toBe(first.driver_id);
  });

  it('stale driver location invalidates a pending offer', async () => {
    const ride = await book(priya);
    await jobs.drain();
    const first = await pendingOffer(ride.id);
    await db.query(`update driver_locations set recorded_at=now()-interval '5 minutes' where driver_id=$1`, [first.driver_id]);
    await withdrawStaleOffers(ctx);
    expect((await db.query(`select status, response_reason from dispatch_offers where id=$1`, [first.id])).rows[0]).toEqual({ status: 'WITHDRAWN', response_reason: 'DRIVER_LOCATION_STALE' });
  });

  it('no eligible candidate → NO_DRIVER with explanation, then retry is possible', async () => {
    await db.query(`update drivers set availability_status='OFFLINE'`);
    const ride = await book(priya);
    await jobs.drain();
    expect((await status(ride.id)).status).toBe('NO_DRIVER');
    const ev = (await db.query(`select reason_code from ride_events where ride_id=$1 and to_status='NO_DRIVER'`, [ride.id])).rows[0];
    expect(ev.reason_code).toBe('NO_ELIGIBLE_DRIVERS');
  });
});

describe('concurrency & idempotency', () => {
  it('concurrent accepts of one offer: exactly one succeeds', async () => {
    const ride = await book(priya);
    await jobs.drain();
    const o = await pendingOffer(ride.id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => acceptOffer(ctx, o.id, o.user_id)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect((await db.query(`select count(*)::int n from rides where assigned_driver_id=$1 and status='ACCEPTED'`, [o.driver_id])).rows[0].n).toBe(1);
  });

  it('two concurrent rides can never claim the same driver', async () => {
    await db.query(`update drivers set availability_status='OFFLINE' where user_id=$1`, [meera.id]); // single eligible driver
    const [r1, r2] = await Promise.all([book(priya), book(rahul)]);
    await Promise.all([runDispatch(ctx, r1.id), runDispatch(ctx, r2.id)]);
    const pend = (await db.query(`select * from dispatch_offers where status='PENDING'`)).rows;
    expect(pend.length).toBe(1); // unique pending-offer-per-driver index
    await acceptOffer(ctx, pend[0].id, arjun.id);
    // force a second offer to the same (now busy) driver, bypassing dispatch, and try to accept it
    const other = pend[0].ride_id === r1.id ? r2 : r1;
    await db.query(`update rides set status='DISPATCHING' where id=$1`, [other.id]);
    const { rows } = await db.query(`insert into dispatch_offers (ride_id, driver_id, sequence, status, expires_at) values ($1,$2,99,'PENDING', now()+interval '1 minute') returning id`, [other.id, pend[0].driver_id]);
    await expect(acceptOffer(ctx, rows[0].id, arjun.id)).rejects.toMatchObject({ code: 'DRIVER_BUSY' });
    expect((await db.query(`select count(*)::int n from rides where assigned_driver_id=$1 and status in ('ACCEPTED','ARRIVING','ONGOING')`, [pend[0].driver_id])).rows[0].n).toBe(1);
  });

  it('duplicate ride submission with the same Idempotency-Key returns the original', async () => {
    const t = await token(priya.id);
    const send = (key: string, body = trip) => app.inject({ method: 'POST', url: '/api/v1/rides', headers: { authorization: `Bearer ${t}`, 'idempotency-key': key }, payload: body });
    const a = await send('key-12345678');
    const b = await send('key-12345678');
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect((await db.query(`select count(*)::int n from rides where passenger_id=$1`, [priya.id])).rows[0].n).toBe(1);
    expect((await send('key-12345678', { ...trip, seats: 2 })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/v1/rides', headers: { authorization: `Bearer ${t}` }, payload: trip })).statusCode).toBe(400);
  });
});

describe('authorization & live delivery', () => {
  it('users cannot read other riders\' rides; roles are enforced', async () => {
    const ride = await book(priya);
    const tr = await token(rahul.id);
    expect((await app.inject({ url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${tr}` } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/ops/overview', headers: { authorization: `Bearer ${tr}` } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/ops/overview' })).statusCode).toBe(401);
    const tp = await token(priya.id);
    const own = await app.inject({ url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${tp}` } });
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe(ride.id);
  });

  it('websocket is authenticated and role-scoped; outbox redelivery is deduped by clients', async () => {
    await app.listen({ port: 0 });
    const gateway = new Gateway(ctx);
    gateway.attach(app.server);
    const port = (app.server.address() as any).port;
    const open = (t?: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/live${t ? `?token=${t}` : ''}`);
      const msgs: any[] = [];
      ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
      ws.on('open', () => res({ ws, msgs }));
      ws.on('error', rej);
      ws.on('unexpected-response', () => rej(new Error('rejected')));
    });
    await expect(open()).rejects.toThrow();
    const rahulWs = await open(await token(rahul.id));
    const priyaWs = await open(await token(priya.id));
    await db.query(`delete from outbox_events`);
    const ride = await book(priya);
    const pub = new OutboxPublisher(db, gateway);
    await pub.tick();
    await db.query(`update outbox_events set published_at=null`); // simulate a crash before marking → redelivery
    await pub.tick();
    await new Promise((r) => setTimeout(r, 200));
    const priyaEvents = priyaWs.msgs.filter((m) => m.type === 'event' && m.event.entityId === ride.id);
    expect(priyaEvents.length).toBe(2); // at-least-once
    const gate = new EventVersionGate();
    expect(priyaEvents.filter((m) => gate.accept(m.event)).length).toBe(1); // applied once
    expect(rahulWs.msgs.some((m) => m.type === 'event' && m.event.entityId === ride.id)).toBe(false);
    rahulWs.ws.close();
    priyaWs.ws.close();
  });
});

describe('pooling', () => {
  it('offers a compatible shared ride and records an ordered stop plan', async () => {
    await db.query(`update drivers set availability_status='ONLINE' where is_bot and id in (select assigned_driver_id from rides where status='ONGOING')`);
    await db.query(`update drivers set availability_status='OFFLINE' where not is_bot`);
    const ride = await book(priya, { ...trip, poolOptIn: true });
    await jobs.drain();
    const o = await pendingOffer(ride.id);
    expect(o.pool_plan).toBeTruthy();
    expect(o.reason_codes).toContain('POOL_MATCH');
    expect((await acceptOffer(ctx, o.id, o.user_id)).outcome).toBe('ACCEPTED');
    const g = (await db.query(`select g.stop_plan, g.capacity from rides r join pool_groups g on g.id=r.pool_group_id where r.id=$1`, [ride.id])).rows[0];
    const kinds = g.stop_plan.filter((s: any) => s.rideId === ride.id).map((s: any) => s.kind);
    expect(kinds).toEqual(['PICKUP', 'DROPOFF']);
  });
  it('never pools without opt-in', async () => {
    await db.query(`update drivers set availability_status='ONLINE' where is_bot and id in (select assigned_driver_id from rides where status='ONGOING')`);
    const ride = await book(priya, { ...trip, poolOptIn: false });
    await jobs.drain();
    expect((await pendingOffer(ride.id))?.pool_plan ?? null).toBeNull();
  });
});
