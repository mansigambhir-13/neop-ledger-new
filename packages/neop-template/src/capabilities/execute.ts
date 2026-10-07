import {sqlIdent} from '@neop/pgkit';
// The approved path. The only way an approved thing ever happens, whether the
// yes came from a person (answer_proposal() → the runner, runner/waits.ts) or
// from a grant a person wrote (inline in the gate). No model, no platform and
// no token sit between the yes and the effect (v3 §6).
//
// Contract: under the execution lock and the row lock — state APPROVED; the
// approving event's fingerprint equals the proposal's; not expired; the ability
// version, the switch and the company rules re-checked — set EXECUTING; call
// the door with a door-level idempotency key; read back; set DONE, FAILED or
// UNKNOWN; only then mark the wait ready; return proof. A retried execute on a
// terminal proposal returns the stored proof and does nothing. A dead executor
// (EXECUTING, nobody holding the lock) is resumed read-back first, with the same
// idempotency key (at least once + door idempotency + read-back).

import { getPointer, type ExecOutcome, type ManifestAbility, type Proof } from '@neop/contracts';
import type { PoolClient } from '@neop/pgkit';
import type { Core } from '../core.ts';
import type { ProposalRow } from '../data/book.ts';
import { DoorError } from '../doors/errors.ts';
import { EXECUTION_TERMINAL } from '../domain/proposals.ts';
import { checkRules } from '../domain/rules.ts';
import type { ExecCtx, Measure, WriteAbility } from '../types.ts';
import { ruleUsage } from './usage.ts';

export class ExecError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EFFECT_TIMEOUT_MS = 20_000;

export async function measure(ability: ManifestAbility, handler: WriteAbility, args: unknown, db?: PoolClient): Promise<Measure> {
  if (handler.measure) return handler.measure(args, db);
  const e = ability.effects ?? {};
  const m: Measure = {};
  if (e.amount_minor) {
    const v = getPointer(args, e.amount_minor);
    if (typeof v === 'number') m.amount_minor = v;
  }
  if (e.currency) {
    const v = e.currency.startsWith('/') ? getPointer(args, e.currency) : e.currency;
    if (typeof v === 'string') m.currency = v;
  }
  if (e.recipients) {
    const v = getPointer(args, e.recipients);
    if (Array.isArray(v)) m.recipients = v.filter((x): x is string => typeof x === 'string');
  }
  return m;
}

function execCtx(core: Core, p: { company_id: string; job_id: string | null; idempotency_key: string }, caller: string, companyName: string): ExecCtx {
  return {
    company_id: p.company_id,
    company_name: companyName,
    caller,
    job_id: p.job_id,
    now: new Date(),
    idempotencyKey: p.idempotency_key,
    doors: core.doors(p.company_id),
    withDb: (fn) => core.company(p.company_id, fn),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`effect timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run a write's effect and read it back. Never throws; maps every failure to an
 * outcome. `resumed` means a previous attempt may already have done it.
 */
export async function runEffect(
  handler: WriteAbility,
  args: unknown,
  ctx: ExecCtx,
  resumed: boolean,
): Promise<{ outcome: ExecOutcome; external_ref: string | null; read_back: unknown; error: string | null; detail?: unknown }> {
  if (resumed) {
    try {
      const rb = await withTimeout(handler.readBack(args, ctx, null), EFFECT_TIMEOUT_MS);
      if (rb.found) return { outcome: 'DONE', external_ref: null, read_back: rb.data, error: null };
    } catch {
      // fall through and retry the effect with the same idempotency key
    }
  }
  let external_ref: string | null = null;
  let detail: unknown;
  try {
    const res = await withTimeout(handler.execute(args, ctx), EFFECT_TIMEOUT_MS);
    external_ref = res.external_ref;
    detail = res.detail;
  } catch (e) {
    if (e instanceof DoorError && e.definite) {
      return { outcome: 'FAILED', external_ref: null, read_back: null, error: e.message };
    }
    // Indeterminate: it may or may not have happened. Look before deciding.
    try {
      const rb = await withTimeout(handler.readBack(args, ctx, null), EFFECT_TIMEOUT_MS);
      if (rb.found) return { outcome: 'DONE', external_ref: null, read_back: rb.data, error: null };
    } catch {
      /* unknown */
    }
    return { outcome: 'UNKNOWN', external_ref: null, read_back: null, error: (e as Error).message };
  }
  try {
    const rb = await withTimeout(handler.readBack(args, ctx, external_ref), EFFECT_TIMEOUT_MS);
    return rb.found
      ? { outcome: 'DONE', external_ref, read_back: rb.data, error: null, detail }
      : { outcome: 'UNKNOWN', external_ref, read_back: null, error: 'read-back did not find the effect', detail };
  } catch (e) {
    return { outcome: 'UNKNOWN', external_ref, read_back: null, error: `read-back failed: ${(e as Error).message}`, detail };
  }
}

/** Who carries a proposal out: `runner:<id>` (a person's yes) or `grant:<id>` (a standing yes, inline in the gate). */
export interface ExecBy {
  actor: string;
  request_id?: string | null;
  trace?: string | null;
}

/** The advisory lock that says "someone alive is carrying this proposal out" (session-level, on a direct connection). */
export const execLockKey = (proposalId: string) => `exec:${proposalId}`;

/**
 * Carry out one approved proposal (v3 §6: no token — the row says APPROVED, and the checks below are made
 * at effect time against the book itself). Takes the execution lock on its own connection; a concurrent
 * attempt is told "in progress".
 */
export async function executeProposal(core: Core, companyId: string, proposalId: string, by: ExecBy): Promise<Proof> {
  // Liveness, not a timer: whoever carries this proposal out holds a session-level advisory lock for the
  // whole effect. If that process dies, its connection closes and the lock is released at once, so the
  // runner's poll resumes it (read back first); while it is alive, a concurrent execute is told "in progress".
  const lock = await core.execLockPool.connect();
  let got: boolean;
  try {
    got = (await lock.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [execLockKey(proposalId)])).rows[0]!.ok;
  } catch (e) {
    lock.release();
    throw e;
  }
  if (!got) {
    lock.release();
    throw new ExecError(409, 'in_progress', 'this proposal is being carried out right now');
  }
  return executeHeld(core, lock, companyId, proposalId, by);
}

/**
 * Carry out a proposal whose execution lock `lock` already holds (the runner's claim), then release the
 * lock and the connection, whatever happens.
 */
export async function executeHeld(core: Core, lock: PoolClient, companyId: string, proposalId: string, by: ExecBy): Promise<Proof> {
  try {
    return await executeLocked(core, companyId, proposalId, by);
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1))', [execLockKey(proposalId)]).catch(() => {});
    lock.release();
  }
}

/**
 * Why an APPROVED proposal must not run now, checked at effect time under its row lock (v3 §6): the
 * approving answer was given against exactly this fingerprint (the `answered:yes` event a person's yes left
 * through answer_proposal(), or the `approved_by_grant` event of a standing yes), and the proposal has not
 * expired. Null when it may run.
 */
async function refusalAtEffectTime(core: Core, c: PoolClient, p: ProposalRow): Promise<string | null> {
  const ev = (
    await c.query<{ fingerprint_seen: string | null; expired: boolean }>(
      `select e.fingerprint_seen, p.expires_at <= now() as expired
         from ${sqlIdent(core.key)}.proposals p
         left join lateral (select fingerprint_seen from ${sqlIdent(core.key)}.proposal_events
                             where proposal_id = p.id and event in ('answered:yes', 'approved_by_grant') order by id desc limit 1) e on true
        where p.id = $1`,
      [p.id],
    )
  ).rows[0];
  if (!ev || ev.fingerprint_seen === null) return 'fingerprint_mismatch: no yes is on record for this proposal';
  if (ev.fingerprint_seen !== p.fingerprint) return 'fingerprint_mismatch: the yes on record was given to a different version of this proposal';
  if (ev.expired) return `expired: proposal ${p.id.slice(0, 8)} expired before it could be carried out`;
  return null;
}

async function executeLocked(core: Core, companyId: string, proposalId: string, by: ExecBy): Promise<Proof> {
  // 1. Lock the row, check, move to EXECUTING.
  const start = await core.company(companyId, async (c) => {
    const p = await core.book.getProposal(c, proposalId, true);
    if (!p) throw new ExecError(404, 'not_found', 'no such proposal');
    if (EXECUTION_TERMINAL.includes(p.status)) return { p, stored: p.proof as Proof, resumed: false, refused: null as string | null };
    if (p.status !== 'APPROVED' && p.status !== 'EXECUTING') {
      throw new ExecError(409, 'not_approved', `proposal is ${p.status}`);
    }
    // EXECUTING while we hold the lock means the previous executor died: resume (read back first).
    const resumed = p.status === 'EXECUTING';
    let refused: string | null = null;
    if (!resumed) {
      refused = await refusalAtEffectTime(core, c, p);
      // A refusal still takes the legal road (APPROVED → EXECUTING → FAILED), so the job wakes to say why.
      await core.book.updateProposal(c, p.id, { status: 'EXECUTING' });
      await core.book.proposalEvent(c, { company_id: companyId, proposal_id: p.id, event: 'executing', actor: by.actor, fingerprint_seen: p.fingerprint });
    } else {
      await core.book.proposalEvent(c, { company_id: companyId, proposal_id: p.id, event: 'execute_resumed', actor: by.actor });
    }
    return { p, stored: null as Proof | null, resumed, refused };
  });
  if (start.stored) return start.stored;
  const p = start.p;
  if (start.refused) {
    return finish(core, p, { outcome: 'FAILED', external_ref: null, read_back: null, error: start.refused }, by);
  }
  const resolved = await core.resolve(companyId, p.ability_key);
  const ability = resolved?.meta;
  const handler = resolved?.handler;
  if (!ability || !handler || handler.kind !== 'write') {
    return finish(core, p, { outcome: 'FAILED', external_ref: null, read_back: null, error: `ability ${p.ability_key} is not a write in this version` }, by);
  }

  // Gate step 2 at effect time: the yes was given to one version of the ability. If the app now runs
  // another, nothing runs; the job wakes to tell the person and propose again. A resumed execute has begun.
  if (!start.resumed && p.ability_version !== ability.version) {
    return finish(core, p, { outcome: 'FAILED', external_ref: null, read_back: null, error: `version_changed: proposed against ${p.ability_key}@${p.ability_version}, this app now runs ${ability.version}` }, by);
  }

  // The setting is re-read, not trusted from a cache: switched off since the yes → it does not run.
  core.board.invalidate(companyId);
  const board = await core.board.get(companyId);
  if (!start.resumed && board.setting(ability) === 'off') {
    return finish(core, p, { outcome: 'FAILED', external_ref: null, read_back: null, error: `switched_off: ${p.ability_key} was switched off before it could run` }, by);
  }

  // 2. Company rules are checked again at effect time ("nothing goes out on weekends").
  const m = await core.company(companyId, (c) => measure(ability, handler, p.args, c));
  const usage = await core.company(companyId, (c) => ruleUsage(core, c, board, m.currency, p.id));
  const violation = checkRules(board.rules, { ability_key: p.ability_key, external: !!ability.effects?.external, ...m }, new Date(), board.company.time_zone, usage);
  if (violation) {
    return finish(core, p, { outcome: 'FAILED', external_ref: null, read_back: null, error: `rule ${violation.rule_id}: ${violation.reason}` }, by);
  }

  // 3. The effect, outside any transaction.
  await core.hooks.beforeExecuteEffect?.(p.id);
  const ctx = execCtx(core, p, by.actor, board.company.name);
  const span = core.tracer.start(`door ${p.ability_key}`, by.trace ?? null, { 'neop.proposal': p.id, 'neop.resumed': !!start.resumed });
  const res = await runEffect(handler, p.args, ctx, !!start.resumed);
  span.set('neop.outcome', res.outcome).end(res.outcome === 'DONE' ? 'ok' : 'error', res.error ?? undefined);
  core.metrics.inc('neop_execute_total', 'Approved actions carried out, by outcome', { app: core.key, ability: p.ability_key, outcome: res.outcome });
  await core.hooks.afterExecuteEffect?.(p.id);
  return finish(core, p, res, by, m);
}

async function finish(
  core: Core,
  p: ProposalRow,
  res: { outcome: ExecOutcome; external_ref: string | null; read_back: unknown; error: string | null },
  by: ExecBy,
  m: Measure = {},
): Promise<Proof> {
  const proof: Proof = { outcome: res.outcome, external_ref: res.external_ref, read_back: res.read_back, error: res.error, at: new Date().toISOString() };
  return core.company(p.company_id, async (c) => {
    // The outcome is written once: if another attempt already finished, its proof stands.
    const cur = await core.book.getProposal(c, p.id, true);
    if (cur && cur.status !== 'EXECUTING') return cur.proof as Proof;
    // executed_at: the attempt is over (whatever its outcome); verified_at: a read-back found the effect (t007).
    await core.book.updateProposal(c, p.id, { status: res.outcome, proof }, { executed: true, verified: res.outcome === 'DONE' });
    await core.book.proposalEvent(c, { company_id: p.company_id, proposal_id: p.id, event: `executed:${res.outcome}`, actor: by.actor, detail: proof });
    await core.book.recordOperation(c, {
      company_id: p.company_id,
      job_id: p.job_id,
      caller: by.actor,
      ability_key: p.ability_key,
      idempotency_key: p.idempotency_key,
      outcome: res.outcome,
      gateway_request_id: by.request_id ?? null,
      trace_id: by.trace ?? null,
      detail: { proposal_id: p.id, amount_minor: m.amount_minor ?? null, currency: m.currency ?? null, external_ref: res.external_ref },
      request: p.args,
      result: proof,
      reason: `${p.approved_via === 'grant' ? 'a standing yes' : 'a yes'} from ${p.decided_by ?? 'unknown'} on proposal ${p.id}${res.error ? ` · ${res.error}` : ''}`,
    });
    await core.book.emit(c, p.company_id, 'proposal.executed', { proposal_id: p.id, job_id: p.job_id, outcome: res.outcome, proof }, `executed:${p.id}`);
    // B2: the job wakes only now that execution is terminal.
    const woke = await core.book.readyWait(c, p.id, res.outcome, { proposal_id: p.id, status: res.outcome, proof, decided_by: p.decided_by, approved_via: p.approved_via });
    if (woke) await core.book.notify(c, `wait:${p.job_id}`);
    return proof;
  });
}

/** Reconcile UNKNOWN outcomes by reading back (runner loop). */
export async function reconcileUnknown(core: Core, p: ProposalRow): Promise<ExecOutcome> {
  const handler = (await core.resolve(p.company_id, p.ability_key))?.handler;
  if (!handler || handler.kind !== 'write') return 'UNKNOWN';
  const board = await core.board.get(p.company_id).catch(() => null);
  const ctx = execCtx(core, p, 'runner:reconcile', board?.company.name ?? '');
  let found = false;
  let data: unknown = null;
  try {
    const rb = await handler.readBack(p.args, ctx, (p.proof as Proof | null)?.external_ref ?? null);
    found = rb.found;
    data = rb.data;
  } catch {
    return 'UNKNOWN';
  }
  const attempts = ((p.proof as any)?.reconcile_attempts ?? 0) + 1;
  const outcome: ExecOutcome = found ? 'DONE' : attempts >= 10 ? 'FAILED' : 'UNKNOWN';
  await core.company(p.company_id, async (c) => {
    const proof = { ...(p.proof as object), outcome, read_back: data, reconcile_attempts: attempts, at: new Date().toISOString() };
    if (outcome === 'UNKNOWN') {
      await core.book.updateProposal(c, p.id, { proof });
      return;
    }
    await core.book.updateProposal(c, p.id, { status: outcome, proof }, { verified: outcome === 'DONE' });
    await core.book.proposalEvent(c, { company_id: p.company_id, proposal_id: p.id, event: `reconciled:${outcome}`, actor: 'runner:reconcile', detail: proof });
    await core.book.addStep(c, {
      company_id: p.company_id,
      job_id: p.job_id,
      kind: 'system',
      summary: `Proposal ${p.id.slice(0, 8)} reconciled: ${outcome === 'DONE' ? 'the effect is confirmed' : 'the effect was never found'}.`,
    });
    await core.book.emit(c, p.company_id, 'proposal.executed', { proposal_id: p.id, job_id: p.job_id, outcome, proof, reconciled: true }, `reconciled:${p.id}`);
  });
  return outcome;
}
