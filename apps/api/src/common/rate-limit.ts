import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

/** Fixed-window per (principal, bucket) limiter. In-process — good enough for one API instance. */
const windows = new Map<string, { start: number; n: number }>();
export function rateLimit(bucket: string, perMinute: number) {
  return async (req: FastifyRequest) => {
    if (process.env.RATE_LIMIT === 'off') return;
    const who = req.user?.id ?? req.ip;
    const key = `${bucket}:${who}`;
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start > 60_000) windows.set(key, { start: now, n: 1 });
    else if (++w.n > perMinute) throw new AppError(429, 'RATE_LIMITED', 'Too many requests — slow down and retry shortly', { retryAfterSeconds: Math.ceil((60_000 - (now - w.start)) / 1000) });
    if (windows.size > 20_000) windows.clear();
  };
}
