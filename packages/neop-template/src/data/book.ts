// The record book: the only place the template writes SQL for the standard tables.
// Every function takes a client that is already inside a transaction; callers
// decide which role (app with RLS, or runner) and which company.

import type { OutboxEventType } from '@neop/contracts';
import { assertIdent, type PoolClient } from '@neop/pgkit';

export type JobStatus = 'RECEIVED' | 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export const TERMINAL_JOB: readonly JobStatus[] = ['DONE', 'FAILED', 'EXPIRED', 'CANCELLED'];

export type ProposalStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUPERSEDED'
  | 'EXPIRED'
  | 'WITHDRAWN'
  | 'EXECUTING'
  | 'DONE'
  | 'FAILED'
  | 'UNKNOWN';

export type StepKind = 'received' | 'resume' | 'note' | 'ability' | 'refused' | 'proposal' | 'card' | 'report' | 'failed' | 'system';

export interface JobRow {
  id: string;
  company_id: string;
  source: 'task' | 'room' | 'timer' | 'a2a';
  requester: string;
  task_id: string | null;
  ask: string;
  status: JobStatus;
  parent_job_id: string | null;
  claimed_by: string | null;
  claimed_until: Date | null;
  attempts: number;
  spend_micros: number;
  tool_calls: number;
  result: unknown;
  trace_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow {
  seq: number;
  kind: StepKind;
  summary: string;
  ability_key: string | null;
  output_ref: unknown;
  created_at: Date;
}

export interface ProposalRow {
  id: string;
  company_id: string;
  job_id: string;
  ability_key: string;
  ability_version: string;
  args: unknown;
  card: unknown;
  fingerprint: string;
  status: ProposalStatus;
  approved_via: 'person' | 'grant' | null;
  grant_id: string | null;
  decided_by: string | null;
  feedback: string | null;
  expires_at: Date;
  superseded_by: string | null;
  idempotency_key: string;
  proof: any;
  created_at: Date;
  updated_at: Date;
}

export interface WaitRow {
  id: string;
  company_id: string;
  job_id: string;
  kind: 'proposal' | 'timer' | 'a2a_task';
  ref_id: string | null;
  status: 'pending' | 'ready' | 'consumed';
  outcome: string | null;
  answer: any;
  ready_at: Date | null;
  expires_at: Date;
}

export class Book {
  readonly s: string;
  constructor(schema: string) {
    assertIdent(schema);
    this.s = schema;
  }

  get channel(): string {
    return `neop_${this.s}`;
  }

  // ── jobs ────────────────────────────────────────────────────────────────
  async insertJob(
    c: PoolClient,
    j: { company_id: string; source: JobRow['source']; requester: string; task_id: string | null; ask: string; parent_job_id?: string | null; trace_id?: string | null },
  ): Promise<{ job: JobRow; created: boolean }> {
    const ins = await c.query<JobRow>(
      `insert into ${this.s}.jobs (company_id, source, requester, task_id, ask, parent_job_id, trace_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (company_id, task_id) where task_id is not null do nothing
       returning *`,
      [j.company_id, j.source, j.requester, j.task_id, j.ask, j.parent_job_id ?? null, j.trace_id ?? null],
    );
    if (ins.rows[0]) return { job: ins.rows[0], created: true };
    const existing = await c.query<JobRow>(`select * from ${this.s}.jobs where company_id = $1 and task_id = $2`, [
      j.company_id,
      j.task_id,
    ]);
    return { job: existing.rows[0]!, created: false };
  }

  /**
   * Inbound → job in one statement (the hot path, load-tested): the job, its
   * first step, the step mirror, the acknowledgement and the runner hint.
   * Idempotent on (company, task_id): a replay returns the existing job.
   */
  async openJobAtomic(
    c: PoolClient,
    j: { company_id: string; source: JobRow['source']; requester: string; task_id: string; ask: string; parent_job_id?: string | null; trace_id?: string | null },
  ): Promise<{ job: JobRow; created: boolean }> {
    const summary = `Asked by ${j.requester}: ${j.ask}`.slice(0, 2000);
    const r = await c.query<JobRow & { notified: number }>(
      `with j as (
         insert into ${this.s}.jobs (company_id, source, requester, task_id, ask, parent_job_id, trace_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (company_id, task_id) where task_id is not null do nothing
         returning *),
       st as (
         insert into ${this.s}.steps (company_id, job_id, seq, kind, summary)
         select company_id, id, 1, 'received', $8 from j returning job_id),
       ob as (
         insert into ${this.s}.outbox (company_id, event_type, payload, dedupe_key)
         select company_id, 'step.mirror', jsonb_build_object('job_id', id, 'seq', 1, 'kind', 'received', 'summary', left($8, 500)), 'step:' || id || ':1' from j
         union all
         select company_id, 'job.acknowledged', jsonb_build_object('job_id', id, 'task_id', task_id), 'ack:' || id from j
         on conflict (dedupe_key) do nothing returning 1),
       n as (select pg_notify($9, 'job:' || id) from j)
       select j.*, (select count(*) from n)::int as notified, (select count(*) from st)::int + (select count(*) from ob)::int as written from j`,
      [j.company_id, j.source, j.requester, j.task_id, j.ask, j.parent_job_id ?? null, j.trace_id ?? null, summary, this.channel],
    );
    if (r.rows[0]) return { job: r.rows[0], created: true };
    const existing = await c.query<JobRow>(`select * from ${this.s}.jobs where company_id = $1 and task_id = $2`, [j.company_id, j.task_id]);
    return { job: existing.rows[0]!, created: false };
  }

  async getJob(c: PoolClient, id: string, lock = false): Promise<JobRow | null> {
    const r = await c.query<JobRow>(`select * from ${this.s}.jobs where id = $1${lock ? ' for update' : ''}`, [id]);
    return r.rows[0] ?? null;
  }

  async setJobStatus(c: PoolClient, id: string, status: JobStatus, extra: { result?: unknown; clearClaim?: boolean } = {}): Promise<void> {
    await c.query(
      `update ${this.s}.jobs set status = $2, updated_at = now(),
         result = coalesce($3::jsonb, result)
         ${extra.clearClaim ? ', claimed_by = null, claimed_until = null' : ''}
       where id = $1`,
      [id, status, extra.result === undefined ? null : JSON.stringify(extra.result)],
    );
  }

  // ── steps (+ mirror, deduplicated by (job_id, seq)) ─────────────────────
  async addStep(
    c: PoolClient,
    s: { company_id: string; job_id: string; kind: StepKind; summary: string; ability_key?: string | null; input_hash?: string | null; output_ref?: unknown },
  ): Promise<number> {
    // Serialise seq allocation per job.
    await c.query(`select 1 from ${this.s}.jobs where id = $1 for update`, [s.job_id]);
    const { rows } = await c.query<{ seq: number }>(
      `insert into ${this.s}.steps (company_id, job_id, seq, kind, summary, ability_key, input_hash, output_ref)
       values ($1, $2, (select coalesce(max(seq), 0) + 1 from ${this.s}.steps where job_id = $2), $3, $4, $5, $6, $7)
       returning seq`,
      [s.company_id, s.job_id, s.kind, s.summary.slice(0, 2000), s.ability_key ?? null, s.input_hash ?? null, s.output_ref === undefined ? null : JSON.stringify(s.output_ref)],
    );
    const seq = rows[0]!.seq;
    await this.emit(c, s.company_id, 'step.mirror', { job_id: s.job_id, seq, kind: s.kind, summary: s.summary.slice(0, 500) }, `step:${s.job_id}:${seq}`);
    return seq;
  }

  async listSteps(c: PoolClient, jobId: string): Promise<StepRow[]> {
    const r = await c.query<StepRow>(
      `select seq, kind, summary, ability_key, output_ref, created_at from ${this.s}.steps where job_id = $1 order by seq`,
      [jobId],
    );
    return r.rows;
  }

  // ── outbox ──────────────────────────────────────────────────────────────
  async emit(c: PoolClient, companyId: string, type: OutboxEventType, payload: unknown, dedupeKey?: string): Promise<void> {
    await c.query(
      `insert into ${this.s}.outbox (company_id, event_type, payload, dedupe_key) values ($1, $2, $3, $4)
       on conflict (dedupe_key) do nothing`,
      [companyId, type, JSON.stringify(payload), dedupeKey ?? null],
    );
  }

  async notify(c: PoolClient, what: string): Promise<void> {
    await c.query('select pg_notify($1, $2)', [this.channel, what]);
  }

  // ── proposals ───────────────────────────────────────────────────────────
  async insertProposal(
    c: PoolClient,
    p: {
      id: string;
      company_id: string;
      job_id: string;
      ability_key: string;
      ability_version: string;
      args: unknown;
      card: unknown;
      fingerprint: string;
      status: 'PROPOSED' | 'APPROVED';
      approved_via?: 'grant' | null;
      grant_id?: string | null;
      decided_by?: string | null;
      ttl_ms: number;
    },
  ): Promise<ProposalRow> {
    const r = await c.query<ProposalRow>(
      `insert into ${this.s}.proposals
         (id, company_id, job_id, ability_key, ability_version, args, card, fingerprint, status,
          approved_via, grant_id, decided_by, expires_at, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + ($13 || ' milliseconds')::interval, $14)
       returning *`,
      [
        p.id,
        p.company_id,
        p.job_id,
        p.ability_key,
        p.ability_version,
        JSON.stringify(p.args),
        JSON.stringify(p.card),
        p.fingerprint,
        p.status,
        p.approved_via ?? null,
        p.grant_id ?? null,
        p.decided_by ?? null,
        String(p.ttl_ms),
        `${this.s}:proposal:${p.id}`,
      ],
    );
    return r.rows[0]!;
  }

  async getProposal(c: PoolClient, id: string, lock = false): Promise<ProposalRow | null> {
    const r = await c.query<ProposalRow>(`select * from ${this.s}.proposals where id = $1${lock ? ' for update' : ''}`, [id]);
    return r.rows[0] ?? null;
  }

  async updateProposal(
    c: PoolClient,
    id: string,
    patch: Partial<Pick<ProposalRow, 'status' | 'decided_by' | 'feedback' | 'proof' | 'approved_via' | 'superseded_by'>>,
  ): Promise<void> {
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      vals.push(k === 'proof' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    await c.query(`update ${this.s}.proposals set ${sets.join(', ')} where id = $1`, vals);
  }

  async proposalEvent(
    c: PoolClient,
    e: { company_id: string; proposal_id: string; event: string; actor: string; fingerprint_seen?: string | null; detail?: unknown },
  ): Promise<void> {
    await c.query(
      `insert into ${this.s}.proposal_events (company_id, proposal_id, event, actor, fingerprint_seen, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [e.company_id, e.proposal_id, e.event, e.actor, e.fingerprint_seen ?? null, e.detail === undefined ? null : JSON.stringify(e.detail)],
    );
  }

  // ── waits ───────────────────────────────────────────────────────────────
  async insertWait(
    c: PoolClient,
    w: { company_id: string; job_id: string; kind: WaitRow['kind']; ref_id: string | null; expires_at_sql: string },
  ): Promise<WaitRow> {
    const r = await c.query<WaitRow>(
      `insert into ${this.s}.waits (company_id, job_id, kind, ref_id, expires_at)
       values ($1, $2, $3, $4, ${w.expires_at_sql}) returning *`,
      [w.company_id, w.job_id, w.kind, w.ref_id],
    );
    return r.rows[0]!;
  }

  /** Mark a pending wait ready. The only way a job wakes (B2: callers pass terminal outcomes only). */
  async readyWait(c: PoolClient, refId: string, outcome: string, answer: unknown): Promise<boolean> {
    const r = await c.query(
      `update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = $2, answer = $3
       where ref_id = $1 and status = 'pending'`,
      [refId, outcome, JSON.stringify(answer)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async openWaits(c: PoolClient, jobId: string): Promise<WaitRow[]> {
    const r = await c.query<WaitRow>(`select * from ${this.s}.waits where job_id = $1 and status in ('pending', 'ready') order by created_at`, [
      jobId,
    ]);
    return r.rows;
  }

  /** Consume the waits this session was woken for; returns them so the proposal trail can say REPORTED. */
  async consumeReadyWaits(c: PoolClient, jobId: string): Promise<WaitRow[]> {
    const r = await c.query<WaitRow>(`update ${this.s}.waits set status = 'consumed' where job_id = $1 and status = 'ready' returning *`, [jobId]);
    return r.rows;
  }

  /** (7.8) The assistant has checked the answer and reported on it: the last entry of an approval's trail. */
  async markReported(c: PoolClient, companyId: string, consumed: WaitRow[], actor: string, detail: unknown): Promise<void> {
    for (const w of consumed) {
      if (w.kind === 'proposal' && w.ref_id) {
        await this.proposalEvent(c, { company_id: companyId, proposal_id: w.ref_id, event: 'reported', actor, detail });
      }
    }
  }

  // ── operations ──────────────────────────────────────────────────────────
  async recordOperation(
    c: PoolClient,
    o: { company_id: string; job_id: string | null; caller: string; ability_key: string; idempotency_key: string; outcome: string; gateway_request_id?: string | null; detail?: unknown; trace_id?: string | null },
  ): Promise<boolean> {
    const r = await c.query(
      `insert into ${this.s}.operations (company_id, job_id, caller, ability_key, idempotency_key, outcome, gateway_request_id, detail, trace_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (company_id, caller, ability_key, idempotency_key) do nothing`,
      [o.company_id, o.job_id, o.caller, o.ability_key, o.idempotency_key, o.outcome, o.gateway_request_id ?? null, JSON.stringify(o.detail ?? null), o.trace_id ?? null],
    );
    const inserted = (r.rowCount ?? 0) > 0;
    if (inserted) {
      await this.emit(c, o.company_id, 'operation.recorded', {
        job_id: o.job_id,
        caller: o.caller,
        ability_key: o.ability_key,
        idempotency_key: o.idempotency_key,
        outcome: o.outcome,
        gateway_request_id: o.gateway_request_id ?? null,
      });
    }
    return inserted;
  }

  // ── facts ───────────────────────────────────────────────────────────────
  async addFact(c: PoolClient, f: { company_id: string; job_id: string | null; subject: string; value: unknown; source: string }): Promise<void> {
    await c.query(`insert into ${this.s}.facts (company_id, subject, value, source, job_id) values ($1, $2, $3, $4, $5)`, [
      f.company_id,
      f.subject,
      JSON.stringify(f.value),
      f.source,
      f.job_id,
    ]);
  }

  async recentFacts(c: PoolClient, limit = 20): Promise<{ subject: string; value: unknown; source: string; observed_at: Date }[]> {
    const r = await c.query(`select subject, value, source, observed_at from ${this.s}.facts order by observed_at desc limit $1`, [limit]);
    return r.rows;
  }
}
