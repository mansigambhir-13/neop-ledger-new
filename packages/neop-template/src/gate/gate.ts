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
//   7. ask-first with a grant covering it → proposal APPROVED by the grant,
//      execution token from the platform, same execute path
//   8. ask-first otherwise → proposal + wait, return the proposal id

import { randomUUID } from 'node:crypto';
import { canonicalize, fingerprint, sha256, type JobTokenClaims, type ProposalCard, type Proof, type TaskResult } from '@neop/contracts';
import { executeProposal, measure, runEffect } from '../capabilities/execute.ts';
import { ruleUsage } from '../capabilities/usage.ts';
import type { Core } from '../core.ts';
import type { PoolClient } from '@neop/pgkit';
import type { JobRow } from '../data/book.ts';
import { checkRules } from '../domain/rules.ts';
import type { ExecCtx } from '../types.ts';
import { BUILTIN_TOOLS } from './tools.ts';

export type GateResult =
  | { status: 'done'; ability: string; output: unknown; untrusted: boolean }
  | { status: 'done_by_grant'; ability: string; proposal_id: string; proof: Proof }
  | { status: 'proposed'; ability: string; proposal_id: string; fingerprint: string; expires_at: string }
  | { status: 'waiting_on_app'; app: string; task_id: string }
  | { status: 'waiting_until'; at: string }
  /** `detail` is what another party said (owner app, platform): shown to the model as untrusted data (item 10). */
  | { status: 'refused'; code: string; reason: string; detail?: unknown; detail_source?: string }
  | { status: 'ok'; detail?: unknown };

export const MAX_TOOL_CALLS = 40;
/** job.finish attempts allowed past the cap, so a capped job can still report. */
const FINISH_GRACE = 5;
/** job.wait_until: how far ahead a job may park itself. */
const MAX_WAIT_MS = 31 * 86_400_000;

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
    if (key === 'a2a.request') return this.a2a(claims, job, rawArgs);

    // 1. scope
    if (!claims.abilities.includes(key)) {
      return this.refuse(claims, key, 'not_in_scope', `${key} is not switched on for this job`);
    }
    // 2. manifest (own, or an installed package); anything else in scope is borrowed
    const resolved = await this.core.resolve(claims.company_id, key);
    if (!resolved) return this.borrow(claims, key, rawArgs);
    const ability = resolved.meta;
    const handler = resolved.handler;

    // 3. setting
    const board = await this.core.board.get(claims.company_id);
    const setting = board.setting(ability);
    if (setting === 'off') return this.refuse(claims, key, 'switched_off', `${key} is switched off`);

    // Split the card from the args of an ask-first write; the card is presentation, not content.
    let args: unknown = rawArgs ?? {};
    let card: ProposalCard | null = null;
    if (ability.kind === 'write' && setting === 'ask_first' && args && typeof args === 'object' && !Array.isArray(args)) {
      const { card: c, ...rest } = args as Record<string, unknown>;
      card = (c as ProposalCard) ?? null;
      args = rest;
    }
    if (handler.kind === 'write' && handler.normalize) {
      const nargs = args;
      args = await this.core.company(claims.company_id, (db) =>
        handler.normalize!(nargs, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), db }),
      );
    }
    const invalid = resolved.checkInput(args) ?? (handler.kind === 'write' ? (handler.check?.(args) ?? null) : null);
    if (invalid) return this.refuse(claims, key, 'invalid_args', invalid);
    if (handler.kind === 'write' && handler.validate) {
      const v = await this.core.company(claims.company_id, (db) =>
        handler.validate!(args, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), db }),
      );
      if (v) return this.refuse(claims, key, 'not_possible', v);
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
        handler.run(args, { company_id: claims.company_id, caller: `assistant:${claims.sub}`, job_id: claims.sub, now: new Date(), db }),
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
        });
        await this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'ability', summary: `${ability.title}: ${res.outcome}`, ability_key: key });
      });
      return { status: 'done', ability: key, output: res, untrusted: true };
    }

    // 7–8. ask first
    if (!card || !card.what || !card.why || !card.changes || !card.if_no_answer) {
      return this.refuse(claims, key, 'card_required', 'an ask-first call needs a card: what, why, changes, if_no_answer');
    }
    const proposalId = randomUUID();
    const fp = fingerprint({ key, version: ability.version, args, company_id: claims.company_id, job_id: claims.sub });

    const grant = await this.core.platform
      .grantExecutionToken({
        company_id: claims.company_id,
        job_id: claims.sub,
        proposal_id: proposalId,
        ability_key: key,
        ability_version: ability.version,
        fingerprint: fp,
        ...m,
      })
      .catch(() => null);

    if (grant) {
      const exec = await this.core.gatewayAuth.verifyExecution(grant.token, { company_id: claims.company_id, proposal_id: proposalId, fingerprint: fp });
      await this.core.company(claims.company_id, async (c) => {
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
          grant_id: grant.grant_id,
          decided_by: `grant:${grant.grant_id}`,
          ttl_ms: this.core.cfg.timings.proposalTtlMs,
        });
        await this.core.book.proposalEvent(c, { company_id: claims.company_id, proposal_id: proposalId, event: 'approved_by_grant', actor: `grant:${grant.grant_id}`, fingerprint_seen: fp });
        await this.linkSuperseded(c, claims, key, proposalId);
        await this.core.book.addStep(c, {
          company_id: claims.company_id,
          job_id: claims.sub,
          kind: 'proposal',
          summary: `${ability.title}: covered by a standing yes (grant ${grant.grant_id.slice(0, 8)})`,
          ability_key: key,
          output_ref: { proposal_id: proposalId },
        });
      });
      const proof = await executeProposal(this.core, claims.company_id, proposalId, { fingerprint: fp, sub: exec.sub, ability_version: exec.ability_version ?? null });
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

  /** A borrowed read: through the gateway as this app; recorded in this book with the gateway's request id (R4). */
  private async borrow(claims: JobTokenClaims, key: string, args: unknown): Promise<GateResult> {
    const board = await this.core.board.get(claims.company_id);
    const b = (await this.core.borrowed.list(claims.company_id, board)).find((x) => x.key === key);
    if (!b || b.setting === 'off') return this.refuse(claims, key, 'switched_off', `${key} is not available to borrow here`);
    const v = this.core.borrowed.validators(b);
    if (!v.input(args)) return this.refuse(claims, key, 'invalid_args', this.core.borrowed.errors(v.input));
    const idem = `${this.core.key}:borrow:${claims.sub}:${sha256(canonicalize({ key, args }))}`;
    const res = await this.core.platform.gatewayCall({ company_id: claims.company_id, app: b.owner, endpoint: key, body: args, idem_key: idem });
    if (res.status !== 200) {
      // The owner's words are outside text: data for the model, never instruction (item 10).
      return this.refuse(claims, key, 'owner_refused', `${b.owner} answered ${res.status}`, { detail: res.body?.error?.message ?? 'refused', detail_source: b.owner });
    }
    const out = res.body?.result;
    if (!v.output(out)) return this.refuse(claims, key, 'contract_violation', `${b.owner} returned a result outside its schema`);
    await this.core.company(claims.company_id, async (c) => {
      await this.core.book.recordOperation(c, {
        company_id: claims.company_id,
        job_id: claims.sub,
        caller: `assistant:${claims.sub}`,
        ability_key: `borrow:${b.owner}:${key}`,
        idempotency_key: idem,
        outcome: 'answered',
        gateway_request_id: res.request_id,
      });
      await this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'ability', summary: `Asked ${b.owner}: ${b.ability.title}`, ability_key: key });
    });
    return { status: 'done', ability: key, output: out, untrusted: true };
  }

  /**
   * Hand a task to another app; the job waits on it like it waits on a person (Phase 4).
   * The wait is written BEFORE the platform is asked (item 5): a result that comes back
   * faster than this call returns finds a hand-off in flight and is retried, never lost.
   */
  private async a2a(claims: JobTokenClaims, job: JobRow, args: any): Promise<GateResult> {
    const targets = this.core.borrowed.a2aTargets();
    if (!args || typeof args.app !== 'string' || !targets.includes(args.app) || typeof args.ask !== 'string' || args.ask.trim().length < 3) {
      return this.refuse(claims, 'a2a.request', 'invalid_args', `app must be one of ${targets.join(', ') || '(none)'} and ask is required`);
    }
    const wait = await this.core.company(claims.company_id, (c) =>
      this.core.book.insertWait(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'a2a_task', ref_id: null, expires_at_sql: `now() + interval '24 hours'` }),
    );
    let res: { status: number; body: any };
    try {
      res = await this.core.platform.openA2A({ company_id: claims.company_id, target: args.app, ask: args.ask, parent_task_id: job.task_id, host_job_id: claims.sub });
    } catch (e) {
      res = { status: 502, body: { error: { code: 'a2a_unreachable', message: String(e) } } };
    }
    if (res.status !== 200) {
      await this.core.company(claims.company_id, (c) =>
        c.query(`update ${this.core.key}.waits set status = 'consumed', ready_at = now(), outcome = 'NOT_OPENED' where id = $1 and status = 'pending'`, [wait.id]),
      );
      return this.refuse(claims, 'a2a.request', res.body?.error?.code ?? 'a2a_refused', `the platform answered ${res.status}`, {
        detail: res.body?.error?.message ?? null,
        detail_source: 'platform',
      });
    }
    const taskId = res.body.task_id as string;
    await this.core.company(claims.company_id, async (c) => {
      await c.query(`update ${this.core.key}.waits set ref_id = $2 where id = $1`, [wait.id, taskId]);
      const consumed = await this.core.book.consumeReadyWaits(c, claims.sub);
      await this.core.book.markReported(c, claims.company_id, consumed, `assistant:${claims.sub}`, { next_task: taskId });
      await this.core.book.setJobStatus(c, claims.sub, 'WAITING');
      await this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'system', summary: `Handed to ${args.app} (task ${taskId.slice(0, 8)}): ${args.ask}` });
      await this.core.book.emit(c, claims.company_id, 'a2a.requested', { job_id: claims.sub, task_id: taskId, target: args.app, lineage: res.body.lineage }, `a2a:${taskId}`);
    });
    return { status: 'waiting_on_app', app: args.app, task_id: taskId };
  }

  private async refuse(claims: JobTokenClaims, key: string, code: string, reason: string, outside?: { detail: unknown; detail_source: string }): Promise<GateResult> {
    await this.core
      .company(claims.company_id, (c) =>
        this.core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'refused', summary: `Refused ${key}: ${reason}`, ability_key: key }),
      )
      .catch(() => {});
    return outside ? { status: 'refused', code, reason, ...outside } : { status: 'refused', code, reason };
  }

  // ── built-in tools: book.note, card.raise, job.wait_until, job.finish ─────
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
        }
        await this.core.company(co, async (c) => {
          await this.core.book.addStep(c, { company_id: co, job_id: claims.sub, kind: 'note', summary: args.text });
          for (const f of facts) await this.core.book.addFact(c, { company_id: co, job_id: claims.sub, subject: f.subject, value: f.value ?? null, source: f.source });
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
        `update ${this.core.key}.jobs set claimed_until = now() + ($3 || ' milliseconds')::interval
          where id = $1 and claimed_by = $2 and status in ('RUNNING', 'WAITING')`,
        [claims.sub, claims.sid, String(this.core.cfg.timings.claimMs)],
      );
      if (!r.rowCount) throw new SessionLost('claim lost');
    });
  }
}
