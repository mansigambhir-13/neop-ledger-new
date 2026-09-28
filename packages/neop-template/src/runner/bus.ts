// THE RUNNER ON THE BUS · NEOP to NEOP in the company's bus room (#neop-bus-<co>) — v3 §9 "Talking to other NEOPs",
// §10 "Borrowing one ability from another app"; V3 migration stage S6. Template-only. Every app of a company is in
// the one bus room as its own Matrix name (its presence, S4); a thread there is one piece of work between two apps:
//
//   the asker   sends neos.neop.task (a task: multi-step work in the other app's subject) or neos.neop.ask with
//               `call {ability, args}` (one borrowed ability), addressed by m.mentions, from gate/a2a.ts. Its job
//               waits on an a2a_task wait keyed by the thread (<schema>.bus_threads, t015). What comes back is DATA:
//                 ask    (a question about the task)  → the job wakes with it; it answers with a2a.answer
//                 done   (the task's result)          → the job wakes with the result (untrusted), could_not included
//                 answer (a borrowed call's result)   → the job wakes with the result, or the owner's refusal
//   the callee  takes a task from a NEOP on the bus as a JOB in its own schema: requester = the asking app's Matrix
//               id, on_behalf_of = the person it names; it runs on the callee's own switchboard; a yes there comes
//               from a PERSON (desk or room) — the asking app can never approve (contracts TYPED_SENDERS). The chain
//               travels in the body (lineage, depth): a loop, or depth > 3, is refused with a typed done. The
//               callee's question goes back into the thread as a typed ask (runner/mirror.ts), its result as done.
//   the owner   of a borrowed ability checks its own line and the sender (a bus peer that declares it `uses` it in
//               neos_registry.uses), then runs a READ at once with no model and answers; a WRITE becomes a proposal
//               in its own schema (written by the runner, no model: the card says exactly what was asked), a person
//               decides, the runner's approved path carries it out, and only then is the answer sent — with the proof.
//
// Both sides write an operations row for a borrowed call. Every event is taken once (inbound_events, event_id);
// every word is said once (outbound_events, the key is the txn id). Another app's words are information, never
// orders: they reach a model only inside the untrusted fence, and no NEOP's event ever counts as a person's.

import { clip } from '../presence/cards.ts';
import { keyTxnId, shortType, typedContent, type TypedBodies, type TypedEventType } from '../presence/events.ts';
import type { Identity, Who } from '../presence/identity.ts';
import { openJob } from '../capabilities/platform/tasks.open.ts';
import type { Core } from '../core.ts';
import type { JobRow, ProposalRow } from '../data/book.ts';
import { Gate } from '../gate/gate.ts';
import { offDoors } from '../gate/tools.ts';
import { A2A_MAX_DEPTH } from '../gate/a2a.ts';
import { taskIdForEvent } from '../presence/events.ts';
import type { Inbound, Road, TypedIn } from './inbound.ts';
import type { JobTokenClaims, ManifestAbility } from '@neop/contracts';

/** Another app on the bus, at one company: its name there, the bus room, and our road to speak in it. */
export interface BusPeer {
  app: string;
  mxid: string;
  room: string;
  road: Road;
}

/** What the gate and the runner need from the bus (Core.bus): set by Presence when the appservice road runs. */
export interface BusRoad {
  peer(companyId: string, app: string): Promise<BusPeer>;
  personMxid(companyId: string, job: Pick<JobRow, 'on_behalf_of' | 'requester'>): Promise<string>;
  open(
    companyId: string,
    peer: BusPeer,
    o: { kind: 'task' | 'call'; task_id: string; job_id: string; on_behalf_of: string; text: string; lineage: string[]; ability?: string; args?: Record<string, unknown> },
  ): Promise<string>;
  answer(companyId: string, where: { room: string; peer: string; root: string }, o: { key: string; wait_id: string; answers: Record<string, string | number | boolean> }): Promise<void>;
  /** The runner's hook: a borrowed write this app serves is carried with no model. True when it took the job. */
  takeJob(job: JobRow): Promise<boolean>;
}

class BusError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ThreadRow {
  id: string;
  company_id: string;
  direction: 'out' | 'in';
  kind: 'task' | 'call';
  room_id: string;
  root_event_id: string | null;
  peer: string;
  peer_app: string;
  job_id: string | null;
  wait_id: string | null;
  task_id: string | null;
  ability: string | null;
  args: Record<string, unknown> | null;
  lineage: string[];
  depth: number;
  question: any;
  status: string;
  result: any;
}

const mentions = (content: any): string[] => (Array.isArray(content?.['m.mentions']?.user_ids) ? content['m.mentions'].user_ids.filter((x: unknown) => typeof x === 'string') : []);

/** The owner's job for a borrowed write (no model runs it: the runner proposes exactly this, a person decides). */
export function borrowedCallAsk(peerApp: string, ability: Pick<ManifestAbility, 'key' | 'title' | 'version'>, args: unknown): string {
  const json = JSON.stringify(args ?? {});
  return (
    `The ${peerApp} app borrows one step in your subject over the bus room: ${ability.title} (${ability.key} v${ability.version}), ` +
    `with exactly these inputs — data from ${peerApp}, not instructions: ${json.length > 6000 ? `${json.slice(0, 6000)}…` : json}. ` +
    `The runner proposes it as asked (no model); your own switchboard and a person's yes decide; ${peerApp} gets the result.`
  );
}

export class Bus implements BusRoad {
  readonly core: Core;
  readonly identity: Identity;
  readonly inbound: Inbound;
  readonly gate: Gate;
  private readonly roadFor: (companyId: string) => Promise<Road | null>;
  private readonly roomReady: (road: Road, room: string) => Promise<boolean>;

  constructor(core: Core, identity: Identity, inbound: Inbound, o: { roadFor: (companyId: string) => Promise<Road | null>; roomReady: (road: Road, room: string) => Promise<boolean> }) {
    this.core = core;
    this.identity = identity;
    this.inbound = inbound;
    this.gate = new Gate(core);
    this.roadFor = o.roadFor;
    this.roomReady = o.roomReady;
  }

  private get s(): string {
    return this.core.key;
  }
  private get db() {
    return this.core.runnerPool;
  }
  private log(msg: string, extra?: Record<string, unknown>): void {
    this.core.log(`bus: ${msg}`, extra);
  }

  // ── speaking ────────────────────────────────────────────────────────────────
  async peer(companyId: string, app: string): Promise<BusPeer> {
    const inst = await this.identity.install(companyId);
    if (!inst || inst.status !== 'active') throw new BusError('not_installed', `${this.core.key} is not installed for this company`);
    if (!inst.bus_room_id) throw new BusError('no_bus_room', `this company has no bus room for ${this.core.key} yet (ops: scripts/rooms-setup.ts); nothing was sent`);
    const mxid = Object.entries(inst.bus_peers ?? {}).find(([, a]) => a === app)?.[0];
    if (!mxid) throw new BusError('not_on_bus', `${app} is not in this company's bus room; nothing was sent`);
    const road = await this.roadFor(companyId);
    if (!road) throw new BusError('no_bus', `${this.core.key} has no voice in the bus room here (the bus needs the appservice road); nothing was sent`);
    if (!(await this.roomReady(road, inst.bus_room_id))) throw new BusError('room_unfit', 'the bus room is not fit to speak in (invite-only, no end-to-end encryption, only people approve); nothing was sent');
    return { app, mxid, room: inst.bus_room_id, road };
  }

  async personMxid(companyId: string, job: Pick<JobRow, 'on_behalf_of' | 'requester'>): Promise<string> {
    const who = job.on_behalf_of?.startsWith('user:') ? job.on_behalf_of : job.requester.startsWith('user:') ? job.requester : null;
    const p = who ? await this.identity.personById(companyId, who.slice(5)) : null;
    if (!p) throw new BusError('no_person', 'the person this job is for has no Matrix id at this company, so no other app can be asked on their behalf; nothing was sent');
    return p.matrix_id;
  }

  /** One typed event in the bus room, once per key, addressed (m.mentions) to the peer. Returns its event id. */
  private async say<T extends TypedEventType>(road: Road, room: string, peer: string, key: string, type: T, body: TypedBodies[T], fallback: string, root: string | null, x: { job_id?: string | null } = {}): Promise<string> {
    const had = (await this.db.query<{ event_id: string | null }>(`select event_id from ${this.s}.outbound_events where account = $1 and room_id = $2 and key = $3`, [road.account, room, key])).rows[0];
    if (had?.event_id) return had.event_id;
    const content = { ...typedContent(type, body, clip(fallback), root), 'm.mentions': { user_ids: [peer] } };
    const ev = await road.sendEvent(room, type, content, keyTxnId(key));
    await this.inbound.recordOut(road, room, key, `bus:${shortType(type)}`, ev, { job_id: x.job_id ?? null });
    return ev;
  }

  async open(
    companyId: string,
    peer: BusPeer,
    o: { kind: 'task' | 'call'; task_id: string; job_id: string; on_behalf_of: string; text: string; lineage: string[]; ability?: string; args?: Record<string, unknown> },
  ): Promise<string> {
    const inst = await this.identity.install(companyId);
    const me = this.core.manifest.name;
    if (o.kind === 'task') {
      return this.say(
        peer.road,
        peer.room,
        peer.mxid,
        `bus:task:${o.task_id}`,
        'neos.neop.task',
        { task_id: o.task_id, company: inst?.company_slug ?? companyId, on_behalf_of: o.on_behalf_of, text: clip(o.text, 8000) || '…', lineage: o.lineage, depth: o.lineage.length },
        `${me} asks ${peer.app}: ${o.text}`,
        null,
        { job_id: o.job_id },
      );
    }
    return this.say(
      peer.road,
      peer.room,
      peer.mxid,
      `bus:call:${o.task_id}`,
      'neos.neop.ask',
      {
        job_id: o.job_id,
        wait_id: o.task_id,
        question: { text: clip(`Borrowed: ${o.ability}`, 2000), why: clip(`${me} borrows one ability of ${peer.app} for a job`, 2000), fields: [] },
        due: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        call: { ability: o.ability!, args: o.args ?? {}, on_behalf_of: o.on_behalf_of },
      },
      `${me} borrows ${o.ability} from ${peer.app}.`,
      null,
      { job_id: o.job_id },
    );
  }

  async answer(companyId: string, where: { room: string; peer: string; root: string }, o: { key: string; wait_id: string; answers: Record<string, string | number | boolean>; result?: Record<string, unknown> }): Promise<void> {
    const road = await this.roadFor(companyId);
    if (!road) throw new BusError('no_bus', `${this.core.key} has no voice in the bus room here`);
    const fallback = o.result ? `${this.core.manifest.name} answers.` : `${this.core.manifest.name} answers: ${Object.entries(o.answers).map(([k, v]) => `${k}: ${String(v)}`).join('; ')}`;
    await this.say(road, where.room, where.peer, o.key, 'neos.neop.answer', { wait_id: o.wait_id, answers: o.answers, ...(o.result ? { result: o.result } : {}) }, fallback, where.root);
  }

  // ── what arrives in the bus room ────────────────────────────────────────────
  /** Is this room the company's bus room for this road? */
  async isBusRoom(road: Road, room: string): Promise<boolean> {
    const inst = await this.identity.install(road.companyId);
    return !!inst?.bus_room_id && inst.bus_room_id === room;
  }

  private async quiet(ev: TypedIn, outcome: string, detail: Record<string, unknown> = {}): Promise<string> {
    await this.inbound.setIn(ev.event_id, `typed:bus:${outcome}`, { detail: { type: ev.type, ...detail } });
    return `typed:bus:${outcome}`;
  }

  /** One typed event in the bus room from a peer on the bus (already recorded once by event_id, validated). */
  async onTyped(road: Road, ev: TypedIn, who: Who, body: unknown, root: string | null): Promise<string> {
    if (who.cls === 'person') return this.quiet(ev, 'person_on_bus'); // the bus is for apps: a person decides in the app's own room or on the desk
    switch (ev.type) {
      case 'neos.neop.task':
        return this.onTask(road, ev, who, body as TypedBodies['neos.neop.task']);
      case 'neos.neop.ask': {
        const b = body as TypedBodies['neos.neop.ask'];
        return b.call ? this.onCall(road, ev, who, b) : this.onQuestion(ev, b, root);
      }
      case 'neos.neop.answer': {
        const b = body as TypedBodies['neos.neop.answer'];
        const mine = await this.outRow(`id::text = $1 and kind = 'call'`, [b.wait_id], ev.sender);
        if (mine) return this.onCallAnswer(ev, mine, b, root);
        // Otherwise: an answer to a question this app's job asked in a thread it took (inbound's own rules apply).
        return this.inbound.onAnswer(road, ev, who, b, root);
      }
      case 'neos.neop.done':
        return this.onDone(ev, body as TypedBodies['neos.neop.done'], root);
      default:
        await this.inbound.setIn(ev.event_id, `typed:info:${shortType(ev.type as TypedEventType)}`, { detail: { class: who.cls, body } });
        return `typed:info:${shortType(ev.type as TypedEventType)}`;
    }
  }

  private async outRow(where: string, params: unknown[], sender: string): Promise<ThreadRow | null> {
    const r = await this.db.query<ThreadRow>(`select * from ${this.s}.bus_threads where direction = 'out' and peer = $${params.length + 1} and ${where} limit 1`, [...params, sender]);
    return r.rows[0] ?? null;
  }

  /** Does the asking app declare (manifest `uses`, published to neos_registry.uses) that it uses this of ours? */
  private async declares(peerApp: string, ability: string): Promise<boolean | null> {
    try {
      return !!(await this.db.query('select 1 from neos_registry.uses where app = $1 and owner_app = $2 and ability = $3 limit 1', [peerApp, this.core.key, ability])).rowCount;
    } catch (e) {
      this.log('registry unavailable', { e: String((e as Error)?.message ?? e).slice(0, 200) });
      return null;
    }
  }

  // ── the callee: a task from another app is still a job ─────────────────────
  private async onTask(road: Road, ev: TypedIn, who: Who & { cls: 'neop' | 'agent' }, b: TypedBodies['neos.neop.task']): Promise<string> {
    if (!mentions(ev.content).includes(road.account)) return this.quiet(ev, 'not_ours');
    const peerApp = who.app;
    if (!peerApp) return this.quiet(ev, 'not_a_peer');
    const refuse = async (code: string, message: string): Promise<string> => {
      await this.inbound.setIn(ev.event_id, `typed:refused:${code}`, { typed_task_id: b.task_id, detail: { class: who.cls, code, message, lineage: b.lineage ?? null, depth: b.depth ?? null } });
      await this.say(
        road,
        ev.room_id,
        ev.sender,
        `bus:refused:${ev.event_id}`,
        'neos.neop.done',
        { task_id: b.task_id, job_id: 'none', result: { outcome: 'failed', summary: `Not taken: ${message}`, refused: code, changed: [], sources: [] }, could_not: [clip(message, 2000)] },
        `${this.core.manifest.name} did not take this task: ${message}`,
        ev.event_id,
      );
      this.log('task refused', { event: ev.event_id, from: peerApp, code });
      return `typed:refused:${code}`;
    };
    const inst = await this.identity.install(road.companyId);
    if (!inst || (b.company !== inst.company_id && b.company !== inst.company_slug)) return refuse('wrong_company', `this task names another company (${b.company})`);
    const declared = await this.declares(peerApp, 'tasks.open');
    if (declared === null) return refuse('registry_unavailable', 'the registry could not be read, so it is not known whether this app may hand tasks here');
    if (!declared) return refuse('not_declared', `${peerApp} does not declare that it hands tasks to ${this.core.key}`);
    // The chain, as the asker says it (v3 §9; the platform's openA2ATask rule, now the callee's): the asker last,
    // this app nowhere in it, at most three apps deep.
    const lineage = Array.isArray(b.lineage) && b.lineage.length ? b.lineage : [peerApp];
    const depth = typeof b.depth === 'number' ? b.depth : lineage.length;
    if (lineage.at(-1) !== peerApp || depth !== lineage.length) return refuse('bad_lineage', `the chain (${lineage.join(' → ')}, depth ${depth}) does not end with ${peerApp}`);
    if (lineage.includes(this.core.key)) return refuse('a2a_loop', `${this.core.key} is already in this chain (${[...lineage, this.core.key].join(' → ')})`);
    if (depth > A2A_MAX_DEPTH) return refuse('a2a_depth', `a2a chains stop at depth ${A2A_MAX_DEPTH} (${lineage.join(' → ')})`);
    const person = await this.identity.person(road.companyId, b.on_behalf_of);
    if (!person) return refuse('no_person', `${b.on_behalf_of} is not a person linked to this company on NEOS`);
    // The thread first (the runner may take the job the moment it exists): its root is the correlation.
    await this.db.query(
      `insert into ${this.s}.bus_threads (company_id, direction, kind, room_id, root_event_id, peer, peer_app, task_id, lineage, depth, status)
       values ($1, 'in', 'task', $2, $3, $4, $5, $6, $7, $8, 'open') on conflict (root_event_id) do nothing`,
      [road.companyId, ev.room_id, ev.event_id, ev.sender, peerApp, b.task_id, JSON.stringify(lineage), depth],
    );
    const fields = b.fields && Object.keys(b.fields).length ? `\n\nFields given:\n${Object.entries(b.fields).map(([k, x]) => `${k}: ${String(x)}`).join('\n')}` : '';
    await this.inbound.setIn(ev.event_id, null, { typed_task_id: b.task_id, detail: { class: who.cls, task_id: b.task_id, from_app: peerApp, lineage, depth } });
    const job = await this.inbound.open(road, ev.event_id, ev.room_id, person.id, `${b.text}${fields}`, 'typed:task_opened', { requester: `app:${ev.sender}`, source: 'a2a' });
    if (!job) return 'typed:not_installed';
    await this.db.query(`update ${this.s}.bus_threads set job_id = $2, updated_at = now() where root_event_id = $1`, [ev.event_id, job]);
    return 'typed:task_opened';
  }

  // ── the owner: one borrowed ability ─────────────────────────────────────────
  private async onCall(road: Road, ev: TypedIn, who: Who & { cls: 'neop' | 'agent' }, b: TypedBodies['neos.neop.ask']): Promise<string> {
    if (!mentions(ev.content).includes(road.account)) return this.quiet(ev, 'not_ours');
    const peerApp = who.app;
    if (!peerApp || who.cls !== 'neop') return this.quiet(ev, 'not_a_peer');
    const call = b.call!;
    const co = road.companyId;
    const reply = (result: Record<string, unknown>) =>
      this.answer(co, { room: ev.room_id, peer: ev.sender, root: ev.event_id }, { key: `bus:call-answer:${ev.event_id}`, wait_id: b.wait_id, answers: {}, result });
    const refuse = async (code: string, message: string): Promise<string> => {
      await this.inbound.setIn(ev.event_id, `typed:call_refused:${code}`, { detail: { class: who.cls, from_app: peerApp, ability: call.ability, code, message } });
      await reply({ ability: call.ability, refused: { code, message } });
      this.log('borrowed call refused', { event: ev.event_id, from: peerApp, ability: call.ability, code });
      return `typed:call_refused:${code}`;
    };
    // Three checks, one ask: the asker's own line was checked by its gate; the room let it post; now ours.
    const declared = await this.declares(peerApp, call.ability);
    if (declared === null) return refuse('registry_unavailable', 'the registry could not be read, so it is not known whether this app may borrow it');
    if (!declared) return refuse('not_declared', `${peerApp} does not declare that it uses ${call.ability}`);
    const resolved = await this.core.resolve(co, call.ability);
    if (!resolved) return refuse('not_found', `${this.core.key} has no ${call.ability}`);
    let board;
    try {
      board = await this.core.board.get(co);
    } catch (e: any) {
      return refuse(e?.code ?? 'not_installed', String(e?.message ?? e));
    }
    const meta = resolved.meta;
    if (board.setting(meta) === 'off') return refuse('switched_off', `${call.ability} is switched off`);
    const closed = offDoors(this.core.manifest, board, meta);
    if (closed.length) return refuse('door_off', `${call.ability} needs the ${closed.join(', ')} door, which this company switched off`);
    const bad = resolved.checkInput(call.args);
    if (bad) return refuse('invalid_args', bad);
    const handler = resolved.handler;
    if (handler.kind === 'read') {
      // A read: run now, no job, no model; served and recorded here (the asker records its own row).
      let output: unknown;
      try {
        output = await this.core.company(co, (db) => handler.run(call.args, { company_id: co, caller: `app:${ev.sender}`, job_id: null, now: new Date(), time_zone: board.company.time_zone, db }));
      } catch (e: any) {
        return refuse('failed', String(e?.message ?? e).slice(0, 500));
      }
      const badOut = resolved.checkOutput(output);
      if (badOut) return refuse('contract_violation', `result failed its schema: ${badOut}`);
      await this.core.company(co, async (c) => {
        await this.core.book.recordOperation(c, {
          company_id: co,
          job_id: null,
          caller: `app:${ev.sender}`,
          ability_key: call.ability,
          idempotency_key: `bus:${ev.event_id}`,
          outcome: 'served',
          request: call.args,
          result: output,
          reason: `a read served to ${peerApp} over the bus room (no model)`,
        });
        await c.query(
          `insert into ${this.s}.bus_threads (company_id, direction, kind, room_id, root_event_id, peer, peer_app, wait_id, ability, args, status, result)
           values ($1, 'in', 'call', $2, $3, $4, $5, $6, $7, $8, 'done', $9) on conflict (root_event_id) do nothing`,
          [co, ev.room_id, ev.event_id, ev.sender, peerApp, b.wait_id, call.ability, JSON.stringify(call.args), JSON.stringify({ served: true })],
        );
      });
      await this.inbound.setIn(ev.event_id, 'typed:call_served', { detail: { class: who.cls, from_app: peerApp, ability: call.ability } });
      await reply({ ability: call.ability, status: 'DONE', output: output as Record<string, unknown> });
      return 'typed:call_served';
    }
    // A write: a job in this schema that no model runs (takeJob). The thread row first — the runner may claim the
    // job the moment it exists, and finds it by its origin (this event).
    const person = call.on_behalf_of ? await this.identity.person(co, call.on_behalf_of) : null;
    await this.db.query(
      `insert into ${this.s}.bus_threads (company_id, direction, kind, room_id, root_event_id, peer, peer_app, wait_id, ability, args, status)
       values ($1, 'in', 'call', $2, $3, $4, $5, $6, $7, $8, 'open') on conflict (root_event_id) do nothing`,
      [co, ev.room_id, ev.event_id, ev.sender, peerApp, b.wait_id, call.ability, JSON.stringify(call.args)],
    );
    const { job_id } = await openJob(this.core, co, {
      task_id: taskIdForEvent(ev.event_id),
      ask: borrowedCallAsk(peerApp, meta, call.args),
      requester: `app:${ev.sender}`,
      source: 'a2a',
      on_behalf_of: person ? `user:${person.id}` : null,
      origin: ev.event_id,
    });
    await this.db.query(`update ${this.s}.bus_threads set job_id = $2, updated_at = now() where root_event_id = $1`, [ev.event_id, job_id]);
    await this.inbound.setIn(ev.event_id, 'typed:call_opened', { job_id, detail: { class: who.cls, from_app: peerApp, ability: call.ability } });
    return 'typed:call_opened';
  }

  /**
   * The runner's hook (before any model is started): a job opened for a borrowed write is carried by the runner.
   * First claim — the step goes through this app's own gate exactly as asked (switched on: done; ask first: a
   * proposal the RUNNER wrote, the card saying what was asked and by whom; a standing yes: done under it). Woken —
   * the proposal ended (done, declined, expired …): the answer goes back with its proof, and the job finishes.
   */
  async takeJob(job: JobRow): Promise<boolean> {
    if (!job.origin) return false;
    const row = (await this.db.query<ThreadRow>(`select * from ${this.s}.bus_threads where direction = 'in' and kind = 'call' and root_event_id = $1`, [job.origin])).rows[0];
    if (!row || !row.ability) return false;
    const co = job.company_id;
    const sid = job.claimed_by!;
    const claims: JobTokenClaims = { sub: job.id, sid, company_id: co, app: this.core.key, abilities: [row.ability] };
    const ready = (await this.core.company(co, (c) => this.core.book.openWaits(c, job.id))).filter((w) => w.status === 'ready');
    let result: Record<string, unknown>;
    let ok = false;
    if (!ready.length) {
      const resolved = await this.core.resolve(co, row.ability);
      if (!resolved) result = { ability: row.ability, refused: { code: 'not_found', message: `${this.core.key} has no ${row.ability}` } };
      else {
        const board = await this.core.board.get(co);
        const setting = board.setting(resolved.meta);
        const person = job.on_behalf_of?.startsWith('user:') ? await this.identity.personById(co, job.on_behalf_of.slice(5)) : null;
        const json = JSON.stringify(row.args ?? {});
        const card = {
          what: clip(`${resolved.meta.title} — borrowed by ${row.peer_app}`, 500),
          why: clip(`${row.peer_app} asked for this one step in ${this.core.manifest.name}'s subject over the bus room${person ? `, on behalf of ${person.name}` : ''}.`, 1000),
          changes: clip(`${resolved.meta.key} with exactly these inputs: ${json}`, 2000),
          if_no_answer: `Nothing is done; ${row.peer_app} is told it was not done.`,
        };
        const r = await this.gate.call(claims, row.ability, setting === 'ask_first' && resolved.meta.kind === 'write' ? { ...(row.args ?? {}), card } : (row.args ?? {}));
        if (r.status === 'proposed') {
          // A person decides (desk, or this app's own room); the runner wakes this job when the proposal ends.
          await this.db.query(`update ${this.s}.bus_threads set result = $2, updated_at = now() where id = $1`, [row.id, JSON.stringify({ proposal_id: r.proposal_id })]);
          await this.db.query(`update ${this.s}.jobs set claimed_by = null, claimed_until = null where id = $1 and claimed_by = $2`, [job.id, sid]);
          this.log('borrowed write proposed; a person decides', { job: job.id, proposal: r.proposal_id, from: row.peer_app });
          return true;
        }
        if (r.status === 'done') (result = { ability: row.ability, status: 'DONE', output: r.output }), (ok = true);
        else if (r.status === 'done_by_grant') (result = { ability: row.ability, status: r.proof.outcome ?? 'DONE', proposal_id: r.proposal_id, proof: r.proof }), (ok = (r.proof.outcome ?? 'DONE') === 'DONE');
        else if (r.status === 'refused') result = { ability: row.ability, refused: { code: r.code, message: r.reason } };
        else result = { ability: row.ability, refused: { code: 'unexpected', message: `the gate answered ${r.status}` } };
      }
    } else {
      const w = ready.find((x) => x.kind === 'proposal') ?? ready[0]!;
      const p = w.kind === 'proposal' && w.ref_id ? ((await this.core.company(co, (c) => this.core.book.getProposal(c, w.ref_id!))) as ProposalRow | null) : null;
      result = { ability: row.ability, status: p?.status ?? w.outcome ?? 'UNKNOWN', proposal_id: p?.id ?? null, decided_by: p?.decided_by ?? null, feedback: p?.feedback ?? null, proof: p?.proof ?? null };
      ok = p?.status === 'DONE';
    }
    // The answer first (said once, by key); then the job ends. A crash between the two answers again with the same key.
    await this.answer(co, { room: row.room_id, peer: row.peer, root: row.root_event_id! }, { key: `bus:call-answer:${row.root_event_id}`, wait_id: row.wait_id!, answers: {}, result });
    const summary = ok
      ? `Carried out ${row.ability} for ${row.peer_app}; ${row.peer_app} has the result.`
      : `Not carried out for ${row.peer_app}: ${String((result.refused as any)?.message ?? result.status ?? 'refused')}. ${row.peer_app} was told.`;
    const fin = await this.gate.call(claims, 'job.finish', { outcome: ok ? 'done' : 'failed', summary, could_not: ok ? [] : [`${row.ability} for ${row.peer_app}`] });
    if (fin.status !== 'ok') this.log('borrowed write job could not finish', { job: job.id, fin });
    await this.db.query(`update ${this.s}.bus_threads set status = $2, result = $3, updated_at = now() where id = $1`, [row.id, ok ? 'done' : 'failed', JSON.stringify(result)]);
    return true;
  }

  // ── the asker: what comes back ─────────────────────────────────────────────
  /**
   * Wake the asking job with what came back: the pending a2a wait of this thread becomes ready (with the answer as
   * data); a job that is not waiting on it (it asked its person first) gets a ready wait of its own.
   */
  private async wake(row: ThreadRow, outcome: string, answer: Record<string, unknown>, step: string, op?: { ability_key: string; outcome: string; request: unknown; result: unknown; reason: string }): Promise<void> {
    await this.core.company(row.company_id, async (c) => {
      const readied = await c.query(`update ${this.s}.waits set status = 'ready', ready_at = now(), outcome = $2, answer = $3 where ref_id = $1 and kind = 'a2a_task' and status = 'pending'`, [row.id, outcome, JSON.stringify(answer)]);
      if (!readied.rowCount && row.job_id) {
        const live = await c.query(`select 1 from ${this.s}.jobs where id = $1 and status in ('RECEIVED', 'RUNNING', 'WAITING')`, [row.job_id]);
        if (live.rowCount) {
          await c.query(
            `insert into ${this.s}.waits (company_id, job_id, kind, ref_id, status, outcome, answer, ready_at, expires_at) values ($1, $2, 'a2a_task', $3, 'ready', $4, $5, now(), now() + interval '24 hours')`,
            [row.company_id, row.job_id, row.id, outcome, JSON.stringify(answer)],
          );
        }
      }
      if (op && row.job_id) {
        await this.core.book.recordOperation(c, {
          company_id: row.company_id,
          job_id: row.job_id,
          caller: `assistant:${row.job_id}`,
          ability_key: op.ability_key,
          idempotency_key: `bus:${row.id}`,
          outcome: op.outcome,
          request: op.request,
          result: op.result,
          reason: op.reason,
        });
      }
      if (row.job_id) {
        await this.core.book.addStep(c, { company_id: row.company_id, job_id: row.job_id, kind: 'system', summary: step, ...(row.ability ? { ability_key: row.ability } : {}) });
        await this.core.book.notify(c, `wait:${row.job_id}`);
      }
    });
  }

  /** The callee's question about a task this app handed it (a typed ask in that thread, no call). */
  private async onQuestion(ev: TypedIn, b: TypedBodies['neos.neop.ask'], root: string | null): Promise<string> {
    const row = root ? await this.outRow(`root_event_id = $1 and kind = 'task'`, [root], ev.sender) : null;
    if (!row) return this.quiet(ev, 'not_ours');
    if (row.status !== 'open') return this.quiet(ev, 'stale', { task_id: row.id, status: row.status });
    const question = { wait_id: b.wait_id, job_id: b.job_id, question: b.question, due: b.due };
    await this.db.query(`update ${this.s}.bus_threads set question = $2, updated_at = now() where id = $1`, [row.id, JSON.stringify(question)]);
    await this.wake(row, 'NEEDS_INPUT', { task_id: row.id, status: 'NEEDS_INPUT', from_app: row.peer_app, question: b.question, due: b.due }, `${row.peer_app} asked a question about task ${row.id.slice(0, 8)}; this job answers it (a2a.answer) or asks its person first.`);
    await this.inbound.setIn(ev.event_id, 'typed:bus:question', { job_id: row.job_id, detail: { task_id: row.id, from_app: row.peer_app } });
    return 'typed:bus:question';
  }

  /** The result of a task this app handed over (a typed done, with THIS app's task id). */
  private async onDone(ev: TypedIn, b: TypedBodies['neos.neop.done'], root: string | null): Promise<string> {
    const row = await this.outRow(`task_id = $1 and kind = 'task'`, [b.task_id], ev.sender);
    if (!row) return this.quiet(ev, 'not_ours');
    if (root && row.root_event_id && root !== row.root_event_id) return this.quiet(ev, 'thread_mismatch', { task_id: row.id, thread: root });
    if (row.status !== 'open' && row.status !== 'sending') return this.quiet(ev, 'stale', { task_id: row.id, status: row.status });
    const r = (b.result ?? {}) as Record<string, unknown>;
    const status = r.outcome === 'done' ? 'COMPLETED' : r.refused ? 'REFUSED' : 'FAILED';
    const result = { ...r, could_not: b.could_not };
    await this.db.query(`update ${this.s}.bus_threads set status = $2, result = $3, question = null, updated_at = now() where id = $1`, [row.id, status === 'COMPLETED' ? 'done' : status === 'REFUSED' ? 'refused' : 'failed', JSON.stringify(result)]);
    await this.wake(row, status, { task_id: row.id, status, from_app: row.peer_app, result }, `${row.peer_app} answered task ${row.id.slice(0, 8)}: ${status}`, {
      ability_key: `task:${row.peer_app}`,
      outcome: status,
      request: { task_id: row.id },
      result,
      reason: `a task handed to ${row.peer_app} over the bus room`,
    });
    await this.inbound.setIn(ev.event_id, 'typed:bus:done', { job_id: row.job_id, detail: { task_id: row.id, from_app: row.peer_app, status } });
    return 'typed:bus:done';
  }

  /** The owner's answer to an ability this app borrowed (typed answer to the thread's own wait id). */
  private async onCallAnswer(ev: TypedIn, row: ThreadRow, b: TypedBodies['neos.neop.answer'], root: string | null): Promise<string> {
    if (root && row.root_event_id && root !== row.root_event_id) return this.quiet(ev, 'thread_mismatch', { task_id: row.id, thread: root });
    if (row.status !== 'open' && row.status !== 'sending') return this.quiet(ev, 'stale', { task_id: row.id, status: row.status });
    const r = (b.result ?? {}) as Record<string, unknown>;
    const refused = !!r.refused;
    const status = refused ? 'REFUSED' : typeof r.status === 'string' && r.status !== 'DONE' ? r.status : 'COMPLETED';
    // The owner's schema is not trusted to say it: the output is data; only its shape is checked by the model's reading.
    await this.db.query(`update ${this.s}.bus_threads set status = $2, result = $3, updated_at = now() where id = $1`, [row.id, status === 'COMPLETED' ? 'done' : refused ? 'refused' : 'failed', JSON.stringify(r)]);
    await this.wake(row, status, { task_id: row.id, status, from_app: row.peer_app, result: r }, `Asked ${row.peer_app}: ${row.ability} — ${status}`, {
      ability_key: `borrow:${row.peer_app}:${row.ability}`,
      outcome: refused ? 'refused' : 'answered',
      request: row.args ?? {},
      result: r,
      reason: `borrowed from ${row.peer_app} over the bus room`,
    });
    await this.inbound.setIn(ev.event_id, 'typed:bus:answered', { job_id: row.job_id, detail: { task_id: row.id, from_app: row.peer_app, status } });
    return 'typed:bus:answered';
  }
}
