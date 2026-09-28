// THE GATE · talking to other apps · template-only (v3 §9 "Talking to other NEOPs", §10 "Borrowing one ability").
// Three tools reach another app: a2a.request (hand it a task), a borrowed line (one of its abilities) and, on the
// bus, a2a.answer (answer its question about a task this job handed it). Which road they take is the presence flag:
//
//   NEOP_PRESENCE on  — the bus road (V3 migration S6). A typed neos.neop.task / neos.neop.ask in the company's bus
//                       room (#neop-bus-<co>), sent as this app's own Matrix name (runner/bus.ts). The job waits on
//                       an `a2a_task` wait keyed by its bus thread (<schema>.bus_threads, t015); the other app's
//                       `done` / `answer` readies it with the result as untrusted data; its `ask` wakes it with a
//                       question this job answers with a2a.answer (or asks its person first, then relays). The chain
//                       of apps travels in the task body (lineage, depth ≤ 3): refused here early, and by the callee.
//   NEOP_PRESENCE off — the platform road (today, until S9): openA2A / the gateway call / borrowDescribe.
//
// The wait is always written BEFORE anything is sent (item 5): an answer that comes back faster than this call
// returns finds the wait (and, on the bus, the thread row) already there.

import { randomUUID } from 'node:crypto';
import { canonicalize, sha256, type JobTokenClaims } from '@neop/contracts';
import type { JobRow } from '../data/book.ts';
import type { Gate, GateResult } from './gate.ts';

/** a2a chains stop at this depth (the platform's rule in openA2ATask, now the callee's on the bus). */
export const A2A_MAX_DEPTH = 3;

/** An a2a hand-off wait lasts this long before it wakes its job as EXPIRED (runner.expire). */
const A2A_WAIT = `now() + interval '24 hours'`;

type HandOff = { target: string; ask: string; ability?: string; args?: Record<string, unknown> };

// ── a2a.request ─────────────────────────────────────────────────────────────
/** Hand a task to another app; the job waits on it like it waits on a person (Phase 4). */
export async function a2aRequest(gate: Gate, claims: JobTokenClaims, job: JobRow, args: any): Promise<GateResult> {
  const targets = gate.core.borrowed.a2aTargets();
  if (!args || typeof args.app !== 'string' || !targets.includes(args.app) || typeof args.ask !== 'string' || args.ask.trim().length < 3) {
    return gate.refuse(claims, 'a2a.request', 'invalid_args', `app must be one of ${targets.join(', ') || '(none)'} and ask is required`);
  }
  return handOff(gate, claims, job, 'a2a.request', { target: args.app, ask: args.ask });
}

/** Open a task at another app and make this job wait on it (a2a.request, and borrowed writes). */
export async function handOff(gate: Gate, claims: JobTokenClaims, job: JobRow, toolKey: string, req: HandOff): Promise<GateResult> {
  return gate.core.presenceOn ? busHandOff(gate, claims, job, toolKey, req) : platformHandOff(gate, claims, job, toolKey, req);
}

// ── borrowed lines ──────────────────────────────────────────────────────────
/**
 * A borrowed ability (v3 §10). A WRITE is never run here: the owner proposes it and a person says yes there. Off
 * presence: a read goes through the gateway as this app (recorded here with the gateway's request id, R4) and a
 * write is handed over as an a2a task. On presence: both are one typed ask carrying {ability, args} in the bus room;
 * the job waits for the owner's typed answer (a read at once, with no model there; a write after execution).
 */
export async function borrow(gate: Gate, claims: JobTokenClaims, job: JobRow, key: string, args: unknown): Promise<GateResult> {
  const core = gate.core;
  const board = await core.board.get(claims.company_id);
  const b = (await core.borrowed.list(claims.company_id, board)).find((x) => x.key === key);
  if (!b || b.setting === 'off') return gate.refuse(claims, key, 'switched_off', `${key} is not available to borrow here`);
  const v = core.borrowed.validators(b);
  if (b.ability.kind === 'write' || core.presenceOn) {
    // The card (if the model added one) is the owner's to write; only the inputs travel.
    const { card: _card, ...inputs } = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : ({} as Record<string, unknown>);
    if (!v.input(inputs)) return gate.refuse(claims, key, 'invalid_args', core.borrowed.errors(v.input));
    return handOff(gate, claims, job, key, { target: b.owner, ask: `${b.ability.title} (${key})`, ability: key, args: inputs });
  }
  if (!v.input(args)) return gate.refuse(claims, key, 'invalid_args', core.borrowed.errors(v.input));
  const idem = `${core.key}:borrow:${claims.sub}:${sha256(canonicalize({ key, args }))}`;
  const res = await core.platform.gatewayCall({ company_id: claims.company_id, app: b.owner, endpoint: key, body: args, idem_key: idem });
  if (res.status !== 200) {
    // The owner's words are outside text: data for the model, never instruction (item 10).
    return gate.refuse(claims, key, 'owner_refused', `${b.owner} answered ${res.status}`, { detail: res.body?.error?.message ?? 'refused', detail_source: b.owner });
  }
  const out = res.body?.result;
  if (!v.output(out)) return gate.refuse(claims, key, 'contract_violation', `${b.owner} returned a result outside its schema`);
  await core.company(claims.company_id, async (c) => {
    await core.book.recordOperation(c, {
      company_id: claims.company_id,
      job_id: claims.sub,
      caller: `assistant:${claims.sub}`,
      ability_key: `borrow:${b.owner}:${key}`,
      idempotency_key: idem,
      outcome: 'answered',
      gateway_request_id: res.request_id,
      request: args,
      result: out,
      reason: `borrowed from ${b.owner}`,
    });
    await core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'ability', summary: `Asked ${b.owner}: ${b.ability.title}`, ability_key: key });
  });
  return { status: 'done', ability: key, output: out, untrusted: true };
}

// ── the platform road (NEOP_PRESENCE off; S9 deletes it) ───────────────────
async function platformHandOff(gate: Gate, claims: JobTokenClaims, job: JobRow, toolKey: string, req: HandOff): Promise<GateResult> {
  const core = gate.core;
  const args = { app: req.target, ask: req.ask };
  const wait = await core.company(claims.company_id, (c) =>
    core.book.insertWait(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'a2a_task', ref_id: null, expires_at_sql: A2A_WAIT }),
  );
  let res: { status: number; body: any };
  try {
    res = await core.platform.openA2A({
      company_id: claims.company_id,
      target: args.app,
      ask: args.ask,
      parent_task_id: job.task_id,
      host_job_id: claims.sub,
      ...(req.ability ? { ability: req.ability, args: req.args ?? {} } : {}),
    });
  } catch (e) {
    res = { status: 502, body: { error: { code: 'a2a_unreachable', message: String(e) } } };
  }
  if (res.status !== 200) {
    await core.company(claims.company_id, (c) =>
      c.query(`update ${core.key}.waits set status = 'consumed', ready_at = now(), outcome = 'NOT_OPENED' where id = $1 and status = 'pending'`, [wait.id]),
    );
    return gate.refuse(claims, toolKey, res.body?.error?.code ?? 'a2a_refused', `the platform answered ${res.status}`, {
      detail: res.body?.error?.message ?? null,
      detail_source: 'platform',
    });
  }
  const taskId = res.body.task_id as string;
  await core.company(claims.company_id, async (c) => {
    await c.query(`update ${core.key}.waits set ref_id = $2 where id = $1`, [wait.id, taskId]);
    await parkOnApp(gate, c, claims, req, taskId, res.body.lineage);
  });
  return { status: 'waiting_on_app', app: args.app, task_id: taskId };
}

/** The job now waits on the other app: what it was woken for is reported, the step written, a2a.requested emitted. */
async function parkOnApp(gate: Gate, c: import('@neop/pgkit').PoolClient, claims: JobTokenClaims, req: HandOff, taskId: string, lineage: unknown, road?: { name: string; wait: string }): Promise<void> {
  const core = gate.core;
  const consumed = await core.book.consumeReadyWaits(c, claims.sub, road?.wait ?? null);
  await core.book.markReported(c, claims.company_id, consumed, `assistant:${claims.sub}`, { next_task: taskId });
  await core.book.setJobStatus(c, claims.sub, 'WAITING');
  await core.book.addStep(c, {
    company_id: claims.company_id,
    job_id: claims.sub,
    kind: 'system',
    summary: `${req.ability ? `Handed one step to ${req.target}` : `Handed to ${req.target}`} (task ${taskId.slice(0, 8)}${road ? `, ${road.name}` : ''}): ${req.ask}`,
    ...(req.ability ? { ability_key: req.ability } : {}),
  });
  await core.book.emit(c, claims.company_id, 'a2a.requested', { job_id: claims.sub, task_id: taskId, target: req.target, lineage, ...(req.ability ? { ability: req.ability } : {}) }, `a2a:${taskId}`);
}

// ── the bus road (NEOP_PRESENCE on) ─────────────────────────────────────────
/** The chain this job is part of: the lineage of the bus task that opened it (none for a person's own ask). */
async function lineageOf(gate: Gate, claims: JobTokenClaims): Promise<string[]> {
  const core = gate.core;
  const r = await core.company(claims.company_id, (c) =>
    c.query<{ lineage: string[] }>(`select lineage from ${core.key}.bus_threads where direction = 'in' and kind = 'task' and job_id = $1 order by created_at limit 1`, [claims.sub]),
  );
  return Array.isArray(r.rows[0]?.lineage) ? r.rows[0]!.lineage : [];
}

async function busHandOff(gate: Gate, claims: JobTokenClaims, job: JobRow, toolKey: string, req: HandOff): Promise<GateResult> {
  const core = gate.core;
  const bus = core.bus;
  if (!bus) return gate.refuse(claims, toolKey, 'no_bus', 'this backend has no voice in the bus room (NEOP_PRESENCE is on but the bus road is not running here); nothing was sent');
  const lineage = [...(await lineageOf(gate, claims)), core.key];
  if (req.target === core.key || lineage.slice(0, -1).includes(req.target)) {
    return gate.refuse(claims, toolKey, 'a2a_loop', `${req.target} is already in this chain (${[...lineage, req.target].join(' → ')}); nothing was sent`);
  }
  if (lineage.length > A2A_MAX_DEPTH) return gate.refuse(claims, toolKey, 'a2a_depth', `a2a chains stop at depth ${A2A_MAX_DEPTH} (${lineage.join(' → ')}); nothing was sent`);
  let peer: Awaited<ReturnType<NonNullable<typeof bus>['peer']>>;
  let onBehalf: string;
  try {
    peer = await bus.peer(claims.company_id, req.target);
    onBehalf = await bus.personMxid(claims.company_id, job);
  } catch (e: any) {
    return gate.refuse(claims, toolKey, e?.code ?? 'no_bus', String(e?.message ?? e));
  }
  const taskId = randomUUID();
  const kind = req.ability ? 'call' : 'task';
  // The wait and the thread row first: an answer faster than this call finds both.
  const wait = await core.company(claims.company_id, async (c) => {
    const w = await core.book.insertWait(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'a2a_task', ref_id: taskId, expires_at_sql: A2A_WAIT });
    await c.query(
      `insert into ${core.key}.bus_threads (id, company_id, direction, kind, room_id, peer, peer_app, job_id, wait_id, task_id, ability, args, lineage, depth, status)
       values ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $13, $9, $10, $11, $12, 'sending')`,
      [taskId, claims.company_id, kind, peer.room, peer.mxid, req.target, claims.sub, w.id, req.ability ?? null, req.args ? JSON.stringify(req.args) : null, JSON.stringify(lineage), lineage.length, taskId],
    );
    return w;
  });
  let root: string;
  try {
    root = await bus.open(claims.company_id, peer, {
      kind,
      task_id: taskId,
      job_id: claims.sub,
      on_behalf_of: onBehalf,
      text: req.ask,
      lineage,
      ...(req.ability ? { ability: req.ability, args: req.args ?? {} } : {}),
    });
  } catch (e: any) {
    await core.company(claims.company_id, async (c) => {
      await c.query(`update ${core.key}.waits set status = 'consumed', ready_at = now(), outcome = 'NOT_OPENED' where id = $1 and status = 'pending'`, [wait.id]);
      await c.query(`update ${core.key}.bus_threads set status = 'not_opened', updated_at = now() where id = $1`, [taskId]);
    });
    return gate.refuse(claims, toolKey, e?.code ?? 'a2a_unreachable', `the task could not be sent in the bus room; nothing was asked of ${req.target}`, {
      detail: String(e?.message ?? e).slice(0, 300),
      detail_source: 'matrix',
    });
  }
  await core.company(claims.company_id, async (c) => {
    await c.query(`update ${core.key}.bus_threads set root_event_id = $2, status = case when status = 'sending' then 'open' else status end, updated_at = now() where id = $1`, [taskId, root]);
    await parkOnApp(gate, c, claims, req, taskId, lineage, { name: 'over the bus room', wait: wait.id });
  });
  return { status: 'waiting_on_app', app: req.target, task_id: taskId };
}

const ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * a2a.answer (bus road): answer the question another app asked about a task this job handed it. Only this job's
 * own open thread, only the question it is waiting on; the answer travels as a typed neos.neop.answer in that
 * thread (the other app takes it as relayed data, never as a person's word), and this job waits for the result again.
 */
export async function a2aAnswer(gate: Gate, claims: JobTokenClaims, _job: JobRow, args: any): Promise<GateResult> {
  const core = gate.core;
  if (!core.presenceOn || !core.bus) return gate.refuse(claims, 'a2a.answer', 'not_available', 'a2a.answer is for questions asked in the bus room; this app is not on it');
  if (typeof args?.task_id !== 'string' || !args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)) {
    return gate.refuse(claims, 'a2a.answer', 'invalid_args', 'task_id and answers (an object: field key → value) are required');
  }
  const answers: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args.answers as Record<string, unknown>)) {
    if (!ANSWER_KEY.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length > 4000)) {
      return gate.refuse(claims, 'a2a.answer', 'invalid_args', `answers.${k} must be a short text, a number or true/false under a lower_snake_case key`);
    }
    answers[k] = v as string | number | boolean;
  }
  if (!Object.keys(answers).length || Object.keys(answers).length > 10) return gate.refuse(claims, 'a2a.answer', 'invalid_args', 'give 1 to 10 answers');
  const row = (
    await core.company(claims.company_id, (c) =>
      c.query<{ id: string; peer: string; peer_app: string; room_id: string; root_event_id: string | null; question: any; status: string }>(
        `select id, peer, peer_app, room_id, root_event_id, question, status from ${core.key}.bus_threads where id::text = $1 and direction = 'out' and job_id = $2`,
        [args.task_id, claims.sub],
      ),
    )
  ).rows[0];
  if (!row || row.status !== 'open' || !row.root_event_id) return gate.refuse(claims, 'a2a.answer', 'unknown_task', `no open task ${args.task_id} of this job is waiting on an answer`);
  if (!row.question?.wait_id) return gate.refuse(claims, 'a2a.answer', 'no_question', `${row.peer_app} has not asked anything about task ${row.id.slice(0, 8)}`);
  const peerWait = String(row.question.wait_id);
  // The job waits for the result again: its wait first (the next word may come fast), then the answer is sent.
  const wait = await core.company(claims.company_id, (c) => core.book.insertWait(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'a2a_task', ref_id: row.id, expires_at_sql: A2A_WAIT }));
  try {
    await core.bus.answer(claims.company_id, { room: row.room_id, peer: row.peer, root: row.root_event_id }, { key: `bus:answer:${row.id}:${peerWait}`, wait_id: peerWait, answers });
  } catch (e: any) {
    await core.company(claims.company_id, (c) => c.query(`update ${core.key}.waits set status = 'consumed', ready_at = now(), outcome = 'NOT_OPENED' where id = $1 and status = 'pending'`, [wait.id]));
    return gate.refuse(claims, 'a2a.answer', 'a2a_unreachable', `the answer could not be sent in the bus room; ${row.peer_app} did not get it`, { detail: String(e?.message ?? e).slice(0, 300), detail_source: 'matrix' });
  }
  await core.company(claims.company_id, async (c) => {
    await c.query(`update ${core.key}.bus_threads set question = null, wait_id = $2, updated_at = now() where id = $1`, [row.id, wait.id]);
    const consumed = await core.book.consumeReadyWaits(c, claims.sub, wait.id);
    await core.book.markReported(c, claims.company_id, consumed, `assistant:${claims.sub}`, { answered_task: row.id });
    await core.book.setJobStatus(c, claims.sub, 'WAITING');
    await core.book.addStep(c, {
      company_id: claims.company_id,
      job_id: claims.sub,
      kind: 'system',
      summary: `Answered ${row.peer_app}'s question about task ${row.id.slice(0, 8)} (${Object.keys(answers).join(', ')}); waiting for its result.`,
    });
  });
  return { status: 'waiting_on_app', app: row.peer_app, task_id: row.id };
}
