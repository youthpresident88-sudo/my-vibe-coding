import type { Db, Queryable } from '../db/db.js';
import { PermanentError } from '../providers/http.js';

export interface Job {
  id: number;
  queue: string;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  q: Queryable,
  queue: string,
  payload: Record<string, unknown>,
  o: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await q.query(
    `insert into jobs (queue, payload, dedupe_key, run_at, max_attempts)
     values ($1, $2, $3, coalesce($4, now()), coalesce($5, 8))
     on conflict (dedupe_key) do nothing`,
    [queue, JSON.stringify(payload), o.dedupeKey ?? null, o.runAt ?? null, o.maxAttempts ?? null],
  );
}

/** Atomically claims up to n due jobs. Safe with many concurrent workers (SKIP LOCKED). Also reclaims jobs whose worker died. */
export async function claimJobs(q: Queryable, n: number): Promise<Job[]> {
  const r = await q.query<Job>(
    `update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
     where id in (
       select id from jobs
       where (status = 'pending' and run_at <= now())
          or (status = 'running' and locked_at < now() - interval '5 minutes')
       order by run_at, id
       limit $1
       for update skip locked)
     returning id, queue, payload, attempts, max_attempts`,
    [n],
  );
  return r.rows;
}

export async function completeJob(q: Queryable, id: number): Promise<void> {
  await q.query(`update jobs set status = 'done', finished_at = now(), last_error = null where id = $1`, [id]);
}

export async function failJob(q: Queryable, job: Job, err: unknown): Promise<'retry' | 'dead'> {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const dead = err instanceof PermanentError || job.attempts >= job.max_attempts;
  if (dead) {
    await q.query(`update jobs set status = 'dead', finished_at = now(), last_error = $2 where id = $1`, [job.id, msg]);
    return 'dead';
  }
  const backoffSec = Math.min(5 * 2 ** (job.attempts - 1), 3600);
  await q.query(
    `update jobs set status = 'pending', locked_at = null, last_error = $2,
       run_at = now() + make_interval(secs => $3) where id = $1`,
    [job.id, msg, backoffSec],
  );
  return 'retry';
}

export type JobHandler = (payload: Record<string, any>, job: Job) => Promise<void>;

export class Worker {
  private stopped = true;
  private loop?: Promise<void>;
  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly log: { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void },
    private readonly opts: { batch: number; idleMs: number } = { batch: 10, idleMs: 1000 },
  ) {}

  /** Processes one batch; returns the number of jobs handled. */
  async runOnce(): Promise<number> {
    const jobs = await claimJobs(this.db, this.opts.batch);
    for (const job of jobs) {
      const handler = this.handlers[job.queue];
      try {
        if (!handler) throw new PermanentError(`no handler for queue ${job.queue}`);
        await handler(job.payload, job);
        await completeJob(this.db, job.id);
      } catch (e) {
        const outcome = await failJob(this.db, job, e);
        this.log.error({ jobId: job.id, queue: job.queue, attempts: job.attempts, outcome, err: String(e) }, 'job failed');
      }
    }
    return jobs.length;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        let n = 0;
        try {
          n = await this.runOnce();
        } catch (e) {
          this.log.error({ err: String(e) }, 'worker loop error');
        }
        if (n === 0) await new Promise((r) => setTimeout(r, this.opts.idleMs));
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
