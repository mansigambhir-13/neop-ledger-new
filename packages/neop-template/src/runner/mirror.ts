import {sqlIdent} from '@neop/pgkit';
// THE RUNNER'S MOUTH · short notes to the room, one per step, never twice (v3 §3 step 9, §8, §13 `mirror.ts`;
// V3 migration stage S4). Template-only. It reads this app's own outbox (per company, its own cursor in
// <schema>.presence_mirror — the platform keeps its own) and says what the book says:
//
//   in the app's room (appservice road) — for a job asked in that room, or, when the company has a room, any
//   job: "on it", one line per step, the card (recorded with the fingerprint it showed, so an answer binds to
//   it), the answer, the execution, a question, a heads-up, the result — the same m.notice text the platform's
//   bridge posted (presence/cards.ts).
//   in a typed thread (either road) — for a job opened by a typed neos.neop.task: note "on it", a note per step
//   (deduped by step id), ask (an open question), propose (the card: fingerprint, expiry), done (THEIR task id),
//   each with the m.notice text as `body` so a plain client still reads it.
//   A plain DM on the client road gets nothing from here: it gets exactly one reply (runner/inbound.ts).
//
// Each message's key is its transaction id (txnId = dedupe key): a resend is the same event, and a key already
// said in that room is never said again. A send that fails stops this company's pass at that event (order is
// kept); the next pass starts there — up to 10 tries, then that event is given up (logged) so one room the app
// was removed from never silences the rest. A client-road account that is not running has no voice: its typed
// thread notes are not replayed later (its one reply per message is — that comes from the book, not the outbox).

import type { OutboxEventType, QuestionField, TaskResult } from '@neop/contracts';
import type { Core } from '../core.ts';
import { clip, roomText } from '../presence/cards.ts';
import type { Identity } from '../presence/identity.ts';
import type { Inbound, Road } from './inbound.ts';

interface OutboxRow {
  id: number;
  company_id: string;
  event_type: OutboxEventType;
  payload: any;
}

interface Origin {
  account: string;
  room_id: string;
  road: 'appservice' | 'client';
  typed: boolean;
  /** v3 S6: opened by a borrowed call (a typed ask with `call`) — its answer is the bus's, never a `done`. */
  call: boolean;
  event_id: string;
  typed_task_id: string | null;
}

const PLAIN_STEP_SKIP = ['received', 'report', 'failed', 'proposal'];
const MAX_TRIES = 10;

export class Mirror {
  readonly core: Core;
  readonly identity: Identity;
  readonly inbound: Inbound;
  /** The live road for one of our names (null: that name is not speaking in this process). */
  private readonly roadOf: (account: string) => Road | null;
  /** Is this room fit to speak in (appservice rooms are checked once; DMs always are)? */
  private readonly roomReady: (road: Road, room: string) => Promise<boolean>;
  private busy = false;
  /** Failed sends per outbox event: after MAX_TRIES the event is given up (logged), so one bad room never stalls a company. */
  private readonly tries = new Map<string, number>();

  constructor(core: Core, identity: Identity, inbound: Inbound, o: { roadOf: (account: string) => Road | null; roomReady: (road: Road, room: string) => Promise<boolean> }) {
    this.core = core;
    this.identity = identity;
    this.inbound = inbound;
    this.roadOf = o.roadOf;
    this.roomReady = o.roomReady;
  }

  private get s(): string {
    return this.core.key;
  }
  private get db() {
    return this.core.runnerPool;
  }

  /** One pass over every company this app speaks for in Matrix. Returns how many outbox events were read. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      let n = 0;
      for (const inst of await this.identity.named()) n += await this.company(inst.company_id).catch((e) => (this.core.log('presence: mirror pass failed', { company: inst.company_id, e: String(e?.message ?? e).slice(0, 200) }), 0));
      return n;
    } finally {
      this.busy = false;
    }
  }

  private async company(companyId: string): Promise<number> {
    // The first pass for a company starts at the outbox's end — history from before presence is never said — except
    // for jobs already opened from Matrix (their whole story is owed to their room/thread).
    await this.db.query(
      `insert into ${sqlIdent(this.s)}.presence_mirror (company_id, cursor)
       select $1, least(coalesce(m.first - 1, m.last), m.last) from (
         select (select coalesce(max(id), 0) from ${sqlIdent(this.s)}.outbox where company_id = $1) as last,
                (select min(o.id) from ${sqlIdent(this.s)}.outbox o
                   join ${sqlIdent(this.s)}.jobs j on j.company_id = o.company_id and j.id::text = o.payload->>'job_id'
                   join ${sqlIdent(this.s)}.inbound_events e on e.event_id = j.origin
                  where o.company_id = $1) as first) m
       on conflict (company_id) do nothing`,
      [companyId],
    );
    const cursor = Number((await this.db.query<{ cursor: string }>(`select cursor from ${sqlIdent(this.s)}.presence_mirror where company_id = $1`, [companyId])).rows[0]?.cursor ?? 0);
    const { rows } = await this.db.query<OutboxRow>(`select id, company_id, event_type, payload from ${sqlIdent(this.s)}.outbox where company_id = $1 and id > $2 order by id limit 100`, [companyId, cursor]);
    let done = 0;
    for (const e of rows) {
      try {
        await this.event(e);
        this.tries.delete(`${companyId}:${e.id}`);
      } catch (err) {
        const k = `${companyId}:${e.id}`;
        const n = (this.tries.get(k) ?? 0) + 1;
        this.tries.set(k, n);
        if (n < MAX_TRIES) {
          this.core.log('presence: mirror will retry', { outbox: e.id, type: e.event_type, attempt: n, e: String((err as Error)?.message ?? err).slice(0, 200) });
          break;
        }
        this.tries.delete(k);
        this.core.log('presence: mirror gave up on an event (the book keeps it; the room does not hear it)', { outbox: e.id, type: e.event_type, e: String((err as Error)?.message ?? err).slice(0, 200) });
      }
      await this.db.query(`update ${sqlIdent(this.s)}.presence_mirror set cursor = $2, updated_at = now() where company_id = $1 and cursor < $2`, [companyId, e.id]);
      done++;
    }
    return done;
  }

  /** Where a job was asked in Matrix: the event that opened it (a plain room message or a typed task). */
  private async origin(jobId: string | null): Promise<Origin | null> {
    if (!jobId) return null;
    // jobs.origin is the Matrix event id (t007), written with the job in one statement — so this holds even before
    // the inbound record learns its job id.
    const r = (
      await this.db.query<Origin & { type: string }>(
        `select e.account, e.room_id, e.road, e.type, e.event_id, e.typed_task_id from ${sqlIdent(this.s)}.jobs j join ${sqlIdent(this.s)}.inbound_events e on e.event_id = j.origin where j.id = $1`,
        [jobId],
      )
    ).rows[0];
    return r ? { ...r, typed: r.type === 'neos.neop.task' || r.type === 'neos.neop.ask', call: r.type === 'neos.neop.ask' } : null;
  }

  private async jobOf(p: any): Promise<string | null> {
    if (typeof p?.job_id === 'string') return p.job_id;
    if (typeof p?.proposal_id === 'string') return (await this.db.query<{ job_id: string }>(`select job_id from ${sqlIdent(this.s)}.proposals where id = $1`, [p.proposal_id])).rows[0]?.job_id ?? null;
    return null;
  }

  /** The room plain notices go to: the appservice room the job was asked in, else the company's own room. */
  private async plainRoom(companyId: string, o: Origin | null): Promise<{ road: Road; room: string } | null> {
    // v3 S6: a job asked over the bus room speaks there only in its typed thread; its plain story (the card a person
    // answers, the result) goes to the company's own room, as a desk job's does.
    if (o && (await this.identity.install(companyId))?.bus_room_id === o.room_id) o = null;
    if (o) {
      if (o.road !== 'appservice') return null; // a DM gets exactly one reply, from inbound
      const road = this.roadOf(o.account);
      return road && (await this.roomReady(road, o.room_id)) ? { road, room: o.room_id } : null;
    }
    const inst = await this.identity.install(companyId);
    const room = inst?.room_ids?.[0];
    if (!inst?.matrix_user || !room) return null;
    const road = this.roadOf(inst.matrix_user);
    return road && road.kind === 'appservice' && (await this.roomReady(road, room)) ? { road, room } : null;
  }

  private async event(e: OutboxRow): Promise<void> {
    const p = e.payload ?? {};
    const jobId = await this.jobOf(p);
    const o = await this.origin(jobId);
    const plain = await this.plainRoom(e.company_id, o);
    const thread = o?.typed ? this.roadOf(o.account) : null;
    const app = this.core.manifest.name;
    const say = (key: string, body: string, kind = 'notice', x: Parameters<Inbound['notice']>[5] = {}) => (plain ? this.inbound.notice(plain.road, plain.room, key, body, kind, { job_id: jobId, ...x }) : Promise.resolve(false));
    const tkey = (k: string) => `typed:${jobId}:${k}`;
    switch (e.event_type) {
      case 'job.acknowledged':
        await say(`ack:${p.job_id}`, `On it — ${app} job ${String(p.job_id).slice(0, 8)}.`, 'ack');
        if (thread && o) await this.inbound.typed(thread, o.room_id, tkey('note:ack'), 'neos.neop.note', { job_id: p.job_id, step_id: 'ack', text: 'on it' }, `On it — ${app} job ${String(p.job_id).slice(0, 8)}.`, o.event_id, { job_id: jobId });
        return;
      case 'step.mirror':
        if (PLAIN_STEP_SKIP.includes(p.kind)) return;
        await say(`step:${p.job_id}:${p.seq}`, `· ${p.summary}`, 'step');
        if (thread && o) await this.inbound.typed(thread, o.room_id, tkey(`note:${p.seq}`), 'neos.neop.note', { job_id: p.job_id, step_id: String(p.seq), text: clip(p.summary, 2000) || '·' }, `· ${p.summary}`, o.event_id, { job_id: jobId });
        return;
      case 'proposal.created': {
        const text = roomText.card(app, { card: p.card, args: p.args, expires_at: p.expires_at, fingerprint: p.fingerprint });
        const x = { proposal_id: p.proposal_id, fingerprint: p.fingerprint };
        await say(`card:${p.proposal_id}`, text, 'card', x);
        if (thread && o) {
          const expires = new Date(p.expires_at).toISOString();
          await this.inbound.typed(thread, o.room_id, tkey(`propose:${p.proposal_id}`), 'neos.neop.propose', { proposal_id: p.proposal_id, fingerprint: p.fingerprint, text: clip(text, 8000), expires }, text, o.event_id, { job_id: jobId, ...x });
        }
        return;
      }
      case 'proposal.resolved':
        await say(`resolved:${p.proposal_id}:${p.decision}`, roomText.resolved(p), 'answer');
        return;
      case 'proposal.expired':
        await say(`expired:${p.proposal_id}`, `Proposal ${String(p.proposal_id).slice(0, 8)} expired: nobody answered in time. Nothing was done.`);
        return;
      case 'proposal.executed':
        await say(`executed:${p.proposal_id}:${p.reconciled ? 'r' : 'x'}`, roomText.executed(p));
        return;
      case 'card.raised':
        await say(`cardraised:${e.id}`, `${p.kind === 'question' ? 'Question' : 'Heads-up'}: ${p.text}`);
        return;
      case 'question.asked': {
        const q = { text: String(p.text ?? ''), why: String(p.why ?? ''), fields: (p.fields ?? []) as QuestionField[], due_at: String(p.due_at ?? '') };
        const body = roomText.question(app, q);
        await say(`question:${p.wait_id}`, body, 'question', { wait_id: p.wait_id });
        if (thread && o && !o.call) {
          await this.inbound.typed(
            thread,
            o.room_id,
            tkey(`ask:${p.wait_id}`),
            'neos.neop.ask',
            { job_id: String(p.job_id), wait_id: p.wait_id, question: { text: clip(q.text, 2000), why: clip(q.why, 2000), fields: q.fields }, due: new Date(q.due_at).toISOString() },
            body,
            o.event_id,
            { job_id: jobId, wait_id: p.wait_id },
          );
        }
        return;
      }
      case 'task.completed':
      case 'task.failed': {
        const r: TaskResult = { outcome: 'failed', summary: 'The job did not finish.', changed: [], could_not: [], sources: [], ...(p.result ?? {}) };
        await say(`result:${p.job_id}`, roomText.result(app, r), 'result');
        if (thread && o && !o.call) {
          await this.inbound.typed(
            thread,
            o.room_id,
            tkey('done'),
            'neos.neop.done',
            {
              task_id: o.typed_task_id ?? String(p.task_id ?? p.job_id),
              job_id: String(p.job_id),
              result: { outcome: r.outcome, summary: r.summary, changed: r.changed ?? [], sources: r.sources ?? [] },
              could_not: (r.could_not ?? []).map((x) => clip(x, 2000)),
            },
            roomText.result(app, r),
            o.event_id,
            { job_id: jobId },
          );
        }
        return;
      }
      default:
        return;
    }
  }
}
