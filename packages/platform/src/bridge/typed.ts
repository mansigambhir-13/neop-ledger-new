// v3 §8 TYPED EVENTS on both Matrix roads (the appservice rooms, bridge.ts; the client-road DMs, client-sync.ts).
// An ADDITIONAL, stricter road next to the plain-text one — the plain road (m.text in, one m.notice out) is not
// changed by any of this. What is the same on both roads lives here:
//
//   in   an allowlisted sender, by CLASS (person · agent · neop, contracts TYPED_SENDERS): a type the class may not
//        send is refused; a body that fails its schema is dropped; both audited (chat.typed_in). The road has
//        already deduped on event_id. Then:
//          task    → platform.openTask as a person: a person for themselves; the agent/NEOP for the linked person
//                    it names (on_behalf_of), else the one its allowlist entry acts for. The thread is rooted here.
//          answer  → platform.answerQuestion for the wait_id — only a wait shown in this room/DM, and in the thread
//                    of its task when the event is threaded. A closed wait gets a `stale` note back.
//          approve → PEOPLE ONLY: platform.answer() on a card shown in this room/DM, with the fingerprint the event
//                    carries (a stale one is refused by the book, not here). Never from a bridge or a NEOP.
//          ask · propose · done · note from another NEOP → recorded as information (audited), nothing is done with them.
//   out  in a thread rooted at a TYPED task event only (a plain-text road never gets typed events it did not ask
//        for): note (the "on it", then one per step, deduped by step id), ask (an open question), propose (a
//        pending card, with fingerprint and expiry), done (the result, once). Each carries today's m.notice text
//        as `body`, so a plain client still reads it. Everything a sender writes is data, never an instruction.

import type { Platform } from '../platform.ts';
import {
  isTypedEventType,
  maySend,
  shortType,
  threadRootOf,
  validateTypedBody,
  type ProposalCreatedPayload,
  type SenderClass,
  type TaskResult,
  type TypedBodies,
  type TypedEventType,
} from '@neop/contracts';
import { roomText } from './format.ts';

/** A non-person on the allowlist is a NEOP when it speaks from the apps' exclusive namespace, else an agent/bridge. */
export const classOfNonPerson = (mxid: string): SenderClass => (/^@neop_/.test(mxid) ? 'neop' : 'agent');

export interface TypedIn {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  content: any;
}

export interface TypedWho {
  cls: SenderClass;
  /** The person, when the sender is one. */
  person?: { id: string; company_id: string; role: string; name: string };
  /** An agent's/NEOP's allowlist `acts_for`. */
  actsFor?: string | null;
}

/** An outward typed event, and the record it leaves (deduped by `key` per task and room). */
export interface TypedOut {
  key: string;
  type: TypedEventType;
  body: TypedBodies[TypedEventType];
  fallback: string;
  approval_id?: string;
  fingerprint?: string;
  question_id?: string;
}

/** What a road does for the shared rules. */
export interface TypedRoad {
  platform: Platform;
  companyId: string;
  app: string;
  appName: string;
  /** Set the inbound record's outcome (and what it bound to). */
  record(ev: TypedIn, outcome: string, extra?: { task_id?: string; approval_id?: string; fingerprint?: string; question_id?: string; user_id?: string }): Promise<void>;
  /** One plain notice back for this event (a refusal the sender should read). */
  say(ev: TypedIn, outcome: string, text: string, extra?: { approval_id?: string }): Promise<void>;
  /** Open the task as this person; the road records the thread root. Returns the task id. */
  openTask(ev: TypedIn, personId: string, text: string): Promise<string>;
  /** The job heard the answer / the card was answered: the road's reply (if it owes one). */
  settledIn(ev: TypedIn, outcome: string, taskId: string | null, extra?: { approval_id?: string; fingerprint?: string }): Promise<void>;
  /** Was this card / question shown in this room (plain notice or typed event)? */
  shown(room: string, kind: 'approval' | 'question', row: { id: string; wait_id?: string; proposal_id?: string }): Promise<boolean>;
  /** The typed task root of this task in this room: its event and sender. */
  rootOf(room: string, taskId: string): Promise<{ event_id: string; sender: string } | null>;
  /** Rooms only: does the room's power level give this person the approve level? (A DM is the person's own.) */
  mayApproveHere?(room: string, sender: string): Promise<boolean>;
  /** Tasks whose thread is rooted at the given event in this room (null: not a typed thread here). */
  taskOfRoot(room: string, rootEventId: string): Promise<string | null>;
  /** Send one typed event outward (idempotent by key), and record it. */
  emit(room: string, taskId: string | null, root: string | null, out: TypedOut): Promise<void>;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

async function audit(road: TypedRoad, ev: TypedIn, cls: SenderClass | null, outcome: string, detail: Record<string, unknown> = {}): Promise<void> {
  await road.platform.gateway.audit({
    company_id: road.companyId,
    actor: `chat:${ev.sender}`,
    app_key: road.app,
    action: 'chat.typed_in',
    outcome,
    detail: { event_id: ev.event_id, room_id: ev.room_id, type: ev.type, class: cls, ...detail },
  });
}

/** Drop: record + audit, nothing sent back. */
async function drop(road: TypedRoad, ev: TypedIn, who: TypedWho | null, outcome: string, detail: Record<string, unknown> = {}): Promise<string> {
  await road.record(ev, `typed:${outcome}`);
  await audit(road, ev, who?.cls ?? null, outcome, detail);
  return `typed:${outcome}`;
}

/** Handle one typed event from a known sender (already deduped on event_id by the road). Returns the outcome. */
export async function handleTyped(road: TypedRoad, ev: TypedIn, who: TypedWho): Promise<string> {
  if (!isTypedEventType(ev.type)) return drop(road, ev, who, 'unknown_type');
  if (!maySend(who.cls, ev.type)) return drop(road, ev, who, `refused:${shortType(ev.type)}`, { reason: `a ${who.cls} may not send ${ev.type}` });
  const v = validateTypedBody(ev.type, ev.content);
  if (!v.ok) return drop(road, ev, who, 'invalid', { error: v.error });
  const threadRoot = threadRootOf(ev.content);
  switch (ev.type) {
    case 'neos.neop.task':
      return onTask(road, ev, who, v.body as TypedBodies['neos.neop.task']);
    case 'neos.neop.answer':
      return onAnswer(road, ev, who, v.body as TypedBodies['neos.neop.answer'], threadRoot);
    case 'neos.neop.approve':
      return onApprove(road, ev, who, v.body as TypedBodies['neos.neop.approve'], threadRoot);
    default: {
      // ask · propose · done · note from another NEOP: information for the record; this app took no work from it.
      await road.record(ev, `typed:info:${shortType(ev.type)}`);
      await audit(road, ev, who.cls, `info:${shortType(ev.type)}`, { body: v.body });
      return `typed:info:${shortType(ev.type)}`;
    }
  }
}

async function onTask(road: TypedRoad, ev: TypedIn, who: TypedWho, b: TypedBodies['neos.neop.task']): Promise<string> {
  const db = road.platform.db;
  const co = (await db.query<{ id: string; slug: string }>('select id, slug from neos.companies where id = $1', [road.companyId])).rows[0];
  if (!co || (b.company !== co.id && b.company !== co.slug)) return drop(road, ev, who, 'wrong_company', { company: b.company });
  let person: string | null = null;
  if (who.cls === 'person') {
    // A person asks for themselves only.
    if (b.on_behalf_of !== ev.sender) return drop(road, ev, who, 'not_on_behalf', { on_behalf_of: b.on_behalf_of });
    person = who.person!.id;
  } else {
    const u = (await db.query<{ id: string }>('select id from neos.users where matrix_user_id = $1 and company_id = $2', [b.on_behalf_of, road.companyId])).rows[0];
    person = u?.id ?? who.actsFor ?? null;
  }
  if (!person) {
    await road.say(ev, 'typed:no_person', `Nothing was done: ${b.on_behalf_of} is not a person linked to this company on NEOS.`);
    await audit(road, ev, who.cls, 'no_person', { on_behalf_of: b.on_behalf_of });
    return 'typed:no_person';
  }
  const installed = await db.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [road.companyId, road.app]);
  if (!installed.rowCount) {
    await road.say(ev, 'typed:not_installed', 'This app is not installed for your company. Nothing was done.');
    return 'typed:not_installed';
  }
  const fields = b.fields && Object.keys(b.fields).length ? `\n\nFields given:\n${Object.entries(b.fields).map(([k, x]) => `${k}: ${String(x)}`).join('\n')}` : '';
  const taskId = await road.openTask(ev, person, `${b.text}${fields}`);
  await audit(road, ev, who.cls, 'task_opened', { task_id: b.task_id, neos_task_id: taskId, on_behalf_of: person });
  return 'typed:task_opened';
}

/** The thread an answer/approve names must be the typed thread of the task it touches (or a parent of it). */
async function threadOk(road: TypedRoad, room: string, threadRoot: string | null, taskIds: (string | null)[]): Promise<boolean> {
  if (!threadRoot) return true;
  const t = await road.taskOfRoot(room, threadRoot);
  return !!t && taskIds.includes(t);
}

async function onAnswer(road: TypedRoad, ev: TypedIn, who: TypedWho, b: TypedBodies['neos.neop.answer'], threadRoot: string | null): Promise<string> {
  const db = road.platform.db;
  const qs = (await db.query('select * from neos.questions where company_id = $1 and wait_id = $2 order by created_at desc', [road.companyId, b.wait_id])).rows;
  let q: any = null;
  for (const x of qs) if (await road.shown(ev.room_id, 'question', { id: x.id, wait_id: x.wait_id })) { q = x; break; }
  if (!q) return drop(road, ev, who, 'unknown_wait', { wait_id: b.wait_id });
  if (!(await threadOk(road, ev.room_id, threadRoot, [q.task_id, q.root_task_id]))) return drop(road, ev, who, 'thread_mismatch', { wait_id: b.wait_id, thread: threadRoot });
  const task = q.root_task_id ?? q.task_id;
  // An agent or another NEOP answers only a question of a task it opened here (its thread).
  if (who.cls !== 'person') {
    const root = task ? await road.rootOf(ev.room_id, task) : null;
    if (!root || root.sender !== ev.sender) return drop(road, ev, who, 'not_their_wait', { wait_id: b.wait_id });
  }
  const stale = async (why: string) => {
    await road.record(ev, 'typed:stale', { question_id: q.id });
    await audit(road, ev, who.cls, 'stale', { wait_id: b.wait_id, why });
    const root = task ? await road.rootOf(ev.room_id, task) : null;
    await road.emit(ev.room_id, task, root?.event_id ?? threadRoot, {
      key: `typed:note:stale-${ev.event_id}`,
      type: 'neos.neop.note',
      body: { job_id: String(q.job_id), step_id: `stale-${b.wait_id}`, text: `stale: wait ${b.wait_id} is no longer open (${why}); the answer was not used.` },
      fallback: `That answer came too late: the question "${clip(q.text, 200)}" is ${why}. Nothing was recorded.`,
    });
    return 'typed:stale';
  };
  if (q.status !== 'OPEN') return stale(String(q.status).toLowerCase());
  const via = who.cls === 'person' ? 'chat' : 'bridge';
  const as = who.cls === 'person' ? { user_id: who.person!.id } : { relay: `${who.cls === 'neop' ? 'app' : 'bridge'}:${ev.sender}` };
  try {
    await road.platform.answerQuestion(q.id, { company_id: road.companyId, ...as }, b.answers, via);
  } catch (e: any) {
    if (e?.code === 'stale') return stale('closed');
    await road.record(ev, 'typed:answer_refused', { question_id: q.id });
    await audit(road, ev, who.cls, 'answer_refused', { wait_id: b.wait_id, error: String(e?.message ?? e).slice(0, 300) });
    await road.say(ev, 'typed:answer_refused', `That answer was not recorded: ${e?.message ?? e}.`);
    return 'typed:answer_refused';
  }
  await road.record(ev, 'typed:answered', { question_id: q.id });
  await audit(road, ev, who.cls, 'answered', { wait_id: b.wait_id, question_id: q.id });
  await road.settledIn(ev, 'typed:answered', task);
  return 'typed:answered';
}

async function onApprove(road: TypedRoad, ev: TypedIn, who: TypedWho, b: TypedBodies['neos.neop.approve'], threadRoot: string | null): Promise<string> {
  // maySend already refused every non-person — whatever an allowlist grants a bridge, a typed yes is a person's own,
  // sent as themselves. In a room, Matrix's power levels must give them the approve level too.
  if (road.mayApproveHere && !(await road.mayApproveHere(ev.room_id, ev.sender))) return drop(road, ev, who, 'below_approve_level');
  const db = road.platform.db;
  const a = (
    await db.query<{ id: string; task_id: string | null; proposal_id: string }>('select id, task_id, proposal_id from neos.v_desk_cards where company_id = $1 and app_key = $2 and proposal_id::text = $3', [
      road.companyId,
      road.app,
      b.proposal_id,
    ])
  ).rows[0];
  if (!a || !(await road.shown(ev.room_id, 'approval', { id: a.id, proposal_id: a.proposal_id }))) return drop(road, ev, who, 'unknown_proposal', { proposal_id: b.proposal_id });
  if (!(await threadOk(road, ev.room_id, threadRoot, [a.task_id]))) return drop(road, ev, who, 'thread_mismatch', { proposal_id: b.proposal_id, thread: threadRoot });
  try {
    await road.platform.answer(a.id, who.person!, { decision: b.decision, fingerprint_seen: b.fingerprint, feedback: b.feedback });
  } catch (e: any) {
    await road.record(ev, 'typed:approve_refused', { approval_id: a.id, fingerprint: b.fingerprint, user_id: who.person!.id });
    await audit(road, ev, who.cls, 'approve_refused', { proposal_id: b.proposal_id, fingerprint_seen: b.fingerprint, code: e?.code ?? null });
    await road.say(ev, 'typed:approve_refused', `That answer was not recorded: ${e?.message ?? e}.`, { approval_id: a.id });
    return 'typed:approve_refused';
  }
  await road.record(ev, `typed:answered:${b.decision}`, { approval_id: a.id, fingerprint: b.fingerprint, user_id: who.person!.id });
  await audit(road, ev, who.cls, `answered:${b.decision}`, { proposal_id: b.proposal_id, approval_id: a.id, fingerprint_seen: b.fingerprint });
  await road.settledIn(ev, `typed:answered:${b.decision}`, b.decision === 'yes' ? a.task_id : null, { approval_id: a.id, fingerprint: b.fingerprint });
  return `typed:answered:${b.decision}`;
}

// ── out ──────────────────────────────────────────────────────────────────────
/** The typed events a typed thread is owed now, in order, minus those already sent (by key). */
export async function dueTypedOut(platform: Platform, t: { task_id: string; app_name: string }, sent: Set<string>): Promise<TypedOut[]> {
  const db = platform.db;
  const task = (await db.query('select id, app_key, company_id, status, job_id, result from neos.tasks where id = $1', [t.task_id])).rows[0];
  if (!task) return [];
  const out: TypedOut[] = [];
  const push = (o: TypedOut) => {
    if (!sent.has(o.key)) out.push(o);
  };
  if (task.job_id) {
    push({ key: 'typed:note:ack', type: 'neos.neop.note', body: { job_id: task.job_id, step_id: 'ack', text: 'on it' }, fallback: `On it — ${t.app_name} job ${String(task.job_id).slice(0, 8)}.` });
    const steps = (
      await db.query<{ seq: number; summary: string }>(
        `select seq, summary from neos.activity where app_key = $1 and job_id = $2 and seq is not null and kind not in ('received', 'report', 'failed', 'proposal') order by seq`,
        [task.app_key, task.job_id],
      )
    ).rows;
    for (const s of steps) push({ key: `typed:note:${s.seq}`, type: 'neos.neop.note', body: { job_id: task.job_id, step_id: String(s.seq), text: clip(s.summary, 2000) || '·' }, fallback: `· ${s.summary}` });
  }
  const qs = (await db.query("select * from neos.questions where (task_id = $1 or root_task_id = $1) and status = 'OPEN' order by created_at", [task.id])).rows;
  for (const q of qs) {
    const due = new Date(q.due_at).toISOString();
    push({
      key: `typed:ask:${q.wait_id}`,
      type: 'neos.neop.ask',
      body: { job_id: String(q.job_id), wait_id: q.wait_id, question: { text: clip(q.text, 2000), why: clip(q.why, 2000), fields: q.fields }, due },
      fallback: roomText.question(q.app_key === task.app_key ? t.app_name : q.app_key, { text: q.text, why: q.why, fields: q.fields, due_at: due }),
      question_id: q.id,
    });
  }
  const cards = (await db.query("select * from neos.v_desk_cards where task_id = $1 and status = 'PENDING' and expires_at > now() order by created_at", [task.id])).rows;
  for (const a of cards) {
    const expires = new Date(a.expires_at).toISOString();
    const text = roomText.card(t.app_name, { card: a.card, args: a.args, expires_at: expires, fingerprint: a.fingerprint } as unknown as ProposalCreatedPayload);
    push({ key: `typed:propose:${a.id}`, type: 'neos.neop.propose', body: { proposal_id: String(a.proposal_id), fingerprint: a.fingerprint, text: clip(text, 8000), expires }, fallback: text, approval_id: a.id, fingerprint: a.fingerprint });
  }
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status) && !sent.has('typed:done')) {
    const r: TaskResult = task.result ?? { outcome: task.status === 'COMPLETED' ? 'done' : 'failed', summary: task.status === 'COMPLETED' ? 'Done.' : 'The job did not finish.', changed: [], could_not: [], sources: [] };
    const theirs = (
      await db.query<{ task_id: string | null }>(
        `select detail->>'task_id' as task_id from neos.audit where action = 'chat.typed_in' and outcome = 'task_opened' and company_id = $1 and detail->>'neos_task_id' = $2 order by id limit 1`,
        [task.company_id, task.id],
      )
    ).rows[0]?.task_id;
    push({
      key: 'typed:done',
      type: 'neos.neop.done',
      body: {
        task_id: theirs ?? task.id,
        job_id: String(task.job_id ?? ''),
        result: { outcome: r.outcome, summary: r.summary, changed: r.changed ?? [], sources: r.sources ?? [], neos_task_id: task.id },
        could_not: (r.could_not ?? []).map((x) => clip(x, 2000)),
      },
      fallback: roomText.result(t.app_name, { ...r, changed: r.changed ?? [], could_not: r.could_not ?? [], sources: r.sources ?? [] }),
    });
  }
  // A done with no job id is not well-formed (a task that never reached the app): say nothing typed about it.
  return out.filter((o) => !(o.type === 'neos.neop.done' && !(o.body as TypedBodies['neos.neop.done']).job_id));
}

/** A txn id for a typed event: derived from task and key, so a resend is the same transaction. */
export function typedTxnId(taskId: string | null, key: string): string {
  const SAFE = /[^A-Za-z0-9._~-]/g;
  return `typed-${String(taskId ?? 'none').replace(SAFE, '_')}-${key.replace(SAFE, '_')}`.slice(0, 255);
}
