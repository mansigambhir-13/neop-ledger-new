// The record book: the only place the template writes SQL for the standard tables.
// Every function takes a client that is already inside a transaction; callers
// decide which role (app with RLS, or runner) and which company.

import type { OutboxEventType, Question } from '@neop/contracts';
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

export type StepKind = 'received' | 'resume' | 'note' | 'ability' | 'refused' | 'proposal' | 'card' | 'report' | 'failed' | 'system' | 'summary';

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
  /** Timer jobs only: not started by then → EXPIRED, never run stale (t004). */
  run_by: Date | null;
  /** The person the work is for when an app opened the job (a2a, t005). */
  on_behalf_of: string | null;
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
  kind: WaitKind;
  ref_id: string | null;
  status: 'pending' | 'ready' | 'consumed';
  outcome: string | null;
  answer: any;
  ready_at: Date | null;
  expires_at: Date;
  /** Input waits (t005): the question asked, and who answered it. */
  question: Question | null;
  answered_by: string | null;
  created_at: Date;
}

export type WaitKind = 'proposal' | 'timer' | 'a2a_task' | 'input';

export interface FactRow {
  subject: string;
  value: unknown;
  source: string;
  observed_at: Date;
  valid_until: Date | null;
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
    j: { company_id: string; source: JobRow['source']; requester: string; task_id: string | null; ask: string; parent_job_id?: string | null; trace_id?: string | null; on_behalf_of?: string | null },
  ): Promise<{ job: JobRow; created: boolean }> {
    const ins = await c.query<JobRow>(
      `insert into ${this.s}.jobs (company_id, source, requester, task_id, ask, parent_job_id, trace_id, on_behalf_of)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (company_id, task_id) where task_id is not null do nothing
       returning *`,
      [j.company_id, j.source, j.requester, j.task_id, j.ask, j.parent_job_id ?? null, j.trace_id ?? null, j.on_behalf_of ?? null],
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
    j: { company_id: string; source: JobRow['source']; requester: string; task_id: string; ask: string; parent_job_id?: string | null; trace_id?: string | null; on_behalf_of?: string | null },
  ): Promise<{ job: JobRow; created: boolean }> {
    const summary = `Asked by ${j.requester}: ${j.ask}`.slice(0, 2000);
    const r = await c.query<JobRow & { notified: number }>(
      `with j as (
         insert into ${this.s}.jobs (company_id, source, requester, task_id, ask, parent_job_id, trace_id, on_behalf_of)
         values ($1, $2, $3, $4, $5, $6, $7, $10)
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
      [j.company_id, j.source, j.requester, j.task_id, j.ask, j.parent_job_id ?? null, j.trace_id ?? null, summary, this.channel, j.on_behalf_of ?? null],
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
    s: { company_id: string; job_id: string; kind: StepKind; summary: string; ability_key?: string | null; input_hash?: string | null; output_ref?: unknown; mirror?: boolean },
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
    // The rolling summary is the assistant's memory, not a step a person follows.
    if (s.mirror === false) return seq;
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
    w: { company_id: string; job_id: string; kind: WaitRow['kind']; ref_id: string | null; expires_at_sql?: string; expires_at?: string; answer?: unknown; question?: Question },
  ): Promise<WaitRow> {
    // A timer wait carries what it waits for in `answer` while pending (t004: job.wait_until);
    // an input wait carries its question (t005: job.ask).
    const r = await c.query<WaitRow>(
      `insert into ${this.s}.waits (company_id, job_id, kind, ref_id, expires_at, answer, question)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, ${w.expires_at_sql ?? 'now()'}), $6, $7) returning *`,
      [w.company_id, w.job_id, w.kind, w.ref_id, w.expires_at ?? null, w.answer === undefined ? null : JSON.stringify(w.answer), w.question ? JSON.stringify(w.question) : null],
    );
    return r.rows[0]!;
  }

  async getWait(c: PoolClient, id: string, lock = false): Promise<WaitRow | null> {
    const r = await c.query<WaitRow>(`select * from ${this.s}.waits where id = $1${lock ? ' for update' : ''}`, [id]);
    return r.rows[0] ?? null;
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
  /** `valid_until` (t005): after it the fact is no longer offered to any job; it stays in the book. */
  async addFact(c: PoolClient, f: { company_id: string; job_id: string | null; subject: string; value: unknown; source: string; valid_until?: string | Date | null }): Promise<void> {
    await c.query(`insert into ${this.s}.facts (company_id, subject, value, source, job_id, valid_until) values ($1, $2, $3, $4, $5, $6)`, [
      f.company_id,
      f.subject,
      JSON.stringify(f.value),
      f.source,
      f.job_id,
      f.valid_until ?? null,
    ]);
  }

  /**
   * Facts for one job's bundle: those this job (or its parent) wrote and those whose
   * subject the ask names come first, then the company's most recent (item 7). A fact
   * past its valid_until is left out (database time).
   */
  async factsFor(c: PoolClient, job: { id: string; ask: string; parent_job_id: string | null }, limit = 20): Promise<FactRow[]> {
    const r = await c.query<FactRow>(
      // Answers to a job's questions and files attached to a job belong to THAT job (and its follow-ups): an
      // answer given for one request is never the answer to another (found live: a later job reused an earlier
      // job's `answer:amount_rupees` instead of asking).
      `select subject, value, source, observed_at, valid_until from ${this.s}.facts
        where (valid_until is null or valid_until > now())
          and (not (subject like 'answer:%' or subject like 'document:%') or job_id = $1 or job_id = $2::uuid)
        order by coalesce(job_id = $1 or job_id = $2::uuid or (length(subject) > 2 and strpos(lower($3), lower(subject)) > 0), false) desc, observed_at desc
        limit $4`,
      [job.id, job.parent_job_id, job.ask, limit],
    );
    return r.rows;
  }

  async recentFacts(c: PoolClient, limit = 20): Promise<FactRow[]> {
    const r = await c.query<FactRow>(`select subject, value, source, observed_at, valid_until from ${this.s}.facts where (valid_until is null or valid_until > now()) and not (subject like 'answer:%' or subject like 'document:%') order by observed_at desc limit $1`, [limit]);
    return r.rows;
  }

  // ── transcripts (t005, WP §12: kept for audit, never shown to a model again) ──
  async saveTranscript(
    c: PoolClient,
    t: { company_id: string; job_id: string; session_id: string; reason: string; system_prompt: string; messages: unknown[]; bytes: number; truncated: boolean },
  ): Promise<boolean> {
    const r = await c.query(
      `insert into ${this.s}.transcripts (company_id, job_id, session_id, reason, system_prompt, messages, message_count, bytes, truncated)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (job_id, session_id) do nothing`,
      [t.company_id, t.job_id, t.session_id, t.reason.slice(0, 500), t.system_prompt, JSON.stringify(t.messages), t.messages.length, t.bytes, t.truncated],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async transcripts(c: PoolClient, jobId: string): Promise<{ session_id: string; reason: string; system_prompt: string; messages: unknown[]; message_count: number; bytes: number; truncated: boolean; created_at: Date }[]> {
    const r = await c.query(
      `select session_id, reason, system_prompt, messages, message_count, bytes, truncated, created_at from ${this.s}.transcripts where job_id = $1 order by id`,
      [jobId],
    );
    return r.rows;
  }
}
