import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import type { LiveEvent } from '@relay/contracts';
import type { Ctx } from '../common/context.js';
import { userFromToken } from '../modules/auth/auth.service.js';
import type { AuthUser } from '../modules/rides/rides.service.js';
import { metrics } from '../common/metrics.js';
import { logger } from '../common/logger.js';

interface Client {
  ws: WebSocket;
  user: AuthUser;
}
export interface LocationItem {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
}

/** Authenticated, role-scoped WebSocket fan-out. Events are at-least-once; clients dedupe by eventId/version. */
export class Gateway {
  private clients = new Set<Client>();
  private wss: WebSocketServer | null = null;
  private passengerDriver = new Map<string, string>(); // passenger user → assigned driver id
  constructor(private ctx: Ctx) {}

  attach(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname !== '/api/v1/live') return;
      const user = await userFromToken(this.ctx, url.searchParams.get('token') ?? undefined).catch(() => null);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user };
        this.clients.add(client);
        metrics.inc('wsConnections');
        if (url.searchParams.get('reconnect') === '1') metrics.inc('wsReconnects');
        ws.send(JSON.stringify({ type: 'hello', user: { id: user.id, role: user.role }, serverTime: new Date().toISOString() }));
        ws.on('message', (m) => {
          try {
            if (JSON.parse(String(m)).type === 'ping') ws.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
          } catch {}
        });
        ws.on('close', () => this.clients.delete(client));
        ws.on('error', () => this.clients.delete(client));
      });
    });
  }

  get connectionCount() {
    return this.clients.size;
  }

  deliver(e: LiveEvent, audience: { roles: string[]; userIds: string[] }): number {
    let n = 0;
    const msg = JSON.stringify({ type: 'event', event: e });
    for (const c of this.clients) {
      if (audience.roles.includes(c.user.role) || audience.userIds.includes(c.user.id)) {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(msg);
          n++;
        }
      }
    }
    return n;
  }

  setPassengerDrivers(map: Map<string, string>) {
    this.passengerDriver = map;
  }

  /** High-frequency, ephemeral positions (not via outbox). Passengers only receive their own driver. */
  broadcastLocations(items: LocationItem[]) {
    if (!items.length || !this.clients.size) return;
    const at = new Date().toISOString();
    const byId = new Map(items.map((i) => [i.driverId, i]));
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      let list: LocationItem[] = [];
      if (c.user.role === 'OPERATOR' || c.user.role === 'ADMIN') list = items;
      else if (c.user.role === 'DRIVER' && c.user.driverId) list = byId.has(c.user.driverId) ? [byId.get(c.user.driverId)!] : [];
      else {
        const d = this.passengerDriver.get(c.user.id);
        list = d && byId.has(d) ? [byId.get(d)!] : [];
      }
      if (list.length) c.ws.send(JSON.stringify({ type: 'event', event: { eventId: `loc:${at}`, type: 'driver.location_updated', occurredAt: at, entityId: 'fleet', version: Date.now(), payload: { drivers: list } } }));
    }
  }
}

/** Polls the outbox and publishes. Marking happens after delivery ⇒ at-least-once. */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private db: Pool, private gateway: Pick<Gateway, 'deliver'>, private intervalMs = 120) {}
  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => logger.error('outbox.tick', { error: String(e) })), this.intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    const client = await this.db.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `select * from outbox_events where published_at is null order by created_at, id limit 200 for update skip locked`,
      );
      for (const r of rows) {
        this.gateway.deliver({ eventId: r.id, type: r.type, occurredAt: r.created_at.toISOString(), entityId: r.entity_id, version: r.version, payload: r.payload }, r.audience);
      }
      if (rows.length) await client.query(`update outbox_events set published_at=now(), attempts=attempts+1 where id = any($1)`, [rows.map((r) => r.id)]);
      await client.query('commit');
      return rows.length;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
      this.busy = false;
    }
  }
  async lagSeconds() {
    const { rows } = await this.db.query(`select extract(epoch from now()-min(created_at)) lag from outbox_events where published_at is null`);
    return Number(rows[0]?.lag ?? 0);
  }
}
