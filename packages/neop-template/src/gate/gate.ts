// THE GATE · template-only · identical in every app.
// Every call the assistant makes lands here, in the backend, behind the job
// token. The assistant is told what is on; the gate is what enforces it.
//
// Decision order for one call (plan §Switchboard, gate and policy):
//   1. job token valid, session still holds the claim, ability in its scope
//   2. ability exists in the manifest at the pinned version
//   3. effective setting off → refuse
//   4. company rules violated → refuse with the rule id
//   5. tool-call cap exceeded → refuse (job.finish still passes, so the person gets a
//      report). Model spend is capped where it is metered: the LLM proxy (S9).
//   6. read, or write set to on → execute, write operations and steps
//   7. ask-first with a grant covering it (<schema>.grants) → proposal APPROVED by the grant,
//      carried out inline by the same approved path (no platform, no token)
//   8. ask-first otherwise → proposal + wait, return the proposal id

import { randomUUID } from 'node:crypto';
import { canonicalize, fingerprint, normalizeQuestion, QUESTION_LIMITS, sha256, type JobTokenClaims, type ProposalCard, type Proof, type TaskResult } from '@neop/contracts';
import { executeProposal, measure, runEffect } from '../capabilities/execute.ts';
import { ruleUsage } from '../capabilities/usage.ts';
import type { Core } from '../core.ts';
import type { PoolClient } from '@neop/pgkit';
import type { JobRow } from '../data/book.ts';
import { checkRules } from '../domain/rules.ts';
import type { ExecCtx, Measure } from '../types.ts';
import { BUILTIN_TOOLS, offDoors } from './tools.ts';
import { matchGrant, recordGrantUse } from './grants.ts';
import { a2aAnswer, a2aRequest, borrow } from './a2a.ts';

export type GateResult =
  | { status: 'done'; ability: string; output: unknown; untrusted: boolean }
  | { status: 'done_by_grant'; ability: string; proposal_id: string; proof: Proof }
  | { status: 'proposed'; ability: string; proposal_id: string; fingerprint: string; expires_at: string }
  | { status: 'waiting_on_app'; app: string; task_id: string }
  | { status: 'waiting_until'; at: string }
  | { status: 'asked'; wait_id: string; due_at: string }
  /** `detail` is what another party said (owner app, platform): shown to the model as untrusted data (item 10). */
  | { status: 'refused'; code: string; reason: string; detail?: unknown; detail_source?: string }
  | { status: 'ok'; detail?: unknown };

export const MAX_TOOL_CALLS = 40;
/** job.finish attempts allowed past the cap, so a capped job can still report. */
const FINISH_GRACE = 5;
/** job.wait_until: how far ahead a job may park itself. */
const MAX_WAIT_MS = 31 * 86_400_000;
/** job.ask: how long a question waits for its answer by default. */
const ASK_DEFAULT_HOURS = QUESTION_LIMITS.dueDefaultHours;

export class SessionLost extends Error {}

export class Gate {
  readonly core: Core;
  constructor(core: Core) {
    this.core = core;
  }

  /** The session must still hold the job's claim; otherwise another session owns it (or nobody). */
  private async liveJob(claims: JobTokenClaims, bump: boolean): Promise<JobRow> {
    return this.core.company(claims.company_id, async (c) => {
      const r = await c.query<JobRow>(
        `update ${this.core.key}.jobs set tool_calls = tool_calls + $3, updated_at = now()
          where id = $1 and claimed_by = $2 and status = 'RUNNING'
          returning *`,
        [claims.sub, claims.sid, bump ? 1 : 0],
      );
      if (!r.rows[0]) throw new SessionLost('this session no longer holds the job');
      return r.rows[0];
    });
  }

  async call(claims: JobTokenClaims, key: string, rawArgs: unknown): Promise<GateResult> {
    const job = await this.liveJob(claims, true);
    if (job.tool_calls > MAX_TOOL_CALLS && !(key === 'job.finish' && job.tool_calls <= MAX_TOOL_CALLS + FINISH_GRACE)) {
      return { status: 'refused', code: 'cap_tool_calls', reason: `this job has used its ${MAX_TOOL_CALLS} tool calls; call job.finish to report` };
    }

    if (key in BUILTIN_TOOLS) return this.builtin(claims, job, key, rawArgs);
    // Another app (v3 §9–§10): the platform's a2a routing with NEOP_PRESENCE off, the bus room with it on (gate/a2a.ts).
    if (key === 'a2a.request') return a2aRequest(this, claims, job, rawArgs);
    if (key === 'a2a.answer') return a2aAnswer(this, claims, job, rawArgs);

    // 1. scope
    if (!claims.abilities.includes(key)) {
      return this.refuse(claims, key, 'not_in_scope', `${key} is not switched on for this job`);
    }
    // 2. manifest (own, or an installed package); anything else in scope is borrowed
    const resolved = await this.core.resolve(claims.company_id, key);
    if (!resolved) return borrow(this, claims, job, key, rawArgs);
    const ability = resolved.meta;
    const handler = resolved.handler;

    // 3. setting
    const board = await this.core.board.get(claims.company_id);
    const setting = board.setting(ability);
    if (setting === 'off') return this.refuse(claims, key, 'switched_off', `${key} is switched off`);
    const closed = offDoors(this.core.manifest, board, ability);
    if (closed.length) return this.refuse(claims, key, 'door_off', `${key} needs the ${closed.join(', ')} door, which this company switched off`);

    // Split the card from the args of an ask-first write; the card is presentation, not content.
    let args: unknown = rawArgs ?? {};
    let card: ProposalCard | null = null;
    if (ability.kind === 'write' && setting === 'ask_first' && args && typeof args === 'object' && !Array.isArray(args)) {
      const { card: c, ...rest } = args as Record<string, unknown>;
      card = (c as ProposalCard) ?? null;
      args = rest;
    }
    const tz = board.company.time_zone;
    if (handler.kind === 'write' && handler.normalize) {
      const nargs = args;
      args = await this.core.company(claims.company_id, (db) =>
        handler.normalize!(nargs, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), time_zone: tz, db }),
      );
    }
    const invalid = resolved.checkInput(args) ?? (handler.kind === 'write' ? (handler.check?.(args) ?? null) : null);
    if (invalid) return this.refuse(claims, key, 'invalid_args', invalid);
    if (handler.kind === 'write' && handler.validate) {
      const v = await this.core.company(claims.company_id, (db) =>
        handler.validate!(args, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), time_zone: tz, db }),
      );
      if (typeof v === 'string' && v) return this.refuse(claims, key, 'not_possible', v);
      if (v && typeof v === 'object') {
        // A name that matched nothing: the closest real names are data from the books (they may have come from
        // outside text), and the instruction is ours — ask the person which one; never act on a guess.
        if (!v.did_you_mean?.length) return this.refuse(claims, key, 'not_possible', v.reason);
        return this.refuse(
          claims,
          key,
          'unknown_name',
          `${v.reason}. Nothing was done. Ask the person which one they meant (job_ask) — offer the closest names below as "Did you mean …?"; never act or propose on a guessed match`,
          { detail: { did_you_mean: v.did_you_mean }, detail_source: 'books' },
        );
      }
    }

    // 4. rules
    let m = {};
    if (handler.kind === 'write') {
      m = await this.core.company(claims.company_id, (db) => measure(ability, handler, args, db));
      if (ability.effects?.money && typeof (m as { amount_minor?: number }).amount_minor !== 'number') {
        return this.refuse(claims, key, 'unmeasured', `${key} moves money but its amount could not be measured; nothing was proposed`);
      }
      const usage = await this.core.company(claims.company_id, (c) => ruleUsage(this.core, c, board, (m as any).currency));
      const v = checkRules(board.rules, { ability_key: key, external: !!ability.effects?.external, ...m }, new Date(), board.company.time_zone, usage);
      if (v) return this.refuse(claims, key, `rule:${v.rule_id}`, v.reason);
    }

    // 6. reads, and writes that are on
    if (handler.kind === 'read') {
      const output = await this.core.company(claims.company_id, (db) =>
        handler.run(args, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), time_zone: tz, db }),
      );
      const bad = resolved.checkOutput(output);
      if (bad) return this.refuse(claims, key, 'contract_violation', `result failed its schema: ${bad}`);
      await this.core.company(claims.company_id, (c) =>
        this.core.book.addStep(c, {
          company_id: claims.company_id,
          job_id: claims.sub,
          kind: 'ability',
          summary: `Read ${ability.title}`,
          ability_key: key,
          input_hash: sha256(canonicalize(args)),
          // What the read was based on, so the report can always say where its facts came from.
          output_ref: { basis: (output as any)?.sources?.basis ?? null, entries: (output as any)?.sources?.entries ?? null, generatedAt: (output as any)?.generatedAt ?? null },
        }),
      );
      return { status: 'done', ability: key, output, untrusted: true };
    }

    if (setting === 'on') {
      const idem = `${this.core.key}:direct:${claims.sub}:${sha256(canonicalize({ key, args }))}`;
      const ctx: ExecCtx = {
        company_id: claims.company_id,
        caller: `assistant:${claims.sub}`,
        job_id: claims.sub,
        now: new Date(),
        idempotencyKey: idem,
        company_name: board.company.name,
        doors: this.core.doors(claims.company_id),
        withDb: (fn) => this.core.company(claims.company_id, fn),
      };
      const res = await runEffect(handler, args, ctx, false);
      await this.core.company(claims.company_id, async (c) => {
        await this.core.book.recordOperation(c, {
          company_id: claims.company_id,
          job_id: claims.sub,
          caller: `assistant:${claims.sub}`,
          ability_key: key,
          idempotency_key: idem,
          outcome: res.outcome,
          detail: { ...m, external_ref: res.external_ref },
          request: args,
          result: res,
          reason: `${key} is switched on for this company: done without asking`,
        });
        await this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'ability', summary: `${ability.title}: ${res.outcome}`, ability_key: key });
      });
      return { status: 'done', ability: key, output: res, untrusted: true };
    }

    // 7–8. ask first
    if (!card || !card.what || !card.why || !card.changes || !card.if_no_answer) {
      return this.refuse(claims, key, 'card_required', 'an ask-first call needs a card: what, why, changes, if_no_answer');
    }
    // The same change already waiting for a yes, or already approved: never a second approval for it.
    const twin = await this.core.company(claims.company_id, (c) => openTwin(c, this.core.key, key, args));
    if (twin) {
      const state = twin.status === 'PROPOSED' ? "is already waiting for a person's yes" : 'is already approved' + (twin.status === 'EXECUTING' ? ' and being carried out' : '');
      return this.refuse(
        claims,
        key,
        'already_proposed',
        `this exact change ${state} (proposal ${twin.id}). Nothing new was proposed. Tell the person it ${state}; do not prepare, offer or describe another approval of it`,
      );
    }
    const proposalId = randomUUID();
    const fp = fingerprint({ key, version: ability.version, args, company_id: claims.company_id, job_id: claims.sub });

    // 7. A standing yes, matched here in the app's own schema (<schema>.grants, t010): the proposal is
    // written APPROVED by the grant and its use recorded in one transaction; no platform, no token.
    const grant = await this.core.company(claims.company_id, async (c) => {
      const g = await matchGrant(c, this.core.key, key, m as Measure, tz);
      if (!g) return null;
      await this.core.book.insertProposal(c, {
        id: proposalId,
        company_id: claims.company_id,
        job_id: claims.sub,
        ability_key: key,
        ability_version: ability.version,
        args,
        card,
        fingerprint: fp,
        status: 'APPROVED',
        approved_via: 'grant',
        grant_id: g.grant_id,
        decided_by: `grant:${g.grant_id}`,
        manifest_version: this.core.manifest.version,
        ttl_ms: this.core.cfg.timings.proposalTtlMs,
      });
      const mm = m as Measure;
      await recordGrantUse(c, this.core.key, { company_id: claims.company_id, grant_id: g.grant_id, proposal_id: proposalId, job_id: claims.sub, ability_key: key, fingerprint: fp, amount_minor: mm.amount_minor, currency: mm.currency });
      await this.core.book.proposalEvent(c, { company_id: claims.company_id, proposal_id: proposalId, event: 'approved_by_grant', actor: `grant:${g.grant_id}`, fingerprint_seen: fp });
      await this.linkSuperseded(c, claims, key, proposalId);
      await this.core.book.addStep(c, {
        company_id: claims.company_id,
        job_id: claims.sub,
        kind: 'proposal',
        summary: `${ability.title}: covered by a standing yes (grant ${g.grant_id.slice(0, 8)})`,
        ability_key: key,
        output_ref: { proposal_id: proposalId },
      });
      return g;
    });

    if (grant) {
      await this.core.hooks.afterGrantMatched?.(proposalId);
      // A standing yes is carried out inline, through the same approved path the runner takes for a person's yes
      // (the runner adopts a grant-approved proposal left APPROVED past APPROVED_GRANT_GRACE — a gate that died here).
      const proof = await executeProposal(this.core, claims.company_id, proposalId, { actor: `grant:${grant.grant_id}` });
      return { status: 'done_by_grant', ability: key, proposal_id: proposalId, proof };
    }

    const out = await this.core.company(claims.company_id, async (c) => {
      const p = await this.core.book.insertProposal(c, {
        id: proposalId,
        company_id: claims.company_id,
        job_id: claims.sub,
        ability_key: key,
        ability_version: ability.version,
        args,
        card,
        fingerprint: fp,
        status: 'PROPOSED',
        manifest_version: this.core.manifest.version,
        ttl_ms: this.core.cfg.timings.proposalTtlMs,
      });
      await this.core.book.proposalEvent(c, { company_id: claims.company_id, proposal_id: p.id, event: 'proposed', actor: `assistant:${claims.sub}`, fingerprint_seen: fp });
      await this.linkSuperseded(c, claims, key, p.id);
      await this.core.book.insertWait(c, {
        company_id: claims.company_id,
        job_id: claims.sub,
        kind: 'proposal',
        ref_id: p.id,
        expires_at_sql: `(select expires_at from ${this.core.key}.proposals where id = '${p.id}')`,
      });
      const consumed = await this.core.book.consumeReadyWaits(c, claims.sub);
      await this.core.book.markReported(c, claims.company_id, consumed, `assistant:${claims.sub}`, { next_proposal: p.id });
      await this.core.book.setJobStatus(c, claims.sub, 'WAITING');
      await this.core.book.addStep(c, {
        company_id: claims.company_id,
        job_id: claims.sub,
        kind: 'proposal',
        summary: `Asked first: ${card!.what} (proposal ${p.id.slice(0, 8)}, fingerprint ${fp.slice(7, 15)})`,
        ability_key: key,
        output_ref: { proposal_id: p.id, fingerprint: fp },
      });
      await this.core.book.emit(
        c,
        claims.company_id,
        'proposal.created',
        {
          proposal_id: p.id,
          job_id: claims.sub,
          task_id: job.task_id,
          ability_key: key,
          ability_version: ability.version,
          args,
          card,
          fingerprint: fp,
          expires_at: p.expires_at.toISOString(),
        },
        `proposal:${p.id}`,
      );
      return p;
    });
    return { status: 'proposed', ability: key, proposal_id: out.id, fingerprint: fp, expires_at: out.expires_at.toISOString() };
  }

  /**
   * "Change this first" ends a proposal SUPERSEDED; the one the assistant writes next in
   * the same job for the same ability replaces it: record which (superseded_by).
   */
  private async linkSuperseded(c: PoolClient, claims: JobTokenClaims, key: string, replacement: string): Promise<void> {
    const r = await c.query<{ id: string }>(
      `update ${this.core.key}.proposals set superseded_by = $3, updated_at = now()
        where id = (select id from ${this.core.key}.proposals
                     where job_id = $1 and ability_key = $2 and status = 'SUPERSEDED' and superseded_by is null and id <> $3
                     order by updated_at desc limit 1)
        returning id`,
      [claims.sub, key, replacement],
    );
    for (const row of r.rows) {
      await this.core.book.proposalEvent(c, { company_id: claims.company_id, proposal_id: row.id, event: 'superseded_by', actor: `assistant:${claims.sub}`, detail: { replacement } });
    }
  }

  /** Refuse a call: a `refused` step in the book; another party's words (detail) travel as data. */
  async refuse(claims: JobTokenClaims, key: string, code: string, reason: string, outside?: { detail: unknown; detail_source: string }): Promise<GateResult> {
    await this.core
      .company(claims.company_id, (c) =>
        this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'refused', summary: `Refused ${key}: ${reason}`, ability_key: key }),
      )
      .catch(() => {});
    return outside ? { status: 'refused', code, reason, ...outside } : { status: 'refused', code, reason };
  }

  // ── built-in tools: book.note, card.raise, job.ask, job.wait_until, job.finish ─────
  private async builtin(claims: JobTokenClaims, job: JobRow, key: string, args: any): Promise<GateResult> {
    const co = claims.company_id;
    switch (key) {
      case 'book.note': {
        if (typeof args?.text !== 'string' || !args.text.trim()) return { status: 'refused', code: 'invalid_args', reason: 'text is required' };
        const facts = Array.isArray(args.facts) ? args.facts : [];
        for (const f of facts) {
          if (typeof f?.subject !== 'string' || typeof f?.source !== 'string' || !f.source.trim()) {
            return { status: 'refused', code: 'invalid_args', reason: 'every fact needs a subject and a source' };
          }
          if (f.valid_until !== undefined && f.valid_until !== null && (typeof f.valid_until !== 'string' || Number.isNaN(Date.parse(f.valid_until)))) {
            return { status: 'refused', code: 'invalid_args', reason: 'valid_until must be an ISO 8601 date-time' };
          }
        }
        await this.core.company(co, async (c) => {
          await this.core.book.addStep(c, { company_id: co, job_id: claims.sub, kind: 'note', summary: args.text });
          for (const f of facts) await this.core.book.addFact(c, { company_id: co, job_id: claims.sub, subject: f.subject, value: f.value ?? null, source: f.source, valid_until: f.valid_until ?? null });
        });
        return { status: 'ok' };
      }
      case 'card.raise': {
        if (typeof args?.text !== 'string' || !args.text.trim()) return { status: 'refused', code: 'invalid_args', reason: 'text is required' };
        const kind = args.kind === 'question' ? 'question' : 'heads_up';
        await this.core.company(co, async (c) => {
          const seq = await this.core.book.addStep(c, { company_id: co, job_id: claims.sub, kind: 'card', summary: args.text });
          await this.core.book.emit(c, co, 'card.raised', { job_id: claims.sub, task_id: job.task_id, kind, text: args.text }, `card:${claims.sub}:${seq}`);
        });
        return { status: 'ok' };
      }
      case 'job.wait_until': {
        // WP §7: the job parks itself until a time; the runner wakes it then (waits.kind 'timer').
        const at = typeof args?.at === 'string' ? new Date(args.at) : null;
        if (!at || Number.isNaN(at.getTime()) || typeof args?.reason !== 'string' || !args.reason.trim()) {
          return { status: 'refused', code: 'invalid_args', reason: 'at (ISO date-time) and reason are required' };
        }
        return this.core.company(co, async (c) => {
          const ok = (await c.query<{ ok: boolean }>('select $1::timestamptz > now() and $1::timestamptz <= now() + ($2 || \' milliseconds\')::interval as ok', [at.toISOString(), String(MAX_WAIT_MS)])).rows[0]!.ok;
          if (!ok) return { status: 'refused', code: 'invalid_args', reason: 'at must be in the future and within 31 days' } as GateResult;
          await this.core.book.insertWait(c, { company_id: co, job_id: claims.sub, kind: 'timer', ref_id: null, expires_at: at.toISOString(), answer: { at: at.toISOString(), reason: args.reason } });
          const consumed = await this.core.book.consumeReadyWaits(c, claims.sub);
          await this.core.book.markReported(c, co, consumed, `assistant:${claims.sub}`, { waiting_until: at.toISOString() });
          await this.core.book.setJobStatus(c, claims.sub, 'WAITING');
          await this.core.book.addStep(c, { company_id: co, job_id: claims.sub, kind: 'system', summary: `Waiting until ${at.toISOString()}: ${args.reason}` });
          return { status: 'waiting_until', at: at.toISOString() } as GateResult;
        });
      }
      case 'job.ask': {
        // WP §8 `ask`: one structured question; the job waits on it (waits.kind 'input', t005).
        // A question for a write (`for_ability`) always lists every required input of that write still missing.
        if (args && typeof args === 'object' && args.for_ability !== undefined && args.for_ability !== null) {
          const forKey = String(args.for_ability).replaceAll('__', '.');
          const target = claims.abilities.includes(forKey) ? await this.core.resolve(co, forKey) : null;
          if (!target || target.meta.kind !== 'write') return { status: 'refused', code: 'invalid_args', reason: 'for_ability must name one of your write tools' };
          args = { ...args, fields: withRequiredFields(args.fields, target.meta.input, args.known) };
        }
        const n = normalizeQuestion(args);
        if ('error' in n) return { status: 'refused', code: 'invalid_args', reason: n.error };
        const hours = args?.due_in_hours === undefined || args?.due_in_hours === null ? ASK_DEFAULT_HOURS : Number(args.due_in_hours);
        if (!Number.isFinite(hours) || hours <= 0 || hours > QUESTION_LIMITS.dueMaxHours) {
          return { status: 'refused', code: 'invalid_args', reason: `due_in_hours must be more than 0 and at most ${QUESTION_LIMITS.dueMaxHours} (14 days)` };
        }
        return this.core.company(co, async (c) => {
          const open = (await this.core.book.openWaits(c, claims.sub)).filter((w) => w.status === 'pending');
          if (open.length) return { status: 'refused', code: 'job_waiting', reason: 'the job is already waiting on an answer; do not ask twice' } as GateResult;
          const w = await this.core.book.insertWait(c, {
            company_id: co,
            job_id: claims.sub,
            kind: 'input',
            ref_id: null,
            expires_at_sql: `now() + interval '${Math.round(hours * 3_600_000)} milliseconds'`,
            question: n.question,
          });
          const consumed = await this.core.book.consumeReadyWaits(c, claims.sub);
          await this.core.book.markReported(c, co, consumed, `assistant:${claims.sub}`, { asked: w.id });
          await this.core.book.setJobStatus(c, claims.sub, 'WAITING');
          await this.core.book.addStep(c, {
            company_id: co,
            job_id: claims.sub,
            kind: 'system',
            summary: `Asked (question ${w.id.slice(0, 8)}, due ${w.expires_at.toISOString()}): ${n.question.text}`,
            output_ref: { wait_id: w.id },
          });
          const due_at = w.expires_at.toISOString();
          await this.core.book.emit(c, co, 'question.asked', { job_id: claims.sub, task_id: job.task_id, wait_id: w.id, text: n.question.text, why: n.question.why, fields: n.question.fields, due_at }, `question:${w.id}`);
          return { status: 'asked', wait_id: w.id, due_at } as GateResult;
        });
      }
      case 'job.finish': {
        const outcomes = ['done', 'failed', 'blocked', 'needs_input'];
        if (!outcomes.includes(args?.outcome) || typeof args?.summary !== 'string' || !args.summary.trim()) {
          return { status: 'refused', code: 'invalid_args', reason: `outcome (${outcomes.join('|')}) and summary are required` };
        }
        const result: TaskResult = {
          outcome: args.outcome,
          summary: args.summary,
          changed: Array.isArray(args.changed) ? args.changed.map(String) : [],
          could_not: Array.isArray(args.could_not) ? args.could_not.map(String) : [],
          sources: Array.isArray(args.sources) ? args.sources.map(String) : [],
        };
        return this.core.company(co, async (c) => {
          // Every report says where its facts came from (WP §16). If the assistant did not list its
          // sources, the book does: every read this job made, with the basis the read reported.
          if (!result.sources.length) {
            const reads = (await this.core.book.listSteps(c, claims.sub)).filter((s) => s.kind === 'ability' && s.ability_key && (s.output_ref as any)?.basis);
            result.sources = [...new Set(reads.map((s) => `${s.ability_key}: ${(s.output_ref as any).basis}`))];
          }
          const pending = (await this.core.book.openWaits(c, claims.sub)).filter((w) => w.status === 'pending');
          if (pending.length) return { status: 'refused', code: 'job_waiting', reason: 'the job is waiting on an answer; it cannot finish now' } as GateResult;
          const failed = result.outcome === 'failed';
          const consumed = await this.core.book.consumeReadyWaits(c, claims.sub);
          await this.core.book.markReported(c, co, consumed, `assistant:${claims.sub}`, { outcome: result.outcome, summary: result.summary });
          await this.core.book.addStep(c, { company_id: co, job_id: claims.sub, kind: failed ? 'failed' : 'report', summary: result.summary, output_ref: result });
          await this.core.book.setJobStatus(c, claims.sub, failed ? 'FAILED' : 'DONE', { result, clearClaim: true });
          await this.core.book.emit(c, co, failed ? 'task.failed' : 'task.completed', { job_id: claims.sub, task_id: job.task_id, result }, `finish:${claims.sub}`);
          return { status: 'ok' } as GateResult;
        });
      }
    }
    return { status: 'refused', code: 'unknown_ability', reason: key };
  }

  async heartbeat(claims: JobTokenClaims): Promise<void> {
    await this.core.company(claims.company_id, async (c) => {
      const r = await c.query(
        `update ${this.core.key}.jobs set claimed_until = now() + ($3 || ' milliseconds')::interval, heartbeat_at = now()
          where id = $1 and claimed_by = $2 and status in ('RUNNING', 'WAITING')`,
        [claims.sub, claims.sid, String(this.core.cfg.timings.claimMs)],
      );
      if (!r.rowCount) throw new SessionLost('claim lost');
    });
  }
}

/** The same ability with the same arguments, still open (waiting for a yes) or approved and not yet done. */
async function openTwin(c: PoolClient, schema: string, key: string, args: unknown): Promise<{ id: string; status: string } | null> {
  const r = await c.query<{ id: string; status: string }>(
    `select id, status from ${schema}.proposals
      where ability_key = $1 and args = $2::jsonb and status in ('PROPOSED', 'APPROVED', 'EXECUTING') and expires_at > now()
      order by created_at desc limit 1`,
    [key, JSON.stringify(args)],
  );
  return r.rows[0] ?? null;
}

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** A plain label for an input field, from its schema: its title, else its name in words (with the unit it is in). */
export function plainLabel(name: string, prop: Record<string, any> = {}): string {
  if (typeof prop.title === 'string' && prop.title.trim()) return prop.title.trim().slice(0, 200);
  let base = name;
  let unit = '';
  if (base.endsWith('_minor')) (base = base.slice(0, -6)), (unit = ' (in minor units: paise or cents)');
  else if (base.endsWith('_bps')) (base = base.slice(0, -4)), (unit = ' (basis points: 1800 is 18%)');
  if (prop.format === 'date') unit = ' (YYYY-MM-DD)';
  const words = base.replace(/_/g, ' ').replace(/\bgst\b/i, 'GST').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${unit}`.slice(0, 200);
}

function fieldType(prop: Record<string, any> = {}): 'text' | 'number' | 'date' | 'boolean' {
  if (prop.type === 'integer' || prop.type === 'number') return 'number';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.format === 'date') return 'date';
  return 'text';
}

/**
 * The asked fields plus every required input of the write that is neither asked for nor already known —
 * a question for a change never leaves out what that change cannot go ahead without. Fields the model added
 * that are not required give way first when the question would be longer than its limit.
 */
export function withRequiredFields(asked: unknown, input: Record<string, any>, known: unknown): unknown {
  const fields: any[] = Array.isArray(asked) ? [...asked] : [];
  const have = known && typeof known === 'object' && !Array.isArray(known) ? (known as Record<string, unknown>) : {};
  const props = (input?.properties ?? {}) as Record<string, any>;
  const required = ((input?.required ?? []) as string[]).filter((k) => k !== 'card');
  const missing = required.filter((k) => {
    const v = have[k];
    return (v === undefined || v === null || v === '') && !fields.some((f) => f && typeof f === 'object' && f.key === k) && FIELD_KEY.test(k);
  });
  const added = missing.map((k) => ({ key: k, label: plainLabel(k, props[k]), type: fieldType(props[k]), required: true }));
  let keep = fields;
  while (keep.length + added.length > QUESTION_LIMITS.fields) {
    const i = keep.map((f) => required.includes(f?.key)).lastIndexOf(false);
    if (i < 0) break;
    keep = keep.filter((_, j) => j !== i);
  }
  return [...keep, ...added].slice(0, QUESTION_LIMITS.fields);
}
