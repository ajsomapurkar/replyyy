import type { Pool } from 'pg';
import type { Queryable } from '../database/db.js';
import { logger } from '../common/logger.js';
import { metrics } from '../common/metrics.js';

export type JobType = 'DISPATCH_RIDE' | 'EXPIRE_OFFER';

export async function enqueue(c: Queryable, type: JobType, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string } = {}) {
  await c.query(
    `insert into jobs (type, payload, run_at, dedupe_key) values ($1,$2,coalesce($3, now()),$4)
     on conflict (dedupe_key) where dedupe_key is not null and status = 'QUEUED' do nothing`,
    [type, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null],
  );
}

export type JobHandler = (payload: any) => Promise<void>;

/**
 * Durable DB-backed job runner. Claims with FOR UPDATE SKIP LOCKED so several workers are safe;
 * jobs whose lease expired (crashed worker) are reclaimed. Handlers must be idempotent.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  lastTickAt = 0;
  constructor(private db: Pool, private handlers: Record<JobType, JobHandler>, private intervalMs = 200) {}
  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.lastTickAt = Date.now();
    try {
      const { rows } = await this.db.query(
        `update jobs set status='RUNNING', attempts=attempts+1, locked_until=now()+interval '30 seconds'
          where id in (select id from jobs where (status='QUEUED' and run_at<=now()) or (status='RUNNING' and locked_until<now())
                       order by run_at limit 20 for update skip locked)
          returning id, type, payload, attempts`,
      );
      await Promise.all(
        rows.map(async (j) => {
          try {
            await this.handlers[j.type as JobType](j.payload);
            await this.db.query(`update jobs set status='DONE', locked_until=null where id=$1`, [j.id]);
          } catch (e: any) {
            logger.error('job.failed', { jobId: j.id, type: j.type, error: String(e?.message ?? e) });
            const final = j.attempts >= 5;
            await this.db.query(
              `update jobs set status=$2, last_error=$3, run_at=now()+interval '1 second'*$4, locked_until=null where id=$1`,
              [j.id, final ? 'FAILED' : 'QUEUED', String(e?.message ?? e), 2 ** j.attempts],
            );
          }
        }),
      );
      return rows.length;
    } finally {
      this.running = false;
    }
  }
  async lagSeconds(): Promise<number> {
    const { rows } = await this.db.query(`select extract(epoch from now()-min(run_at)) lag from jobs where status='QUEUED' and run_at<=now()`);
    return Math.max(0, Number(rows[0]?.lag ?? 0));
  }
  /** Test helper: drain everything that is due. */
  async drain(max = 50) {
    for (let i = 0; i < max; i++) if ((await this.tick()) === 0) return;
  }
}
export { metrics };
