import {sqlIdent} from '@neop/pgkit';
// THE APPROVED PATH IN THE RUNNER · v3 §5–§7 (V3-MIGRATION-PLAN S2).
// A person's yes lands on the proposal row through <schema>.answer_proposal() (desk or their own room) and
// the row says APPROVED. Nothing else is sent anywhere: this loop notices it (the 'approved:<id>' NOTIFY is a
// hint; the poll of APPROVED rows is the truth), claims it (FOR UPDATE SKIP LOCKED, then the execution
// advisory lock, which lives as long as this runner's connection), and carries it out once through
// capabilities/execute.ts — fingerprint and expiry checked against the book at effect time, operations
// idempotency, read-back, DONE / FAILED / UNKNOWN. Only then is the wait made ready, and the runner's job loop
// wakes a fresh assistant with the proof. No platform, no execution token, no model between the yes and the
// effect.
//
// Also claimed: a proposal left EXECUTING by an executor that died (its advisory lock went with its
// connection) — resumed read-back first; and a grant-approved proposal left APPROVED past APPROVED_GRANT_GRACE
// (the gate carries a standing yes out inline, through the same execute; this adopts one whose gate died
// between the commit and the effect).

import type { PoolClient } from '@neop/pgkit';
import { ExecError, execLockKey, executeHeld } from '../capabilities/execute.ts';
import type { Core } from '../core.ts';

/** How long the gate has to carry out a standing yes inline before the runner adopts it. */
export const APPROVED_GRANT_GRACE = '30 seconds';

interface Claimed {
  lock: PoolClient;
  id: string;
  company_id: string;
  status: string;
}

export class ApprovedPath {
  private readonly core: Core;
  private busy = false;
  private again = false;
  private stopped = false;
  private paused = false;
  /** Executions this runner has in flight (each holds one exec-lock connection). */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(core: Core) {
    this.core = core;
  }

  private get s(): string {
    return this.core.key;
  }

  /** `runner:<id>` — who carried it out, in proposal_events and operations. */
  get actor(): string {
    return `runner:${this.core.cfg.runnerId}`;
  }

  /** How many executions at once: leave one exec-lock connection for the gate's inline standing yeses. */
  private get capacity(): number {
    return Math.max(1, (this.core.cfg.execLockPoolSize ?? 10) - 1);
  }

  /** A hint (NOTIFY 'approved:<id>', a poll): run one pass now, or once more after the current one. */
  kick(): void {
    if (this.stopped || this.paused) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    void this.tick()
      .catch((e) => this.core.log('approved path failed', { e: String(e) }))
      .finally(() => {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /**
   * Stop claiming. Executions in flight are not awaited: Core.close() gives them a bounded time and then
   * abandons them exactly as a crash would (the connection closes, the execution lock goes with it, and the
   * next runner resumes the proposal read-back first).
   */
  stop(): void {
    this.stopped = true;
  }

  /** Hold claiming without stopping the runner (ops, tests): a yes stays APPROVED until resume(). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.kick();
  }

  /**
   * One pass: claim what is approved (or orphaned) and start carrying each out, up to capacity. Returns how
   * many were claimed. `wait` resolves when those executions have finished (tests; stop()).
   */
  async tick(opts: { wait?: boolean } = {}): Promise<number> {
    const skip: string[] = [];
    const started: Promise<unknown>[] = [];
    while (!this.stopped && !this.paused && this.inFlight.size < this.capacity) {
      const c = await this.claimOne(skip);
      if (!c) break;
      skip.push(c.id);
      const run = this.carryOut(c);
      this.inFlight.add(run);
      void run.finally(() => this.inFlight.delete(run));
      started.push(run);
    }
    if (opts.wait) await Promise.allSettled(started);
    return started.length;
  }

  /**
   * Claim one proposal: the candidate rows are locked FOR UPDATE SKIP LOCKED (a withdrawal or another runner
   * holding one is passed over), and the first whose execution lock this runner can take is the claim — the
   * session-level lock survives the claim's commit and ends with this connection, so a live executor elsewhere
   * is never doubled and a dead one is resumed.
   */
  private async claimOne(skip: string[]): Promise<Claimed | null> {
    const lock = await this.core.execLockPool.connect();
    let claimed: Claimed | null = null;
    try {
      await lock.query('begin');
      const { rows } = await lock.query<{ id: string; company_id: string; status: string }>(
        `select id, company_id, status from ${sqlIdent(this.s)}.proposals
          where (status = 'EXECUTING'
                 or (status = 'APPROVED' and (approved_via is distinct from 'grant' or updated_at < now() - interval '${APPROVED_GRANT_GRACE}')))
            and id <> all ($1::uuid[])
          order by updated_at
          for update skip locked
          limit 20`,
        [skip],
      );
      for (const r of rows) {
        const ok = (await lock.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [execLockKey(r.id)])).rows[0]!.ok;
        if (ok) {
          claimed = { lock, ...r };
          break;
        }
        skip.push(r.id); // someone alive is carrying it out right now
      }
      await lock.query('commit');
    } catch (e) {
      await lock.query('rollback').catch(() => {});
      if (claimed) await lock.query('select pg_advisory_unlock(hashtext($1))', [execLockKey(claimed.id)]).catch(() => {});
      lock.release();
      throw e;
    }
    if (!claimed) lock.release();
    return claimed;
  }

  private async carryOut(c: Claimed): Promise<void> {
    // The effect continues the job's trace (the person's ask → … → the yes → the door).
    const parent = await this.core.runnerPool
      .query<{ trace_id: string | null }>(`select j.trace_id from ${sqlIdent(this.s)}.proposals p join ${sqlIdent(this.s)}.jobs j on j.id = p.job_id where p.id = $1`, [c.id])
      .then((r) => r.rows[0]?.trace_id ?? null)
      .catch(() => null);
    const span = this.core.tracer.start('runner.approved', parent, { 'neop.proposal': c.id, 'neop.was': c.status });
    try {
      const proof = await executeHeld(this.core, c.lock, c.company_id, c.id, { actor: this.actor, trace: span.header() });
      span.set('neop.outcome', proof?.outcome ?? 'none').end('ok');
      this.core.log('approved path', { proposal: c.id, was: c.status, outcome: proof?.outcome ?? null });
    } catch (e) {
      span.end('error', String(e));
      // not_approved: withdrawn (or otherwise closed) between the poll and the row lock — nothing to do.
      if (e instanceof ExecError && e.code === 'not_approved') return;
      this.core.log('approved path: execute failed; the poll will try again', { proposal: c.id, e: String(e) });
    }
  }
}
