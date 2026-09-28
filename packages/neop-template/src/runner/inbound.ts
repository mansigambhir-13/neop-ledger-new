// THE RUNNER'S EAR · events pushed by the appservice or pulled by /sync (v3 §3 step 2, §8, §13 `inbound.ts`;
// V3 migration stage S4). Template-only. What arrives is data until it has become something in the book:
//
//   who        the sender's class — person · agent · neop — from this app's own schema (presence/identity.ts:
//              installs.agent_senders, the linked people); a stranger is ignored.
//   typed      maySend(class, type) (contracts TYPED_SENDERS) and the body's schema; a type the class may not send,
//              or a body that fails, is dropped and recorded (inbound_events.outcome/detail), nothing sent back.
//              task    → a job in this app's schema (openJob → openJobAtomic, origin = the event id); the thread is
//                        rooted at the task event; "on it" is the mirror's (runner/mirror.ts), never a model's.
//              answer  → the wait (waits.answer's book write, with the person/agent/app prefix rules: a person's words
//                        are theirs, anything relayed is untrusted data); a closed wait → a `stale` note back.
//              approve → PEOPLE ONLY, sending as themselves, for a card shown to them here: <schema>.answer_proposal()
//                        with p_by 'user:<person>' and the fingerprint the event carries (a stale one is refused by
//                        the book and the card stays open). The company's approver policy (roles, four-eyes) first.
//              ask · propose · done · note from another NEOP → recorded as information; no work is taken from it.
//   plain      m.text keeps NeuralChat #143's meaning exactly (ported from the platform's client road): a message is
//              a task; a reply to a question (or a plain next message while the DM is AT the question) answers it;
//              a person's reply to a card shown in their own DM is their decision; a bridge's clear decline binds
//              (caution may be added, never removed); a bridge's go-ahead is NEVER a yes — one reply re-shows the
//              card and says "approve on your desk".
//   reply      on the client road, exactly one m.notice per plain message (m.in_reply_to, txnId reply-<event_id>)
//              when the job settles, as the book says it did — or the fixed sentence past MATRIX_REPLY_DEADLINE_MS.
// Every event is recorded once by event_id (presence/events.ts claimInbound): Matrix redelivers, and a redelivery
// neither opens a second job nor sends a second reply.

import { answersFromText, readTaskFields, type Question, type TaskResult } from '@neop/contracts';
import { ExecError } from '../capabilities/execute.ts';
import { openJob } from '../capabilities/platform/tasks.open.ts';
import { answerWait } from '../capabilities/platform/waits.answer.ts';
import type { Core } from '../core.ts';
import { bridgeCardText, clip, FIXED_FAILURE, roomText, waitingCardText } from '../presence/cards.ts';
import { isTypedEventType, keyTxnId, maySend, replyTxnId, shortType, taskIdForEvent, threadRelation, threadRootOf, typedContent, validateTypedBody, type TypedBodies, type TypedEventType } from '../presence/events.ts';
import type { Identity, Person, Who } from '../presence/identity.ts';
import { fetchTaskFiles } from '../presence/files.ts';
import type { DocumentUpload } from '../doors/documents/index.ts';
import type { Bus } from './bus.ts';
import { DECLINE, isConsent, parseDecision, PLAIN_DECLINE, plainAnswers, POSTPONE } from '../presence/lexicon.ts';

/** One voice of this app in Matrix: the appservice name at a company, or one ordinary account (client road). */
export interface Road {
  readonly kind: 'client' | 'appservice';
  /** Our own Matrix name on this road. */
  readonly account: string;
  readonly companyId: string;
  /** Post an m.room.message; the txn id makes a resend the same event. */
  send(room: string, content: Record<string, unknown>, txnId: string): Promise<string>;
  /** Post a typed (custom) event, e.g. neos.neop.propose. */
  sendEvent(room: string, type: string, content: Record<string, unknown>, txnId: string): Promise<string>;
  /** Rooms only: do Matrix's power levels give this sender the approve level? (A DM is the person's own.) */
  mayApproveHere?(room: string, sender: string): Promise<boolean>;
}

export interface TypedIn {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  content: any;
}

type Card = { proposal_id: string; fingerprint: string };
type Relay = { user_id?: string; relay?: string };
type Extra = { job_id?: string | null; proposal_id?: string | null; wait_id?: string | null; fingerprint?: string | null; person_id?: string | null; typed_task_id?: string | null; detail?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_MISMATCH = 'what you approved is not what is on the card now; look at it again and answer that';

export class Inbound {
  readonly core: Core;
  readonly identity: Identity;
  replyDeadlineMs: number;
  /** v3 S6: the bus room's handler (NEOP to NEOP); set by Presence on the appservice road. */
  bus: Bus | null = null;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(core: Core, identity: Identity, o: { replyDeadlineMs: number; log?: (msg: string, extra?: Record<string, unknown>) => void }) {
    this.core = core;
    this.identity = identity;
    this.replyDeadlineMs = o.replyDeadlineMs;
    this.log = o.log ?? ((m, e) => core.log(`presence: ${m}`, e));
  }

  private get s(): string {
    return this.core.key;
  }
  private get db() {
    return this.core.runnerPool;
  }
  private get appName(): string {
    return this.core.manifest.name;
  }

  // ── records ─────────────────────────────────────────────────────────────────
  /** Set what an inbound event became (and what it bound to). */
  async setIn(eventId: string, outcome: string | null, x: Extra = {}): Promise<void> {
    await this.db.query(
      `update ${this.s}.inbound_events set outcome = coalesce($2, outcome), job_id = coalesce($3, job_id), proposal_id = coalesce($4, proposal_id),
              wait_id = coalesce($5, wait_id), fingerprint_shown = coalesce($6, fingerprint_shown), person_id = coalesce($7, person_id),
              typed_task_id = coalesce($8, typed_task_id), detail = coalesce($9::jsonb, detail)
        where event_id = $1`,
      [eventId, outcome, x.job_id ?? null, x.proposal_id ?? null, x.wait_id ?? null, x.fingerprint ?? null, x.person_id ?? null, x.typed_task_id ?? null, x.detail === undefined ? null : JSON.stringify(x.detail)],
    );
  }

  /** Record what this app said where (the key is the transaction id: nothing is said twice). */
  async recordOut(road: Road, room: string, key: string, kind: string, eventId: string | null, x: Extra = {}): Promise<void> {
    await this.db.query(
      `insert into ${this.s}.outbound_events (company_id, account, room_id, key, event_id, kind, job_id, proposal_id, wait_id, fingerprint_shown)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (account, room_id, key) do nothing`,
      [road.companyId, road.account, room, key, eventId, kind, x.job_id ?? null, x.proposal_id ?? null, x.wait_id ?? null, x.fingerprint ?? null],
    );
  }

  async said(road: Road, room: string, key: string): Promise<boolean> {
    return !!(await this.db.query(`select 1 from ${this.s}.outbound_events where account = $1 and room_id = $2 and key = $3`, [road.account, room, key])).rowCount;
  }

  /** One m.notice, once per key (txn id = the key). */
  async notice(road: Road, room: string, key: string, body: string, kind = 'notice', x: Extra = {}, relates?: Record<string, unknown>): Promise<boolean> {
    if (await this.said(road, room, key)) return false;
    const sent = await road.send(room, { msgtype: 'm.notice', body: clip(body), ...(relates ? { 'm.relates_to': relates } : {}) }, keyTxnId(key));
    await this.recordOut(road, room, key, kind, sent, x);
    return true;
  }

  /** One typed event, once per key, in the thread rooted at `root`, with today's m.notice text as its body. */
  async typed<T extends TypedEventType>(road: Road, room: string, key: string, type: T, body: TypedBodies[T], fallback: string, root: string | null, x: Extra = {}): Promise<boolean> {
    if (await this.said(road, room, key)) return false;
    const sent = await road.sendEvent(room, type, typedContent(type, body, clip(fallback), root), keyTxnId(key));
    await this.recordOut(road, room, key, `typed:${shortType(type)}`, sent, x);
    return true;
  }

  // ── the client road's one reply ─────────────────────────────────────────────
  /** The reply to this event is owed when its job settles (or the deadline passes). */
  async owe(eventId: string, outcome: string, jobId: string, x: { proposal_id?: string; fingerprint?: string } = {}): Promise<void> {
    await this.db.query(
      `update ${this.s}.inbound_events set outcome = $2, job_id = $3, proposal_id = coalesce($4, proposal_id), fingerprint_shown = coalesce($5, fingerprint_shown),
              reply_status = 'waiting', reply_due_at = now() + ($6 || ' milliseconds')::interval where event_id = $1 and reply_status = 'none'`,
      [eventId, outcome, jobId, x.proposal_id ?? null, x.fingerprint ?? null, String(this.replyDeadlineMs)],
    );
  }

  /** The one reply, now (client road); on the appservice road a notice in the room. */
  async replyNow(road: Road, eventId: string, room: string, outcome: string, text: string, x: { proposal_id?: string; fingerprint?: string; card?: Card } = {}): Promise<void> {
    if (road.kind === 'appservice') {
      await this.setIn(eventId, outcome, { proposal_id: x.proposal_id, fingerprint: x.fingerprint });
      await this.notice(road, room, `said:${eventId}`, text, x.card ? 'card' : 'notice', x.card ? { proposal_id: x.card.proposal_id, fingerprint: x.card.fingerprint } : {});
      return;
    }
    const claimed = await this.db.query(
      `update ${this.s}.inbound_events set outcome = $2, proposal_id = coalesce($3, proposal_id), fingerprint_shown = coalesce($4, fingerprint_shown),
              reply_status = 'sending', reply_text = $5 where event_id = $1 and reply_status = 'none'`,
      [eventId, outcome, x.proposal_id ?? null, x.fingerprint ?? null, clip(text)],
    );
    if (claimed.rowCount) await this.deliver(road, eventId, room, clip(text), x.card ?? null);
  }

  /** The thread root for the reply to this event, when it belongs to a typed thread (else null: a plain reply). */
  private async typedRootFor(road: Road, eventId: string, room: string): Promise<string | null> {
    const e = (await this.db.query<{ outcome: string; job_id: string | null }>(`select outcome, job_id from ${this.s}.inbound_events where event_id = $1`, [eventId])).rows[0];
    if (!e?.outcome.startsWith('typed:')) return null;
    if (e.outcome === 'typed:task_opened') return eventId;
    if (!e.job_id) return null;
    return (await this.rootOf(road, room, e.job_id))?.event_id ?? null;
  }

  async deliver(road: Road, eventId: string, room: string, text: string, card: Card | null, question: string | null = null): Promise<void> {
    const root = await this.typedRootFor(road, eventId, room);
    const content = { msgtype: 'm.notice', body: text, 'm.relates_to': root ? threadRelation(root, eventId) : { 'm.in_reply_to': { event_id: eventId } } };
    const sent = await road.send(room, content, replyTxnId(eventId));
    await this.db.query(`update ${this.s}.inbound_events set reply_status = 'sent', reply_event_id = $2, replied_at = now() where event_id = $1`, [eventId, sent]);
    // Recorded as what was said here: a card with the fingerprint it showed, a question with its wait.
    await this.recordOut(road, room, `reply:${eventId}`, card ? 'card' : question ? 'question' : 'reply', sent, card ? { proposal_id: card.proposal_id, fingerprint: card.fingerprint } : question ? { wait_id: question } : {});
    this.log('replied', { event: eventId, fixed: text === FIXED_FAILURE });
  }

  /** Every owed reply whose job has settled (as the book says), or whose deadline passed. */
  async replyTick(road: Road, stopping: () => boolean = () => false): Promise<number> {
    const { rows } = await this.db.query<{ event_id: string; room_id: string; sender_class: string | null; job_id: string | null; at: Date; reply_status: string; reply_text: string | null; overdue: boolean }>(
      `select event_id, room_id, sender_class, job_id, at, reply_status, reply_text, reply_due_at <= now() as overdue
         from ${this.s}.inbound_events where account = $1 and reply_status in ('waiting', 'sending') order by at limit 50`,
      [road.account],
    );
    let n = 0;
    for (const r of rows) {
      if (stopping()) break;
      if (r.reply_status === 'sending') {
        await this.deliver(road, r.event_id, r.room_id, r.reply_text ?? FIXED_FAILURE, null); // a resend after a crash: same txn id
        continue;
      }
      const settled = await this.settled(road, r);
      const text = settled?.text ?? (r.overdue ? FIXED_FAILURE : null);
      if (!text) continue;
      const claimed = await this.db.query(`update ${this.s}.inbound_events set reply_status = 'sending', reply_text = $2 where event_id = $1 and reply_status = 'waiting'`, [r.event_id, clip(text)]);
      if (!claimed.rowCount) continue;
      await this.deliver(road, r.event_id, r.room_id, clip(text), settled?.card ?? null, settled?.question ?? null);
      n++;
    }
    return n;
  }

  /** What the one reply says, from the book — or null while the job is still working. */
  private async settled(road: Road, r: { job_id: string | null; at: Date; sender_class: string | null }): Promise<{ text: string; card?: Card; question?: string } | null> {
    if (!r.job_id) return null;
    const job = (await this.db.query<{ status: string; result: TaskResult | null; on_behalf_of: string | null; requester: string }>(`select status, result, on_behalf_of, requester from ${this.s}.jobs where id = $1`, [r.job_id])).rows[0];
    if (!job) return null;
    if (job.status === 'DONE') return { text: roomText.reply(job.result) };
    if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(job.status)) return { text: FIXED_FAILURE };
    // A card raised by this job since the message: the reply states what is proposed; only a person may say yes.
    const a = (await this.db.query(`select * from ${this.s}.proposals where job_id = $1 and status = 'PROPOSED' and created_at >= $2 order by created_at desc limit 1`, [r.job_id, r.at])).rows[0];
    if (a) {
      const shown = { card: a.card, args: a.args, expires_at: new Date(a.expires_at).toISOString(), fingerprint: a.fingerprint };
      const card = { proposal_id: a.id as string, fingerprint: a.fingerprint as string };
      if (r.sender_class === 'person') return { text: roomText.card(this.appName, shown), card };
      const who = await this.personOf(road, job);
      if (who?.dm) await this.showCard(road, who.dm, a.id, a.job_id, a.fingerprint, roomText.card(this.appName, shown));
      // Recorded as shown to the bridge (with its fingerprint), so its clear "no" can bind to it — never a yes.
      return { card, text: bridgeCardText(this.appName, a, who, road.account) };
    }
    // A question the job asked since the message: the reply IS the question, and a reply to it answers it.
    const w = (
      await this.db.query<{ id: string; question: Question; expires_at: Date; job_id: string }>(
        `select id, question, expires_at, job_id from ${this.s}.waits where job_id = $1 and kind = 'input' and status = 'pending' and created_at >= $2 order by created_at desc limit 1`,
        [r.job_id, r.at],
      )
    ).rows[0];
    if (w?.question) {
      const body = roomText.question(this.appName, { ...w.question, due_at: new Date(w.expires_at).toISOString() });
      if (r.sender_class !== 'person') {
        const who = await this.personOf(road, job);
        if (who?.dm) await this.showQuestion(road, who.dm, w.id, w.job_id, body);
      }
      return { text: body, question: w.id };
    }
    return null;
  }

  /** Show a question in a DM, so a reply to it answers it. Once per question and room (txn id). */
  private async showQuestion(road: Road, room: string, waitId: string, jobId: string, body: string): Promise<void> {
    await this.notice(road, room, `question-${waitId}`, body, 'question', { wait_id: waitId, job_id: jobId }).catch((e) => this.log('question could not be shown in the DM', { wait: waitId, e: String(e?.message ?? e).slice(0, 200) }));
  }

  /** Show a card in a person's own recorded DM, so their reply to it can bind to its fingerprint. */
  private async showCard(road: Road, room: string, proposalId: string, jobId: string, fingerprint: string, body: string): Promise<void> {
    await this.notice(road, room, `card-${proposalId}`, body, 'card', { proposal_id: proposalId, job_id: jobId, fingerprint }).catch((e) => this.log('card could not be shown in the person’s DM', { proposal: proposalId, e: String(e?.message ?? e).slice(0, 200) }));
  }

  /**
   * Questions from jobs that were not asked through this account (the desk, NeuralChat's platform road): put to the
   * person the job is for, in that person's own recorded DM — once.
   */
  async questionsTick(road: Road): Promise<number> {
    const { rows } = await this.db.query<{ id: string; job_id: string; question: Question; expires_at: Date; room_id: string }>(
      `select w.id, w.job_id, w.question, w.expires_at, d.room_id
         from ${this.s}.waits w
         join ${this.s}.jobs j on j.id = w.job_id
         join ${this.s}.people p on p.company_id = w.company_id and ('user:' || p.user_id) = coalesce(j.on_behalf_of, j.requester) and p.chat_person
         join ${this.s}.presence_dms d on d.account = $1 and d.peer = p.matrix_id
        where w.company_id = $2 and w.kind = 'input' and w.status = 'pending' and w.question is not null
          and not exists (select 1 from ${this.s}.inbound_events e where e.account = $1 and e.event_id = j.origin)
          and not exists (select 1 from ${this.s}.outbound_events o where o.account = $1 and o.room_id = d.room_id and o.wait_id = w.id)
        order by w.created_at limit 20`,
      [road.account, road.companyId],
    );
    for (const q of rows) await this.showQuestion(road, q.room_id, q.id, q.job_id, roomText.question(this.appName, { ...q.question, due_at: new Date(q.expires_at).toISOString() }));
    return rows.length;
  }

  // ── people and jobs ─────────────────────────────────────────────────────────
  /** The person a job is for (its on_behalf_of, else a person requester), and their DM with this account. */
  async personOf(road: Road, job: { on_behalf_of: string | null; requester: string }): Promise<{ id: string; name: string; dm: string | null; role: string } | null> {
    const who = job.on_behalf_of?.startsWith('user:') ? job.on_behalf_of : job.requester.startsWith('user:') ? job.requester : null;
    if (!who) return null;
    const p = await this.identity.personById(road.companyId, who.slice(5));
    if (!p) return null;
    const dm = p.chat_person && p.matrix_id && road.kind === 'client' ? await this.dmOf(road, p.matrix_id) : null;
    return { id: p.id, name: p.name, role: p.role, dm };
  }

  async dmOf(road: Road, peer: string): Promise<string | null> {
    return (await this.db.query<{ room_id: string }>(`select room_id from ${this.s}.presence_dms where account = $1 and peer = $2`, [road.account, peer])).rows[0]?.room_id ?? null;
  }

  private async jobRow(id: string) {
    return (await this.db.query<{ id: string; status: string; on_behalf_of: string | null; requester: string; company_id: string }>(`select id, status, on_behalf_of, requester, company_id from ${this.s}.jobs where id = $1`, [id])).rows[0] ?? null;
  }

  /** The typed task root of this job in this room: its event and sender. */
  async rootOf(road: Road, room: string, jobId: string): Promise<{ event_id: string; sender: string; typed_task_id: string | null } | null> {
    return (
      (
        await this.db.query(
          `select event_id, sender, typed_task_id from ${this.s}.inbound_events where account = $1 and room_id = $2 and job_id = $3 and outcome = 'typed:task_opened' order by at limit 1`,
          [road.account, room, jobId],
        )
      ).rows[0] ?? null
    );
  }

  /** The job whose typed thread is rooted at this event in this room (null: not a typed thread here). */
  async jobOfRoot(road: Road, room: string, root: string): Promise<string | null> {
    return (await this.db.query<{ job_id: string }>(`select job_id from ${this.s}.inbound_events where account = $1 and room_id = $2 and event_id = $3 and outcome = 'typed:task_opened'`, [road.account, room, root])).rows[0]?.job_id ?? null;
  }

  /**
   * Open a job for this person from this event (idempotent on the event: its task id is derived from it).
   * `t.requester`/`t.source`: a task from another app on the bus (v3 §9, S6) — the asking app is the requester, the
   * person is on_behalf_of. `t.task_id`/`trace`/`attachments`/`parent_job_id` (v3 S5, a typed task): the sender's task id
   * when it may be the job's, its trace, the files it referenced, the job it follows up.
   */
  async open(
    road: Road,
    eventId: string,
    room: string,
    personId: string,
    text: string,
    outcome: string,
    t: { requester?: string; source?: 'a2a'; task_id?: string; trace?: string | null; attachments?: DocumentUpload[]; parent_job_id?: string | null } = {},
  ): Promise<string | null> {
    const inst = await this.identity.install(road.companyId);
    if (!inst || inst.status !== 'active') {
      await this.replyNow(road, eventId, room, outcome.startsWith('typed:') ? 'typed:not_installed' : 'not_installed', 'This app is not installed for your company. Nothing was done.');
      return null;
    }
    const span = t.trace ? this.core.tracer.start('presence.task', t.trace, { 'neop.app': this.core.key, 'neop.event': eventId }) : null;
    const { job_id } = await openJob(this.core, road.companyId, {
      task_id: t.task_id ?? taskIdForEvent(eventId),
      ask: text,
      requester: t.requester ?? `user:${personId}`,
      source: t.source ?? (road.kind === 'appservice' ? 'room' : 'task'),
      ...(t.requester ? { on_behalf_of: `user:${personId}` } : {}),
      origin: eventId,
      ...(span ? { trace: span.header() } : {}),
      ...(t.attachments?.length ? { attachments: t.attachments } : {}),
      ...(t.parent_job_id ? { parent_job_id: t.parent_job_id } : {}),
    }).finally(() => span?.end());
    await this.setIn(eventId, null, { person_id: `user:${personId}` });
    if (road.kind === 'client') await this.owe(eventId, outcome, job_id);
    else await this.setIn(eventId, outcome, { job_id });
    this.log('job opened', { event: eventId, job: job_id });
    return job_id;
  }

  // ── decisions (people only) ─────────────────────────────────────────────────
  /**
   * A person's decision on a proposal, against the fingerprint they saw, through <schema>.answer_proposal() (the
   * one SQL place an answer enters), with the person's roles: the company's approver policy (roles, four-eyes against
   * the job's own requester) is checked there (t011). A yes is carried out by the runner's approved path
   * (runner/waits.ts, V3 S2) — exactly as a desk yes. Throws an Error whose message says why it was not recorded.
   */
  async decide(companyId: string, person: Person, proposalId: string, fingerprint: string, decision: 'yes' | 'no' | 'change' | 'withdraw', feedback?: string | null): Promise<{ status: string; job_id: string; idempotent: boolean }> {
    let r: { status: string; idempotent: boolean; job_id: string; refused?: string };
    try {
      r = await this.core.company(
        companyId,
        async (c) => (await c.query(`select ${this.s}.answer_proposal($1, $2, $3, $4, $5, $6) as r`, [proposalId, fingerprint, decision, `user:${person.id}`, feedback ?? null, [person.role]])).rows[0].r,
      );
    } catch (e) {
      const m = /^(not_found|not_open|expired|bad_request|not_an_approver|four_eyes): (.*)$/s.exec(String((e as Error).message ?? ''));
      if (!m) throw e;
      if (m[1] === 'not_open') throw new Error(`this card is no longer open (${m[2]!.replace(/^proposal is /, '').toLowerCase()})`);
      if (m[1] === 'expired') throw new Error('this card is expired');
      if (m[1] === 'not_found') throw new Error('no such card');
      throw new Error(m[2]!);
    }
    if (r.refused === 'fingerprint_mismatch') throw new Error(FINGERPRINT_MISMATCH);
    // The same answer again (a second event saying what was already recorded) changes nothing: say so, as the desk does.
    if (r.idempotent) throw new Error(`this card is no longer open (${String(r.status).toLowerCase()})`);
    return r;
  }

  // ── answers (a person's words, or relayed data) ─────────────────────────────
  private async waitRow(id: string) {
    return (
      await this.db.query<{ id: string; job_id: string; status: string; outcome: string | null; question: Question | null; company_id: string; kind: string }>(
        `select id, job_id, status, outcome, question, company_id, kind from ${this.s}.waits where id = $1`,
        [id],
      )
    ).rows[0] ?? null;
  }

  /** Record an answer through the book (waits.answer's write). Throws with the reason it was not recorded. */
  async answer(companyId: string, waitId: string, who: Relay, answers: Record<string, unknown>): Promise<void> {
    const w = await this.waitRow(waitId);
    if (!w || w.company_id !== companyId || w.kind !== 'input') throw Object.assign(new Error('no such question'), { code: 'not_found' });
    if (w.status !== 'pending') throw Object.assign(new Error(`this question is ${w.outcome === 'ANSWERED' ? 'answered' : w.outcome === 'EXPIRED' ? 'expired' : 'closed'}; it can no longer be answered`), { code: 'stale' });
    try {
      await answerWait(this.core, companyId, { wait_id: waitId, answers, answered_by: who.user_id ? `user:${who.user_id}` : who.relay!, via: who.user_id ? 'chat' : 'bridge' });
    } catch (e) {
      if (e instanceof ExecError) throw Object.assign(new Error(e.message), { code: e.code });
      throw e;
    }
  }

  private async recordAnswer(road: Road, eventId: string, room: string, w: { id: string; job_id: string }, who: Relay, answers: Record<string, unknown>): Promise<boolean> {
    try {
      await this.answer(road.companyId, w.id, who, answers);
    } catch (e) {
      await this.replyNow(road, eventId, room, 'answer_refused', `That answer was not recorded: ${(e as Error).message}.`);
      return true;
    }
    // The reply this answer is owed is the job's next word: its result, a card, or another question.
    await this.owe(eventId, who.user_id ? 'answered:question' : 'relayed:question', w.job_id, {});
    return true;
  }

  /** A reply to a question notice shown in the sender's OWN recorded DM answers that question. */
  private async answerByReply(road: Road, eventId: string, room: string, sender: string, who: Relay, body: string, inReplyTo: string): Promise<boolean> {
    const shown = (
      await this.db.query<{ wait_id: string }>(
        `select o.wait_id from ${this.s}.outbound_events o join ${this.s}.presence_dms d on d.account = o.account and d.room_id = o.room_id and d.peer = $4
          where o.event_id = $1 and o.account = $2 and o.room_id = $3 and o.wait_id is not null`,
        [inReplyTo, road.account, room, sender],
      )
    ).rows[0];
    if (!shown) return false;
    const w = await this.waitRow(shown.wait_id);
    if (!w?.question) return false;
    await this.setIn(eventId, null, { wait_id: w.id, job_id: w.job_id });
    const answers = answersFromText(w.question, body);
    if (!answers) {
      await this.replyNow(road, eventId, room, 'unclear_answer', `Reply with one line per answer, as key: value (${w.question.fields.map((f) => f.key).join(', ')}). Nothing was recorded.`);
      return true;
    }
    return this.recordAnswer(road, eventId, room, w, who, answers);
  }

  /**
   * Where the conversation in this DM is: the latest thing this account said there (a card, a question, a reply).
   * A plain answer binds to a question, and a bridge's plain decline to a card, only while the DM is AT it.
   */
  async latestSaid(road: Road, room: string): Promise<{ event_id: string | null; proposal_id: string | null; wait_id: string | null; fingerprint_shown: string | null } | null> {
    return (await this.db.query(`select event_id, proposal_id, wait_id, fingerprint_shown from ${this.s}.outbound_events where account = $1 and room_id = $2 order by id desc limit 1`, [road.account, room])).rows[0] ?? null;
  }

  /**
   * A plain message (not a reply) in the sender's own DM answers the latest open question shown there for a job the
   * sender asked in that DM, while the DM is AT it and it reads as an answer (plainAnswers). False: a new request.
   */
  private async answerPlain(road: Road, eventId: string, room: string, sender: string, who: Relay, body: string): Promise<boolean> {
    const at = await this.latestSaid(road, room);
    if (!at?.wait_id) return false;
    const w = await this.waitRow(at.wait_id);
    if (!w?.question || w.status !== 'pending' || w.company_id !== road.companyId) return false;
    const asked = await this.db.query(`select 1 from ${this.s}.inbound_events where account = $1 and room_id = $2 and sender = $3 and job_id = $4 limit 1`, [road.account, room, sender, w.job_id]);
    if (!asked.rowCount) return false;
    // The whole text answers a one-field question for a PERSON only; a bridge's plain message needs key: value.
    const read = plainAnswers({ fields: w.question.fields }, body, { wholeText: !!who.user_id });
    if (!read) return false;
    await this.setIn(eventId, null, { wait_id: w.id });
    if (read.missing.length) {
      await this.replyNow(
        road,
        eventId,
        room,
        'unclear_answer',
        `To answer the question, also give ${read.missing.map((f) => `${f.key} (${f.label})`).join(', ')} — as key: value, one per line or separated by ";". Nothing was recorded.`,
      );
      return true;
    }
    return this.recordAnswer(road, eventId, room, w, who, read.answers);
  }

  // ── plain text on the client road (DMs) ─────────────────────────────────────
  /** A plain m.text from a known sender in a 1:1 DM (already recorded once by event_id). */
  async onDirectMessage(road: Road, m: { event_id: string; room: string; sender: string; who: Who; body: string; in_reply_to: string | null; on_behalf_of?: unknown }): Promise<void> {
    if (m.who.cls === 'person') return this.fromPerson(road, m.event_id, m.room, m.sender, m.who.person, m.body, m.in_reply_to);
    return this.fromBridge(road, m.event_id, m.room, m.sender, m.who.actsFor, m.body, m.on_behalf_of, m.in_reply_to);
  }

  private async fromPerson(road: Road, eventId: string, room: string, sender: string, person: Person, body: string, inReplyTo: string | null): Promise<void> {
    await this.setIn(eventId, null, { person_id: `user:${person.id}` });
    if (inReplyTo) {
      // A reply to a question shown in this person's own DM: their answer, in their words.
      if (await this.answerByReply(road, eventId, room, sender, { user_id: person.id }, body, inReplyTo)) return;
      // An answer binds to a card THIS account showed in THIS person's own recorded DM, and to its fingerprint.
      const card = (
        await this.db.query<{ proposal_id: string; fingerprint_shown: string; job_id: string | null }>(
          `select o.proposal_id, o.fingerprint_shown, o.job_id from ${this.s}.outbound_events o join ${this.s}.presence_dms d on d.account = o.account and d.room_id = o.room_id and d.peer = $4
            where o.event_id = $1 and o.account = $2 and o.room_id = $3 and o.proposal_id is not null`,
          [inReplyTo, road.account, room, sender],
        )
      ).rows[0];
      if (card) return this.cardReply(road, eventId, room, person, card, body);
    } else if (await this.answerPlain(road, eventId, room, sender, { user_id: person.id }, body)) return;
    await this.open(road, eventId, room, person.id, body, 'task_opened');
  }

  /** A person's reply to a card shown to them: yes / no / change: … / withdraw, bound to the fingerprint shown. */
  private async cardReply(road: Road, eventId: string, room: string, person: Person, card: { proposal_id: string; fingerprint_shown: string }, body: string): Promise<void> {
    const d = parseDecision(body);
    if (!d) {
      const text = road.kind === 'client' ? 'Reply to the card with "yes", "no" or "change: <what to change>". Nothing was recorded.' : 'Reply to the card with "yes", "no" or "change: <what to change>".';
      return this.replyNow(road, eventId, room, 'unclear_answer', text, { proposal_id: card.proposal_id });
    }
    let r: { job_id: string };
    try {
      r = await this.decide(road.companyId, person, card.proposal_id, card.fingerprint_shown, d.decision, d.feedback);
    } catch (e) {
      await this.setIn(eventId, null, { proposal_id: card.proposal_id, fingerprint: card.fingerprint_shown });
      return this.replyNow(road, eventId, room, 'answer_refused', `That answer was not recorded: ${(e as Error).message}.`, { proposal_id: card.proposal_id });
    }
    await this.setIn(eventId, `answered:${d.decision}`, { proposal_id: card.proposal_id, fingerprint: card.fingerprint_shown, job_id: r.job_id });
    if (road.kind === 'appservice') return; // the room hears the job's next word from the mirror
    if (d.decision === 'yes') return this.owe(eventId, `answered:${d.decision}`, r.job_id, { proposal_id: card.proposal_id, fingerprint: card.fingerprint_shown });
    const said: Record<string, string> = { yes: 'approved', no: 'declined', change: 'sent back with your changes', withdraw: 'withdrawn' };
    return this.replyNow(road, eventId, room, `answered:${d.decision}`, `Recorded: card ${card.proposal_id.slice(0, 8)} ${said[d.decision]}.`, { proposal_id: card.proposal_id, fingerprint: card.fingerprint_shown });
  }

  private async fromBridge(road: Road, eventId: string, room: string, bridge: string, actsFor: string | null, body: string, onBehalf: unknown, inReplyTo: string | null): Promise<void> {
    // A reply to a question shown in the bridge's OWN DM answers it — as relayed, untrusted data. An answer is not a yes.
    if (inReplyTo && (await this.answerByReply(road, eventId, room, bridge, { relay: `bridge:${bridge}` }, body, inReplyTo))) return;
    // A bridge's clear "no" to a card it was shown is taken for the person: caution may be added, never removed.
    if (await this.declineByBridge(road, eventId, room, bridge, body, inReplyTo)) return;
    if (isConsent(body)) {
      // v3 §5/§8/§16: a bridge's "go ahead" is never a yes. If a card from its asks is open, re-show it and say where a person approves it.
      const open = (
        await this.db.query<{ id: string; card: any; args: any; expires_at: Date; fingerprint: string; job_id: string }>(
          `select p.id, p.card, p.args, p.expires_at, p.fingerprint, p.job_id from ${this.s}.proposals p
            where p.status = 'PROPOSED' and p.company_id = $3
              and p.job_id in (select job_id from ${this.s}.inbound_events where account = $1 and sender = $2 and job_id is not null)
            order by p.created_at desc limit 5`,
          [road.account, bridge, road.companyId],
        )
      ).rows;
      if (open.length) {
        const first = open[0]!;
        const job = await this.jobRow(first.job_id);
        const who = job ? await this.personOf(road, job) : null;
        const cards = open.map((a) => `card ${a.id.slice(0, 8)} (${clip(a.card?.what, 200)})`).join('; ');
        await this.setIn(eventId, null, { detail: { consent: 'not_a_yes', proposals: open.map((a) => a.id) } });
        return this.replyNow(
          road,
          eventId,
          room,
          'bridge_consent_refused',
          [
            `Nothing was done: a bridge cannot approve. I can't take a yes through NeuralChat. Please approve #${first.id.slice(0, 8)} on your desk.`,
            `${cards} is waiting for a person's yes — ${who ? `${who.name} can answer it` : 'a person answers it'} on My Desk in NEOS${who?.dm ? ` or in their own DM with ${road.account}` : ''}.`,
            '',
            'The change still waiting:',
            waitingCardText(this.appName, first),
          ].join('\n'),
          { proposal_id: first.id, card: { proposal_id: first.id, fingerprint: first.fingerprint } },
        );
      }
    }
    // A plain next message may be the answer to the question this bridge's job asked here.
    if (!inReplyTo && (await this.answerPlain(road, eventId, room, bridge, { relay: `bridge:${bridge}` }, body))) return;
    // The ask is opened for a person: the one the message names (if linked here), else the bridge's own `acts_for`.
    let person = actsFor;
    if (typeof onBehalf === 'string' && /^@[^:]+:.+$/.test(onBehalf)) {
      const p = await this.identity.person(road.companyId, onBehalf);
      if (p) person = p.id;
    }
    if (!person) return this.replyNow(road, eventId, room, 'no_person', `Nothing was done: ${bridge} relays for a person, and no person is on record for it at this company.`);
    await this.open(road, eventId, room, person, body, 'task_opened');
  }

  /**
   * A bridge's clear decline of a card it was shown in its own DM — as a reply to that card, or naming its id, or
   * (plainly worded) while the DM is at it — is recorded as the person's "no", with the fingerprint shown there.
   */
  private async declineByBridge(road: Road, eventId: string, room: string, bridge: string, body: string, inReplyTo: string | null): Promise<boolean> {
    if (!DECLINE.test(body) || parseDecision(body)?.decision === 'yes') return false;
    const shown = (
      await this.db.query<{ proposal_id: string; fingerprint_shown: string; event_id: string; fingerprint: string; job_id: string }>(
        `select o.proposal_id, o.fingerprint_shown, o.event_id, p.fingerprint, p.job_id
           from ${this.s}.outbound_events o
           join ${this.s}.presence_dms d on d.account = o.account and d.room_id = o.room_id and d.peer = $3
           join ${this.s}.proposals p on p.id = o.proposal_id
          where o.account = $1 and o.room_id = $2 and o.proposal_id is not null and p.status = 'PROPOSED' and p.company_id = $4
          order by o.id desc`,
        [road.account, room, bridge, road.companyId],
      )
    ).rows;
    let hits = shown.filter((c) => (inReplyTo ? c.event_id === inReplyTo : body.toLowerCase().includes(c.proposal_id.slice(0, 8).toLowerCase())));
    if (!inReplyTo && !hits.length && PLAIN_DECLINE.test(body) && !POSTPONE.test(body)) {
      // NeuralChat sends plain messages that name no card ("The user declined. Please drop that proposal."). A no only
      // adds caution, so it binds to the card the DM is AT, or else to the ONE card still waiting here.
      const at = await this.latestSaid(road, room);
      const current = at?.proposal_id ? shown.filter((c) => c.proposal_id === at.proposal_id) : [];
      const waiting = [...new Map(shown.map((c) => [c.proposal_id, c])).values()];
      hits = current.length ? current : waiting.length === 1 ? waiting : [];
    }
    const named = [...new Map(hits.map((c) => [c.proposal_id, c])).values()];
    if (named.length !== 1) return false; // not exactly one card it was shown: the job hears it as a request
    const card = named[0]!;
    const id8 = card.proposal_id.slice(0, 8);
    if (card.fingerprint !== card.fingerprint_shown) {
      await this.replyNow(road, eventId, room, 'answer_refused', `That was not recorded: card ${id8} changed after it was shown here.`, { proposal_id: card.proposal_id });
      return true;
    }
    const job = await this.jobRow(card.job_id);
    const who = job ? await this.personOf(road, job) : null;
    const person = who ? await this.identity.personById(road.companyId, who.id) : null;
    if (!person) {
      await this.replyNow(road, eventId, room, 'no_person', `Nothing was recorded: no person is on record for card ${id8}.`, { proposal_id: card.proposal_id });
      return true;
    }
    try {
      await this.decide(road.companyId, person, card.proposal_id, card.fingerprint_shown, 'no', `declined via ${bridge} on behalf of ${person.name}`);
    } catch (e) {
      await this.replyNow(road, eventId, room, 'answer_refused', `That was not recorded: ${(e as Error).message}.`, { proposal_id: card.proposal_id });
      return true;
    }
    await this.setIn(eventId, null, { job_id: card.job_id, detail: { declined: card.proposal_id, fingerprint_seen: card.fingerprint_shown, on_behalf_of: person.id, via: bridge } });
    await this.replyNow(road, eventId, room, 'declined:bridge', `Recorded: card ${id8} declined for ${person.name}, via ${bridge}. Nothing will be done.`, {
      proposal_id: card.proposal_id,
      fingerprint: card.fingerprint_shown,
    });
    return true;
  }

  // ── plain text in the app's rooms (appservice road) ────────────────────────
  /**
   * A plain m.text in one of the app's rooms (already recorded once by event_id). Only a person linked to the room's
   * company is acted on (the room's membership is the allowlist); a reply to a card shown in this room is their
   * decision, bound to the fingerprint that card showed; anything else is a task.
   */
  async onRoomMessage(road: Road, m: { event_id: string; room: string; sender: string; body: string; in_reply_to: string | null }): Promise<string> {
    const person = await this.identity.person(road.companyId, m.sender);
    if (!person) {
      await this.setIn(m.event_id, 'unknown_sender');
      await this.notice(road, m.room, `unknown:${m.event_id}`, 'I can only act for people linked to this company on NEOS. Nothing was done.');
      return 'unknown_sender';
    }
    await this.setIn(m.event_id, null, { person_id: `user:${person.id}` });
    const inst = await this.identity.install(road.companyId);
    if (!inst || inst.status !== 'active') {
      await this.setIn(m.event_id, 'not_installed');
      await this.notice(road, m.room, `notinstalled:${m.event_id}`, 'This app is not installed for your company. Nothing was done.');
      return 'not_installed';
    }
    if (m.in_reply_to) {
      const card = (
        await this.db.query<{ proposal_id: string; fingerprint_shown: string }>(
          `select proposal_id, fingerprint_shown from ${this.s}.outbound_events where event_id = $1 and account = $2 and room_id = $3 and proposal_id is not null`,
          [m.in_reply_to, road.account, m.room],
        )
      ).rows[0];
      if (card) {
        await this.cardReply(road, m.event_id, m.room, person, card, m.body);
        return (await this.db.query<{ outcome: string }>(`select outcome from ${this.s}.inbound_events where event_id = $1`, [m.event_id])).rows[0]?.outcome ?? 'received';
      }
    }
    await this.open(road, m.event_id, m.room, person.id, m.body, 'task_opened');
    return 'task_opened';
  }

  // ── typed events (both roads) ───────────────────────────────────────────────
  /** Drop: recorded (outcome + why), nothing sent back. */
  private async drop(ev: TypedIn, who: Who | null, outcome: string, detail: Record<string, unknown> = {}): Promise<string> {
    await this.setIn(ev.event_id, `typed:${outcome}`, { detail: { class: who?.cls ?? null, type: ev.type, ...detail } });
    this.log('typed event dropped', { event: ev.event_id, type: ev.type, outcome });
    return `typed:${outcome}`;
  }

  /** One typed event from a known sender (already recorded once by event_id). Returns the outcome. */
  async onTyped(road: Road, ev: TypedIn, who: Who): Promise<string> {
    if (!isTypedEventType(ev.type)) return this.drop(ev, who, 'unknown_type');
    if (!maySend(who.cls, ev.type)) return this.drop(ev, who, `refused:${shortType(ev.type)}`, { reason: `a ${who.cls} may not send ${ev.type}` });
    const v = validateTypedBody(ev.type, ev.content);
    if (!v.ok) return this.drop(ev, who, 'invalid', { error: v.error });
    const root = threadRootOf(ev.content);
    // v3 S6: the company's bus room is apps talking to apps (runner/bus.ts): tasks, borrowed calls, their answers.
    if (this.bus && (await this.bus.isBusRoom(road, ev.room_id))) return this.bus.onTyped(road, ev, who, v.body, root);
    switch (ev.type) {
      case 'neos.neop.task':
        return this.onTask(road, ev, who, v.body as TypedBodies['neos.neop.task']);
      case 'neos.neop.answer':
        return this.onAnswer(road, ev, who, v.body as TypedBodies['neos.neop.answer'], root);
      case 'neos.neop.approve':
        return this.onApprove(road, ev, who, v.body as TypedBodies['neos.neop.approve'], root);
      default: {
        // ask · propose · done · note from another NEOP: information for the record; this app took no work from it.
        await this.setIn(ev.event_id, `typed:info:${shortType(ev.type)}`, { detail: { class: who.cls, body: v.body } });
        return `typed:info:${shortType(ev.type)}`;
      }
    }
  }

  /** A notice back for a typed event: the client road's one reply, or a notice in the room. */
  private async typedSay(road: Road, ev: TypedIn, outcome: string, text: string, x: { proposal_id?: string } = {}): Promise<void> {
    await this.replyNow(road, ev.event_id, ev.room_id, outcome, text, x);
  }

  private async onTask(road: Road, ev: TypedIn, who: Who, b: TypedBodies['neos.neop.task']): Promise<string> {
    const inst = await this.identity.install(road.companyId);
    if (!inst || (b.company !== inst.company_id && b.company !== inst.company_slug)) return this.drop(ev, who, 'wrong_company', { company: b.company });
    let person: string | null = null;
    if (who.cls === 'person') {
      // A person asks for themselves only.
      if (b.on_behalf_of !== ev.sender) return this.drop(ev, who, 'not_on_behalf', { on_behalf_of: b.on_behalf_of });
      person = who.person.id;
    } else {
      person = (await this.identity.person(road.companyId, b.on_behalf_of))?.id ?? who.actsFor ?? null;
    }
    if (!person) {
      await this.setIn(ev.event_id, null, { detail: { class: who.cls, on_behalf_of: b.on_behalf_of } });
      await this.typedSay(road, ev, 'typed:no_person', `Nothing was done: ${b.on_behalf_of} is not a person linked to this company on NEOS.`);
      return 'typed:no_person';
    }
    // v3 S5: files by reference and the job a follow-up continues ride in `fields` (contracts readTaskFields); the rest
    // of `fields` is the sender's data, shown to the job as given.
    const f = readTaskFields(b.fields);
    if (f.errors.length) return this.drop(ev, who, 'invalid', { error: f.errors[0] });
    const fields = Object.keys(f.rest).length ? `\n\nFields given:\n${Object.entries(f.rest).map(([k, x]) => `${k}: ${String(x)}`).join('\n')}` : '';
    await this.setIn(ev.event_id, null, { typed_task_id: b.task_id, detail: { class: who.cls, task_id: b.task_id } });
    let attachments: DocumentUpload[] = [];
    if (f.files.length) {
      try {
        attachments = await fetchTaskFiles(this.core, f.files);
      } catch (e) {
        await this.setIn(ev.event_id, null, { detail: { class: who.cls, task_id: b.task_id, error: String((e as Error).message).slice(0, 300) } });
        await this.typedSay(road, ev, 'typed:file_refused', `Nothing was done: ${(e as Error).message}.`);
        return 'typed:file_refused';
      }
    }
    // The sender's own task id is the job's when it is a uuid no other sender's job holds (a resend of the same task,
    // even as a new event, then finds the same job); anything else gets the id derived from the event.
    let taskId: string | undefined;
    if (UUID.test(b.task_id)) {
      const held = (await this.db.query<{ sender: string | null }>(`select e.sender from ${this.s}.jobs j left join ${this.s}.inbound_events e on e.event_id = j.origin where j.company_id = $1 and j.task_id = $2`, [road.companyId, b.task_id])).rows[0];
      if (!held || held.sender === ev.sender) taskId = b.task_id;
    }
    const job = await this.open(road, ev.event_id, ev.room_id, person, `${b.text}${fields}`, 'typed:task_opened', { task_id: taskId, trace: b.trace ?? null, attachments, parent_job_id: f.parent_job_id });
    return job ? 'typed:task_opened' : 'typed:not_installed';
  }

  /** The thread an answer/approve names must be the typed thread of the job it touches. */
  private async threadOk(road: Road, room: string, root: string | null, jobId: string): Promise<boolean> {
    if (!root) return true;
    return (await this.jobOfRoot(road, room, root)) === jobId;
  }

  private async shownHere(road: Road, room: string, col: 'proposal_id' | 'wait_id', id: string): Promise<boolean> {
    return !!(await this.db.query(`select 1 from ${this.s}.outbound_events where account = $1 and room_id = $2 and ${col} = $3 limit 1`, [road.account, room, id])).rowCount;
  }

  async onAnswer(road: Road, ev: TypedIn, who: Who, b: TypedBodies['neos.neop.answer'], root: string | null): Promise<string> {
    const w = UUID.test(b.wait_id) ? await this.waitRow(b.wait_id) : null;
    if (!w || w.company_id !== road.companyId || w.kind !== 'input' || !(await this.shownHere(road, ev.room_id, 'wait_id', w.id))) return this.drop(ev, who, 'unknown_wait', { wait_id: b.wait_id });
    if (!(await this.threadOk(road, ev.room_id, root, w.job_id))) return this.drop(ev, who, 'thread_mismatch', { wait_id: b.wait_id, thread: root });
    const taskRoot = await this.rootOf(road, ev.room_id, w.job_id);
    // An agent or another NEOP answers only a question of a task it opened here (its thread).
    if (who.cls !== 'person' && (!taskRoot || taskRoot.sender !== ev.sender)) return this.drop(ev, who, 'not_their_wait', { wait_id: b.wait_id });
    const stale = async (why: string) => {
      await this.setIn(ev.event_id, 'typed:stale', { wait_id: w.id, job_id: w.job_id, detail: { class: who.cls, why } });
      await this.typed(
        road,
        ev.room_id,
        `typed:${w.job_id}:note:stale-${ev.event_id}`,
        'neos.neop.note',
        { job_id: w.job_id, step_id: `stale-${w.id}`, text: `stale: wait ${w.id} is no longer open (${why}); the answer was not used.` },
        `That answer came too late: the question "${clip(w.question?.text, 200)}" is ${why}. Nothing was recorded.`,
        taskRoot?.event_id ?? root,
        { job_id: w.job_id },
      );
      return 'typed:stale';
    };
    if (w.status !== 'pending') return stale(w.outcome === 'EXPIRED' ? 'expired' : w.outcome === 'ANSWERED' ? 'answered' : 'closed');
    const as: Relay = who.cls === 'person' ? { user_id: who.person.id } : { relay: `${who.cls === 'neop' ? 'app' : 'bridge'}:${ev.sender}` };
    try {
      await this.answer(road.companyId, w.id, as, b.answers);
    } catch (e: any) {
      if (e?.code === 'stale') return stale('closed');
      await this.setIn(ev.event_id, 'typed:answer_refused', { wait_id: w.id, detail: { class: who.cls, error: String(e?.message ?? e).slice(0, 300) } });
      await this.typedSay(road, ev, 'typed:answer_refused', `That answer was not recorded: ${e?.message ?? e}.`);
      return 'typed:answer_refused';
    }
    await this.setIn(ev.event_id, 'typed:answered', { wait_id: w.id, job_id: w.job_id });
    if (road.kind === 'client') await this.owe(ev.event_id, 'typed:answered', w.job_id);
    return 'typed:answered';
  }

  private async onApprove(road: Road, ev: TypedIn, who: Who, b: TypedBodies['neos.neop.approve'], root: string | null): Promise<string> {
    // maySend already refused every non-person — a typed yes is a person's own, sent as themselves. In a room,
    // Matrix's power levels must give them the approve level too (the runner's fail-safe).
    if (who.cls !== 'person') return this.drop(ev, who, 'refused:approve');
    if (road.mayApproveHere && !(await road.mayApproveHere(ev.room_id, ev.sender))) return this.drop(ev, who, 'below_approve_level');
    const p = UUID.test(b.proposal_id)
      ? (await this.db.query<{ id: string; job_id: string; company_id: string }>(`select id, job_id, company_id from ${this.s}.proposals where id = $1`, [b.proposal_id])).rows[0]
      : undefined;
    if (!p || p.company_id !== road.companyId || !(await this.shownHere(road, ev.room_id, 'proposal_id', p.id))) return this.drop(ev, who, 'unknown_proposal', { proposal_id: b.proposal_id });
    if (!(await this.threadOk(road, ev.room_id, root, p.job_id))) return this.drop(ev, who, 'thread_mismatch', { proposal_id: b.proposal_id, thread: root });
    try {
      await this.decide(road.companyId, who.person, p.id, b.fingerprint, b.decision, b.feedback);
    } catch (e: any) {
      await this.setIn(ev.event_id, 'typed:approve_refused', { proposal_id: p.id, fingerprint: b.fingerprint, person_id: `user:${who.person.id}`, detail: { class: who.cls, error: String(e?.message ?? e).slice(0, 300) } });
      await this.typedSay(road, ev, 'typed:approve_refused', `That answer was not recorded: ${e?.message ?? e}.`, { proposal_id: p.id });
      return 'typed:approve_refused';
    }
    await this.setIn(ev.event_id, `typed:answered:${b.decision}`, { proposal_id: p.id, fingerprint: b.fingerprint, person_id: `user:${who.person.id}`, job_id: p.job_id });
    if (road.kind === 'client') {
      if (b.decision === 'yes') await this.owe(ev.event_id, `typed:answered:${b.decision}`, p.job_id, { proposal_id: p.id, fingerprint: b.fingerprint });
      else await this.replyNow(road, ev.event_id, ev.room_id, `typed:answered:${b.decision}`, 'Recorded.', { proposal_id: p.id, fingerprint: b.fingerprint });
    }
    return `typed:answered:${b.decision}`;
  }
}
