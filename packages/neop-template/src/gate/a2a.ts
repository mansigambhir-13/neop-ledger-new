import {sqlIdent, type PoolClient} from '@neop/pgkit';
// THE GATE · talking to other apps · template-only (v3 §9 "Talking to other NEOPs", §10 "Borrowing one ability").
// Three tools reach another app: a2a.request (hand it a task), a borrowed line (one of its abilities) and a2a.answer
// (answer its question about a task this job handed it). There is one road (v3 S6; the only one since S9): a typed
// neos.neop.task / neos.neop.ask in the company's bus room (#neop-bus-<co>), sent as this app's own Matrix name
// (runner/bus.ts). The job waits on an `a2a_task` wait keyed by its bus thread (<schema>.bus_threads, t015); the other
// app's `done` / `answer` readies it with the result as untrusted data; its `ask` wakes it with a question this job
// answers with a2a.answer (or asks its person first, then relays). The chain of apps travels in the task body
// (lineage, depth ≤ 3): refused here early, and by the callee. On the client road there is no bus: refused `no_bus`.
//
// The wait is always written BEFORE anything is sent (item 5): an answer that comes back faster than this call
// returns finds the wait (and the thread row) already there.

import { randomUUID } from 'node:crypto';
import type { JobTokenClaims } from '@neop/contracts';
import type { JobRow, WaitRow } from '../data/book.ts';
import { prepareAnswerIntent, type AnswerThread } from '../data/answer-intents.ts';
import { SessionLost, type Gate, type GateResult } from './gate.ts';

/** a2a chains stop at this depth (the callee's rule on the bus, checked here first). */
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

/** Open a task at another app and make this job wait on it (a2a.request, and borrowed lines). */
export async function handOff(gate: Gate, claims: JobTokenClaims, job: JobRow, toolKey: string, req: HandOff): Promise<GateResult> {
  return busHandOff(gate, claims, job, toolKey, req);
}

// ── borrowed lines ──────────────────────────────────────────────────────────
/**
 * A borrowed ability (v3 §10). Nothing runs here: a read or a write is one typed ask carrying {ability, args} in the bus
 * room; the job waits for the owner's typed answer (a read at once, with no model there; a write after the owner's
 * person approved it and the owner's runner carried it out). A write is never run here — the owner proposes it.
 */
export async function borrow(gate: Gate, claims: JobTokenClaims, job: JobRow, key: string, args: unknown): Promise<GateResult> {
  const core = gate.core;
  const board = await core.board.get(claims.company_id);
  const b = (await core.borrowed.list(claims.company_id, board)).find((x) => x.key === key);
  if (!b || b.setting === 'off') return gate.refuse(claims, key, 'switched_off', `${key} is not available to borrow here`);
  const v = core.borrowed.validators(b);
  // The card (if the model added one) is the owner's to write; only the inputs travel.
  const { card: _card, ...inputs } = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : ({} as Record<string, unknown>);
  if (!v.input(inputs)) return gate.refuse(claims, key, 'invalid_args', core.borrowed.errors(v.input));
  return handOff(gate, claims, job, key, { target: b.owner, ask: `${b.ability.title} (${key})`, ability: key, args: inputs });
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

// ── the bus road ──────────────────────────────────────────────────────────
/** The chain this job is part of: the lineage of the bus task that opened it (none for a person's own ask). */
async function lineageOf(gate: Gate, claims: JobTokenClaims): Promise<string[]> {
  const core = gate.core;
  const r = await core.company(claims.company_id, (c) =>
    c.query<{ lineage: string[] }>(`select lineage from ${sqlIdent(core.key)}.bus_threads where direction = 'in' and kind = 'task' and job_id = $1 order by created_at limit 1`, [claims.sub]),
  );
  return Array.isArray(r.rows[0]?.lineage) ? r.rows[0]!.lineage : [];
}

async function busHandOff(gate: Gate, claims: JobTokenClaims, job: JobRow, toolKey: string, req: HandOff): Promise<GateResult> {
  const core = gate.core;
  const bus = core.bus;
  if (!bus) return gate.refuse(claims, toolKey, 'no_bus', 'this backend has no voice in the bus room (it runs on the client road, or its bus road is not running); nothing was sent');
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
    await core.book.getJob(c, claims.sub, true);
    const w = await core.book.insertWait(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'a2a_task', ref_id: taskId, expires_at_sql: A2A_WAIT });
    await c.query(
      `insert into ${sqlIdent(core.key)}.bus_threads (id, company_id, direction, kind, room_id, peer, peer_app, job_id, wait_id, task_id, ability, args, lineage, depth, status, answer_protocol)
       values ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $13, $9, $10, $11, $12, 'sending', 1)`,
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
      await core.book.getJob(c, claims.sub, true);
      await c.query(`update ${sqlIdent(core.key)}.bus_threads set status = 'not_opened', updated_at = now() where id = $1`, [taskId]);
      await c.query(`update ${sqlIdent(core.key)}.waits set status = 'consumed', ready_at = now(), outcome = 'NOT_OPENED' where id = $1 and status = 'pending'`, [wait.id]);
    });
    return gate.refuse(claims, toolKey, e?.code ?? 'a2a_unreachable', `the task could not be sent in the bus room; nothing was asked of ${req.target}`, {
      detail: String(e?.message ?? e).slice(0, 300),
      detail_source: 'matrix',
    });
  }
  await core.company(claims.company_id, async (c) => {
    await core.book.getJob(c, claims.sub, true);
    await c.query(`update ${sqlIdent(core.key)}.bus_threads set root_event_id = $2, status = case when status = 'sending' then 'open' else status end, updated_at = now() where id = $1`, [taskId, root]);
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
  if (!core.bus) return gate.refuse(claims, 'a2a.answer', 'not_available', 'a2a.answer is for questions asked in the bus room; this app is not on it');
  if (typeof args?.task_id !== 'string' || typeof args.question_wait_id !== 'string'
    || args.question_wait_id.length < 1 || args.question_wait_id.length > 200
    || !args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)) {
    return gate.refuse(claims, 'a2a.answer', 'invalid_args', 'task_id, question_wait_id (the exact peer wait ID, 1–200 characters) and answers (an object: field key → value) are required');
  }
  // Capture the caller's intended question before awaiting anything. Never replace a missing/stale ID
  // with the current thread question: the answer may have been prepared for a different question.
  const taskId: string = args.task_id, expectedPeerWait: string = args.question_wait_id;
  const answers: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args.answers as Record<string, unknown>)) {
    if (!ANSWER_KEY.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)) || (typeof v === 'string' && v.length > 4000)) {
      return gate.refuse(claims, 'a2a.answer', 'invalid_args', `answers.${k} must be a short text, a number or true/false under a lower_snake_case key`);
    }
    answers[k] = v as string | number | boolean;
  }
  if (!Object.keys(answers).length || Object.keys(answers).length > 10) return gate.refuse(claims, 'a2a.answer', 'invalid_args', 'give 1 to 10 answers');
  // Pin the sending Matrix name, not credentials. The bus rechecks it immediately before sending.
  const account = await core.bus.answerAccount(claims.company_id);
  const requireOwner = async (c: PoolClient) => {
    const live = await core.book.getJob(c, claims.sub, true);
    if (!live || live.company_id !== claims.company_id || live.status !== 'RUNNING' || live.claimed_by !== claims.sid) {
      throw new SessionLost('this session no longer holds the job');
    }
  };
  // Prepare under the same job -> thread order as receipt/cancellation. The network send is outside locks.
  const prepared = await core.company(claims.company_id, async c => {
    await requireOwner(c);
    const row = (await c.query<AnswerThread>(
      `select id, peer, peer_app, room_id, root_event_id, question, status, answer_protocol from ${sqlIdent(core.key)}.bus_threads
       where id::text=$1 and company_id=$2 and direction='out' and kind='task' and job_id=$3 for update`,
      [taskId, claims.company_id, claims.sub])).rows[0];
    if (!row || row.status !== 'open' || !row.root_event_id) return { ok: false as const,
      code: 'unknown_task', reason: `no open task ${taskId} of this job is waiting on an answer` };
    if (!row.question?.wait_id) return { ok: false as const,
      code: 'no_question', reason: `${row.peer_app} has not asked anything about task ${row.id.slice(0, 8)}` };
    if (row.question.wait_id !== expectedPeerWait) return { ok: false as const,
      code: 'stale_question', reason: 'the peer question changed; this call sent no answer. Read the latest question and prepare an answer for its exact question_wait_id. Do not relabel an old answer as a reply to a new question.' };
    // Only waits this session actually claimed can be reported by this answer. A newer wake is still owed,
    // including one delivered before this preparation transaction or while the send is in flight.
    const ready = await c.query<{ id: string }>(`select id from ${sqlIdent(core.key)}.waits
      where company_id=$1 and job_id=$2 and status='ready' and claimed_by=$3`, [claims.company_id, claims.sub, claims.sid]);
    const intent = await prepareAnswerIntent(core, c, claims.company_id, claims.sub, row, expectedPeerWait, answers, account);
    if (!intent.ok) return intent;
    return { ...intent, row, readyIds: ready.rows.map(w => w.id) };
  });
  if (!prepared.ok) return gate.refuse(claims, 'a2a.answer', prepared.code, prepared.reason);
  const { row, wait, intent, readyIds } = prepared;
  const peerWait = String(row.question.wait_id);
  try {
    await core.bus.answer(claims.company_id, { room: intent.room_id, peer: intent.peer, root: intent.root_event_id },
      { key: `bus:answer:${row.id}:${peerWait}`, wait_id: peerWait, answers: intent.answers, account: intent.account });
  } catch (e: any) {
    await core.company(claims.company_id, async c => {
      await requireOwner(c);
      // A send error cannot prove non-delivery. Preserve the same wait for a late result or exact retry.
      await core.book.addStep(c, { company_id: claims.company_id, job_id: claims.sub, kind: 'system',
        summary: `Answer delivery unconfirmed for task ${row.id.slice(0, 8)}; original intent and return wait retained.`,
        output_ref: { answer_intent_id: intent.id, wait_id: wait.id, outcome: 'SEND_UNCONFIRMED' } });
    });
    return gate.refuse(claims, 'a2a.answer', 'a2a_unreachable', `could not confirm delivery of the answer to ${row.peer_app}; it may have received it. Do not assume non-delivery or send a different answer as a retry.`, { detail: String(e?.message ?? e).slice(0, 300), detail_source: 'matrix' });
  }
  await core.company(claims.company_id, async (c) => {
    await requireOwner(c);
    // A next question or terminal result may have arrived during the send. Never clear that newer question.
    await c.query(`update ${sqlIdent(core.key)}.bus_threads
      set question=case when question->>'wait_id'=$3 then null else question end,wait_id=$2,updated_at=now()
      where id=$1 and company_id=$4 and job_id=$5 and direction='out' and kind='task'`,
      [row.id, wait.id, peerWait, claims.company_id, claims.sub]);
    const consumed = (await c.query<WaitRow>(`update ${sqlIdent(core.key)}.waits set status='consumed'
      where company_id=$1 and job_id=$2 and id=any($3::uuid[]) and status='ready' and claimed_by=$4 returning *`,
      [claims.company_id, claims.sub, readyIds, claims.sid])).rows;
    await core.book.markReported(c, claims.company_id, consumed, `assistant:${claims.sub}`, { answered_task: row.id });
    await core.book.setJobStatus(c, claims.sub, 'WAITING');
    await core.book.addStep(c, {
      company_id: claims.company_id,
      job_id: claims.sub,
      kind: 'system',
      summary: `Answered ${row.peer_app}'s question about task ${row.id.slice(0, 8)} (${Object.keys(answers).join(', ')}); waiting for its result.`,
      output_ref: { task_id: row.id, question_wait_id: peerWait, wait_id: wait.id, answer_intent_id: intent.id },
    });
  });
  return { status: 'waiting_on_app', app: row.peer_app, task_id: row.id };
}
