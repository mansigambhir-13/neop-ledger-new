// THE RUNNER · template-only · always on · holds no model.
// Turns inbound calls and timers into jobs (via L3 and schedules), claims
// runnable jobs, hands each to a fresh assistant session with a job token,
// expires the late, reconciles UNKNOWN outcomes. The poll is the truth; NOTIFY
// is latency.

import type { JobTokenClaims, TaskResult } from '@neop/contracts';
import pg from 'pg';
import { buildBundle } from '../agent/context.ts';
import { reconcileUnknown } from '../capabilities/execute.ts';
import type { Core } from '../core.ts';
import type { JobRow, ProposalRow, WaitRow } from '../data/book.ts';

/** A timer job not started within this long of its slot is EXPIRED, not run stale (WP §7, t004). */
export const TIMER_WINDOW = '1 hour';

interface Meter {
  job_spent_micros: number;
  job_reserved_micros: number;
  job_budget_micros: number;
  day_spent_micros: number;
  day_reserved_micros: number;
  day_cap_micros: number;
}
const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;

export class Runner {
  readonly core: Core;
  /** Sessions this runner started and that have not ended yet. */
  readonly active = new Map<string, { job_id: string; company_id: string; llm: { base_url: string; token: string } | null }>();
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
    this.listener = new pg.Client({ connectionString: this.core.cfg.directDbUrl ?? this.core.cfg.runnerDbUrl });
    this.listener.on('error', () => {});
    await this.listener.connect();
    this.listener.on('notification', () => this.kick());
    await this.listener.query(`listen ${this.core.book.channel}`);
    this.timers.push(setInterval(() => this.kick(), t.pollMs));
    this.every(t.expiryMs, () => this.expire(), 'expiry');
    this.every(t.expiryMs, () => this.fireSchedules(), 'schedules');
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
              and (j.status <> 'RECEIVED' or j.run_by is null or j.run_by >= now())
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
      // The board this session runs on, kept with the job (t007): what was on, at which version.
      await this.core.runnerPool.query(`update ${this.s}.jobs set switchboard_version = $2, switchboard_snapshot = $3 where id = $1`, [job.id, board.version, JSON.stringify(board.snapshot())]);
      // The agent's only model credential: a platform-signed, budgeted session token (R1).
      const llm = await this.core.platform.llmSession({
        company_id: job.company_id,
        job_id: job.id,
        sid,
        ttl_seconds: Math.ceil(this.core.cfg.timings.sessionMaxMs / 1000) + 60,
      });
      // Spend is what the proxy metered for this job, across all its sessions (S9, item 12).
      const m = llm ? await this.meter(llm) : null;
      if (m) {
        await this.core.runnerPool.query(`update ${this.s}.jobs set spend_micros = $2 where id = $1`, [job.id, m.job_spent_micros]);
        if (m.job_spent_micros + m.job_reserved_micros >= m.job_budget_micros) {
          await this.fail(job, `Stopped: NEOS budget reached — the model budget for this job (${usd(m.job_budget_micros)}) is used up. Nothing further was done.`);
          return;
        }
        if (m.day_spent_micros + m.day_reserved_micros >= m.day_cap_micros) {
          await this.fail(job, `Stopped: NEOS budget reached — today's model budget for ${this.core.manifest.name} (${usd(m.day_cap_micros)}) is used up; the job was not started.`);
          return;
        }
      }
      const bundle = await this.core.company(job.company_id, async (c) => {
        const first = await buildBundle(this.core, c, job, board, { persist: false });
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
        } else if (!first.older_steps_summary) {
          return first; // a fresh job: nothing to write, no second build on the hot path
        }
        // Built again once the resume step is written, and only now is the rolling summary written (once per session).
        return buildBundle(this.core, c, job, board);
      });
      const abilities = bundle.tools.filter((t) => t.kind !== 'builtin').map((t) => t.key);
      const token = await this.core.jobTokens.mint(
        { sub: job.id, sid, company_id: job.company_id, abilities },
        this.core.cfg.timings.sessionMaxMs + 60_000,
      );
      this.active.set(sid, { job_id: job.id, company_id: job.company_id, llm });
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

  /** The proxy's meter for this job and day; null when unreachable (the proxy still enforces). */
  private async meter(llm: { base_url: string; token: string }): Promise<Meter | null> {
    try {
      const res = await fetch(`${llm.base_url.replace(/\/$/, '')}/v1/spend`, { headers: { 'x-api-key': llm.token }, signal: AbortSignal.timeout(5_000) });
      return res.ok ? ((await res.json()) as Meter) : null;
    } catch {
      return null;
    }
  }

  /** Called by the gate when an assistant session ends, however it ended. */
  async onSessionEnd(claims: JobTokenClaims, reason: string): Promise<void> {
    const llm = this.active.get(claims.sid)?.llm ?? null;
    this.active.delete(claims.sid);
    if (llm) {
      const m = await this.meter(llm);
      if (m) await this.core.runnerPool.query(`update ${this.s}.jobs set spend_micros = $2 where id = $1`, [claims.sub, m.job_spent_micros]).catch(() => {});
    }
    const transient = reason.startsWith('transient');
    // A 402 from the proxy is final (S9): retrying would spend nothing and say nothing.
    const budget = reason.startsWith('budget:') ? reason.slice('budget:'.length) : null;
    await this.core.company(claims.company_id, async (c) => {
      const job = await this.core.book.getJob(c, claims.sub, true);
      if (!job || job.claimed_by !== claims.sid) return;
      if (job.status === 'RUNNING') {
        if (transient) {
          // Back off before the next attempt (found live: a one-minute outage burned all attempts in seconds).
          const steps = this.core.cfg.timings.retryBackoffMs ?? [0];
          const wait = steps[Math.min(Math.max(job.attempts, 0), steps.length - 1)] ?? 0;
          await c.query(`update ${this.s}.jobs set claimed_until = now() + ($2 || ' milliseconds')::interval where id = $1`, [job.id, String(wait)]);
          await this.core.book.addStep(c, { company_id: job.company_id, job_id: job.id, kind: 'system', summary: `The model could not be reached (${reason.slice(0, 120)}); trying again in ${Math.round(wait / 1000)} s (attempt ${job.attempts + 1} of ${this.core.cfg.timings.maxAttempts}).` });
          return;
        }
        const pending = (await this.core.book.openWaits(c, job.id)).filter((w) => w.status === 'pending');
        if (!pending.length || budget) {
          const summary = budget
            ? `Stopped: NEOS budget reached — ${budget} is used up. Nothing further was done; a person can raise the budget and ask again.`
            : `The assistant stopped without reporting (${reason}). Nothing further was done.`;
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
        `update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = 'TIMER', answer = coalesce(answer, '{}'::jsonb) || '{"timer":true}'
          where kind = 'timer' and status = 'pending' and expires_at < now()`,
      );
      n += timers.rowCount ?? 0;
      // A question nobody answered in time wakes its job to say so (WP §5 "waiting is a real state, with a clock").
      const questions = await client.query<WaitRow & { task_id: string | null }>(
        `with w as (
           update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = 'EXPIRED',
                  answer = jsonb_build_object('wait_id', id, 'question', question, 'answers', null, 'expired', true)
            where kind = 'input' and status = 'pending' and expires_at < now() returning *)
         select w.*, j.task_id from w join ${this.s}.jobs j on j.id = w.job_id`,
      );
      for (const w of questions.rows) {
        await this.core.book.addStep(client, { company_id: w.company_id, job_id: w.job_id, kind: 'system', summary: `Question ${w.id.slice(0, 8)} expired: nobody answered by ${w.expires_at.toISOString()}.` });
        await this.core.book.emit(client, w.company_id, 'question.expired', { wait_id: w.id, job_id: w.job_id, task_id: w.task_id }, `question-expired:${w.id}`);
        n++;
      }
      // A timer job that did not start inside its window (an outage) is skipped, not run late.
      const stale = await client.query<JobRow>(
        `update ${this.s}.jobs set status = 'EXPIRED', updated_at = now(), claimed_by = null, claimed_until = null
          where status = 'RECEIVED' and run_by < now() and (claimed_until is null or claimed_until < now())
          returning *`,
      );
      for (const j of stale.rows) {
        const summary = `Skipped: this scheduled run was due by ${j.run_by!.toISOString()} and did not start in time, so it was not run late. The next one runs as scheduled.`;
        const result: TaskResult = { outcome: 'failed', summary, changed: [], could_not: [j.ask], sources: [] };
        await client.query(`update ${this.s}.jobs set result = $2 where id = $1`, [j.id, JSON.stringify(result)]);
        await this.core.book.addStep(client, { company_id: j.company_id, job_id: j.id, kind: 'failed', summary });
        await this.core.book.emit(client, j.company_id, 'task.failed', { job_id: j.id, task_id: j.task_id, result, expired: true }, `finish:${j.id}`);
        n++;
      }
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

  /**
   * WP §7: a scheduled time arriving starts a job. One job per (schedule, slot):
   * the task id is derived from both, so a second tick, a second runner or a
   * restart finds the same job. next_run_at advances on database time.
   */
  async fireSchedules(): Promise<number> {
    const client = await this.core.runnerPool.connect();
    let n = 0;
    try {
      await client.query('begin');
      const due = await client.query<{ id: string; company_id: string; ask: string; requester: string; task_id: string; run_by: Date }>(
        `select id, company_id, ask, requester,
                md5(id::text || ':' || extract(epoch from next_run_at)::bigint::text)::uuid::text as task_id,
                next_run_at + interval '${TIMER_WINDOW}' as run_by
           from ${this.s}.schedules where enabled and next_run_at <= now()
          order by next_run_at for update skip locked limit 50`,
      );
      for (const s of due.rows) {
        const { job, created } = await this.core.book.openJobAtomic(client, { company_id: s.company_id, source: 'timer', requester: s.requester, task_id: s.task_id, ask: s.ask, origin: 'timer' });
        if (created) {
          await client.query(`update ${this.s}.jobs set run_by = $2 where id = $1`, [job.id, s.run_by]);
          n++;
        }
        await client.query(
          `update ${this.s}.schedules set last_run_at = next_run_at, next_run_at = ${this.s}.next_run(rule, time_zone, greatest(now(), next_run_at)), updated_at = now()
            where id = $1`,
          [s.id],
        );
      }
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
