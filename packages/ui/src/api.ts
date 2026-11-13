import { useEffect, useRef, useState } from 'react';
import { EventVersionGate, type LiveEvent } from '@relay/contracts';
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export interface Session { token: string; user: { id: string; role: 'PASSENGER' | 'DRIVER' | 'OPERATOR' | 'ADMIN'; displayName: string; driverId?: string } }
const BASE: string = ((import.meta as any).env?.BASE_URL as string | undefined) ?? '/';
const KEY = BASE === '/' ? 'relay.session' : `relay.session:${BASE}`;
export const getSession = (): Session | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
export const setSession = (s: Session | null) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {} };

export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const s = getSession();
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).catch(() => { throw new ApiError(0, 'NETWORK', 'Cannot reach Relay — check your connection'); });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && s) { setSession(null); location.reload(); }
    throw new ApiError(res.status, data.code ?? 'ERROR', data.message ?? 'Request failed', data.details);
  }
  return data as T;
}
export const post = <T = any>(path: string, body: unknown = {}, idempotencyKey?: string) => api<T>(path, { method: 'POST', body, idempotencyKey });

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline';
type Listener = (e: LiveEvent) => void;

/** One socket per tab. Dedupes/orders events, reconnects with backoff, and invalidates queries on reconnect (canonical resync). */
class Live {
  ws: WebSocket | null = null;
  state: ConnState = 'connecting';
  gate = new EventVersionGate();
  listeners = new Set<Listener>();
  stateListeners = new Set<(s: ConnState) => void>();
  attempts = 0;
  everConnected = false;
  timer: any;
  lastMessageAt = 0;
  connect() {
    const s = getSession();
    if (!s || this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/live?token=${encodeURIComponent(s.token)}${this.everConnected ? '&reconnect=1' : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      if (this.everConnected) { this.gate.reset(); queryClient.invalidateQueries(); }
      this.everConnected = true;
      this.setState('live');
    };
    ws.onmessage = (m) => {
      this.lastMessageAt = Date.now();
      const msg = JSON.parse(m.data);
      if (msg.type !== 'event') return;
      const e = msg.event as LiveEvent;
      if (e.type !== 'driver.location_updated' && !this.gate.accept(e)) return;
      this.listeners.forEach((l) => l(e));
    };
    ws.onclose = () => {
      this.ws = null;
      if (!getSession()) return;
      this.setState(navigator.onLine ? 'reconnecting' : 'offline');
      const delay = Math.min(10_000, 500 * 2 ** this.attempts++);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
  close() { clearTimeout(this.timer); const w = this.ws; this.ws = null; w?.close(); this.everConnected = false; this.setState('connecting'); }
  setState(s: ConnState) { this.state = s; this.stateListeners.forEach((l) => l(s)); }
}
export const live = new Live();

export function useLive(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    live.connect();
    const l: Listener = (e) => ref.current(e);
    live.listeners.add(l);
    return () => { live.listeners.delete(l); };
  }, []);
}
export function useConnection() {
  const [s, setS] = useState<ConnState>(live.state);
  useEffect(() => { live.stateListeners.add(setS); live.connect(); return () => { live.stateListeners.delete(setS); }; }, []);
  return s;
}
export function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
