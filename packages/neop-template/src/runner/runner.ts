// THE RUNNER · template-only · always on · holds no model.
// Turns inbound calls and timers into jobs (via L3), claims runnable jobs,
// hands each to a fresh assistant session with a job token, expires the late,
// reconciles UNKNOWN outcomes. The poll is the truth; NOTIFY is latency.

import type { JobTokenClaims, TaskResult } from '@neop/contracts';
import pg from 'pg';
import { buildBundle } from '../agent/context.ts';
import { reconcileUnknown } from '../capabilities/execute.ts';
import type { Core } from '../core.ts';
import type { JobRow, ProposalRow } from '../data/book.ts';

export class Runner {
  readonly core: Core;
  /** Sessions this runner started and that have not ended yet. */
  readonly active = new Map<string, { job_id: string; company_id: string }>();
  private timers: NodeJS.Timeout[] = [];
  private listener: pg.Client | null = null;
  private ticking = false;
  private again = false;
  private stopped = false;

  constructor(core: Core) {
    this.core = core;
  }

  private get s(): string {
    return this.core.key;
  }

  async start(): Promise<void> {
    const t = this.core.cfg.timings;
    // One direct session connection for LISTEN (it does not work through a transaction pooler, S8).
    this.listener = new pg.Client({ connectionString: this.core.cfg.runnerDbUrl });
    this.listener.on('error', () => {});
    await this.listener.connect();
    this.listener.on('notification', () => this.kick());
    await this.listener.query(`listen ${this.core.book.channel}`);
    this.timers.push(setInterval(() => this.kick(), t.pollMs));
    this.every(t.expiryMs, () => this.expire(), 'expiry');
    this.every(t.reconcileMs, () => this.reconcile(), 'reconcile');
    this.every(60_000, () => this.core.gatewayAuth.pruneSeen(), 'prune');
    this.kick();
  }

  /** A loop that never overlaps itself. */
  private every(ms: number, fn: () => Promise<unknown>, name: string): void {
    let busy = false;
    this.timers.push(
      setInterval(() => {
        if (busy || this.stopped) return;
        busy = true;
        void fn()
          .catch((e) => this.core.log(`${name} failed`, { e: String(e) }))
          .finally(() => (busy = false));
      }, ms),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.listener?.end().catch(() => {});
    this.listener = null;
  }

  /** Coalesce hints and polls into one tick at a time. */
  kick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    void this.tick()
      .catch((e) => this.core.log('tick failed', { e: String(e) }))
      .finally(() => {
        this.ticking = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  async tick(): Promise<number> {
    const free = this.core.cfg.poolSize - this.active.size;
    if (free <= 0) return 0;
    const claimed = await this.claim(free);
    await Promise.all(claimed.map((j) => this.spawn(j)));
    return claimed.length;
  }

  /** Claim runnable jobs with SKIP LOCKED; a claimed job is invisible to other runners. */
  async claim(n: number): Promise<JobRow[]> {
    const client = await this.core.runnerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<JobRow>(
        `with c as (
           select j.id, j.status as prev_status from ${this.s}.jobs j
            where (j.claimed_until is null or j.claimed_until < now())
              and (j.status in ('RECEIVED', 'RUNNING')
                   or (j.status = 'WAITING' and exists (select 1 from ${this.s}.waits w where w.job_id = j.id and w.status = 'ready')))
            order by j.updated_at
            for update skip locked
            limit $1)
         update ${this.s}.jobs j
            set attempts = j.attempts + (case when j.status = 'RUNNING' then 1 else 0 end),
                status = 'RUNNING',
                claimed_by = $2 || ':' || gen_random_uuid()::text,
                claimed_until = now() + ($3 || ' milliseconds')::interval,
                updated_at = now()
           from c where j.id = c.id
         returning j.*, c.prev_status`,
        [n, this.core.cfg.runnerId, String(this.core.cfg.timings.claimMs)],
      );
      for (const j of rows) {
        await client.query(
          `update ${this.s}.waits set claimed_by = $2, claimed_until = $3 where job_id = $1 and status = 'ready'`,
          [j.id, j.claimed_by, j.claimed_until],
        );
      }
      await client.query('commit');
      return rows;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The job could not be handed to an assistant (pool full, agent unreachable):
   * not the job's fault, so it is not counted as an interrupted attempt, and it
   * waits a moment instead of bouncing straight back.
   */
  private async release(job: JobRow & { prev_status?: string }): Promise<void> {
    await this.core.runnerPool.query(
      `update ${this.s}.jobs set claimed_until = now() + interval '1 second', attempts = greatest(attempts - $3, 0) where id = $1 and claimed_by = $2`,
      [job.id, job.claimed_by, job.prev_status === 'RUNNING' ? 1 : 0],
    );
  }

  private async fail(job: JobRow, summary: string): Promise<void> {
    const result: TaskResult = { outcome: 'failed', summary, changed: [], could_not: [job.ask], sources: [] };
    await this.core.company(job.company_id, async (c) => {
      await this.core.book.consumeReadyWaits(c, job.id);
      await this.core.book.addStep(c, { company_id: job.company_id, job_id: job.id, kind: 'failed', summary });
      await this.core.book.setJobStatus(c, job.id, 'FAILED', { result, clearClaim: true });
      await this.core.book.emit(c, job.company_id, 'task.failed', { job_id: job.id, task_id: job.task_id, result }, `finish:${job.id}`);
    });
  }

  async spawn(job: JobRow): Promise<void> {
    const sid = job.claimed_by!;
    const span = this.core.tracer.start('runner.spawn', job.trace_id, { 'neop.job': job.id, 'neop.attempt': job.attempts });
    try {
      if (job.attempts >= this.core.cfg.timings.maxAttempts) {
        await this.fail(job, `Stopped after ${job.attempts} interrupted attempts; nothing further was done. A person should look at this job.`);
        return;
      }
      const board = await this.core.board.get(job.company_id);
      const perDay = board.budget.per_day_usd ?? 50;
      const spent = await this.core.company(job.company_id, async (c) => {
        const r = await c.query<{ micros: number }>(
          `select coalesce(sum(spend_micros), 0)::bigint as micros from ${this.s}.jobs
            where created_at >= date_trunc('day', now() at time zone $1) at time zone $1`,
          [board.company.time_zone],
        );
        return r.rows[0]!.micros;
      });
      if (spent > perDay * 1_000_000) {
        await this.fail(job, `The daily model budget for ${this.core.manifest.name} ($${perDay}) is used up; the job was not started.`);
        return;
      }
      const bundle = await this.core.company(job.company_id, async (c) => {
        const first = await buildBundle(this.core, c, job, board);
        // Write why this session exists before the assistant reads the book.
        if (first.wake) {
          const p = first.wake.proposal;
          if (p) await this.core.book.proposalEvent(c, { company_id: job.company_id, proposal_id: p.id, event: 'resumed', actor: `runner:${this.core.cfg.runnerId}`, detail: { status: p.status } });
          await this.core.book.addStep(c, {
            company_id: job.company_id,
            job_id: job.id,
            kind: 'resume',
            summary: p ? `Woken: proposal ${p.id.slice(0, 8)} is ${p.status}${p.decided_by ? ` (${p.decided_by})` : ''}` : `Woken: ${first.wake.kind} ${first.wake.outcome}`,
          });
        } else if (job.attempts > 0) {
          await this.core.book.addStep(c, { company_id: job.company_id, job_id: job.id, kind: 'resume', summary: `Resumed after an interrupted session (attempt ${job.attempts + 1})` });
        } else {
          return first;
        }
        return buildBundle(this.core, c, job, board);
      });
      const abilities = bundle.tools.filter((t) => t.kind !== 'builtin').map((t) => t.key);
      const token = await this.core.jobTokens.mint(
        { sub: job.id, sid, company_id: job.company_id, abilities },
        this.core.cfg.timings.sessionMaxMs + 60_000,
      );
      // The agent's only model credential: a platform-signed, budgeted session token (R1).
      const llm = await this.core.platform.llmSession({
        company_id: job.company_id,
        job_id: job.id,
        sid,
        ttl_seconds: Math.ceil(this.core.cfg.timings.sessionMaxMs / 1000) + 60,
      });
      this.active.set(sid, { job_id: job.id, company_id: job.company_id });
      const res = await fetch(`${this.core.cfg.agentUrl.replace(/\/$/, '')}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: { ...bundle, trace: span.header() }, token, gate_url: this.core.cfg.gateUrl, llm }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status !== 202) throw new Error(`agent pool refused: ${res.status}`);
      span.end();
    } catch (e) {
      span.end('error', String(e));
      this.active.delete(sid);
      this.core.log('spawn failed; job released', { job: job.id, e: String(e) });
      await this.release(job).catch(() => {});
    }
  }

  /** Called by the gate when an assistant session ends, however it ended. */
  async onSessionEnd(claims: JobTokenClaims, reason: string): Promise<void> {
    this.active.delete(claims.sid);
    const transient = reason.startsWith('transient');
    await this.core.company(claims.company_id, async (c) => {
      const job = await this.core.book.getJob(c, claims.sub, true);
      if (!job || job.claimed_by !== claims.sid) return;
      if (job.status === 'RUNNING') {
        if (transient) {
          await c.query(`update ${this.s}.jobs set claimed_until = now() - interval '1 second' where id = $1`, [job.id]);
          return;
        }
        const pending = (await this.core.book.openWaits(c, job.id)).filter((w) => w.status === 'pending');
        if (!pending.length) {
          const summary = `The assistant stopped without reporting (${reason}). Nothing further was done.`;
          const result: TaskResult = { outcome: 'failed', summary, changed: [], could_not: [job.ask], sources: [] };
          await this.core.book.consumeReadyWaits(c, job.id);
          await this.core.book.addStep(c, { company_id: job.company_id, job_id: job.id, kind: 'failed', summary });
          await this.core.book.setJobStatus(c, job.id, 'FAILED', { result, clearClaim: true });
          await this.core.book.emit(c, job.company_id, 'task.failed', { job_id: job.id, task_id: job.task_id, result }, `finish:${job.id}`);
          return;
        }
      }
      await c.query(`update ${this.s}.jobs set claimed_by = null, claimed_until = null where id = $1`, [job.id]);
    });
    this.kick();
  }

  /** Waits past their deadline (database time, never the app clock). */
  async expire(): Promise<number> {
    const client = await this.core.runnerPool.connect();
    let n = 0;
    try {
      await client.query('begin');
      const expired = await client.query<ProposalRow>(
        `update ${this.s}.proposals set status = 'EXPIRED', updated_at = now()
          where status = 'PROPOSED' and expires_at < now() returning *`,
      );
      for (const p of expired.rows) {
        await this.core.book.proposalEvent(client, { company_id: p.company_id, proposal_id: p.id, event: 'expired', actor: 'runner:clock' });
        await this.core.book.readyWait(client, p.id, 'EXPIRED', { proposal_id: p.id, status: 'EXPIRED', decided_by: null });
        await this.core.book.addStep(client, { company_id: p.company_id, job_id: p.job_id, kind: 'system', summary: `Proposal ${p.id.slice(0, 8)} expired: nobody answered in time.` });
        await this.core.book.emit(client, p.company_id, 'proposal.expired', { proposal_id: p.id, job_id: p.job_id }, `expired:${p.id}`);
        n++;
      }
      const a2a = await client.query(
        `update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = 'EXPIRED', answer = '{"status":"EXPIRED","result":null}'
          where kind = 'a2a_task' and status = 'pending' and expires_at < now()`,
      );
      n += a2a.rowCount ?? 0;
      const timers = await client.query(
        `update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = 'TIMER', answer = '{"timer":true}'
          where kind = 'timer' and status = 'pending' and expires_at < now()`,
      );
      n += timers.rowCount ?? 0;
      if (n) await this.core.book.notify(client, 'expiry');
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return n;
  }

  async reconcile(): Promise<void> {
    const { rows } = await this.core.runnerPool.query<ProposalRow>(`select * from ${this.s}.proposals where status = 'UNKNOWN' order by updated_at limit 20`);
    for (const p of rows) await reconcileUnknown(this.core, p);
  }
}
