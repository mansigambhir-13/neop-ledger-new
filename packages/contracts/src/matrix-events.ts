// v3 §8 · TYPED MATRIX EVENTS. Every request, question, answer, card, yes and result between agents can travel
// as a typed Matrix event in a thread rooted at the task event. This is an ADDITIONAL, stricter road on top of
// the plain-text road (m.text in, m.notice out) — it never replaces it, and it changes nothing about who may do
// what: every inbound still becomes a signed gateway call, only a person approves, and outside text is data.
//
//   neos.neop.task     people · reasoning agent · NEOPs   task_id · company · on_behalf_of · text · fields?
//   neos.neop.ask      NEOPs                              job_id · wait_id · question {text, why, fields[]} · due
//   neos.neop.answer   people · reasoning agent · NEOPs   wait_id · answers{}
//   neos.neop.propose  NEOPs                              proposal_id · fingerprint · text (the card) · expires
//   neos.neop.approve  PEOPLE ONLY                        proposal_id · fingerprint · decision · feedback?
//   neos.neop.done     NEOPs                              task_id · job_id · result · could_not
//   neos.neop.note     NEOPs                              job_id · step_id · text
//
// Matrix does not validate bodies and does redeliver: the receiver validates every body against the schema for
// its type (a body that fails is dropped and audited) and dedupes on event_id. The envelope keys a plain client
// needs — `body`/`msgtype` (the m.notice text fallback), `format`/`formatted_body` and `m.relates_to` (the
// thread) — ride alongside and are not part of the typed body.

export const TYPED_EVENT_TYPES = [
  'neos.neop.task',
  'neos.neop.ask',
  'neos.neop.answer',
  'neos.neop.propose',
  'neos.neop.approve',
  'neos.neop.done',
  'neos.neop.note',
] as const;
export type TypedEventType = (typeof TYPED_EVENT_TYPES)[number];
export type TypedEventShort = 'task' | 'ask' | 'answer' | 'propose' | 'approve' | 'done' | 'note';

export const isTypedEventType = (t: unknown): t is TypedEventType => typeof t === 'string' && (TYPED_EVENT_TYPES as readonly string[]).includes(t);
export const shortType = (t: TypedEventType): TypedEventShort => t.slice('neos.neop.'.length) as TypedEventShort;

/** Who is writing, by class. People answer and approve; the reasoning agent never approves; NEOPs never approve. */
export type SenderClass = 'person' | 'agent' | 'neop';

/** v3 §8 "Who may send": the runner's fail-safe check, whatever the room's power levels say. */
export const TYPED_SENDERS: Record<SenderClass, readonly TypedEventShort[]> = {
  person: ['task', 'answer', 'approve'],
  agent: ['task', 'answer'],
  neop: ['task', 'ask', 'answer', 'propose', 'done', 'note'],
};

export function maySend(cls: SenderClass, type: TypedEventType): boolean {
  return TYPED_SENDERS[cls].includes(shortType(type));
}

// ── bodies ───────────────────────────────────────────────────────────────────
export interface TypedTaskBody {
  task_id: string;
  company: string;
  on_behalf_of: string;
  text: string;
  fields?: Record<string, unknown>;
}
export interface TypedAskBody {
  job_id: string;
  wait_id: string;
  question: { text: string; why: string; fields: { key: string; label: string; type?: string; required?: boolean }[] };
  due: string;
}
export interface TypedAnswerBody {
  wait_id: string;
  answers: Record<string, string | number | boolean>;
}
export interface TypedProposeBody {
  proposal_id: string;
  fingerprint: string;
  text: string;
  expires: string;
}
export interface TypedApproveBody {
  proposal_id: string;
  fingerprint: string;
  decision: 'yes' | 'no' | 'change' | 'withdraw';
  feedback?: string;
}
export interface TypedDoneBody {
  task_id: string;
  job_id: string;
  result: Record<string, unknown>;
  could_not: string[];
}
export interface TypedNoteBody {
  job_id: string;
  step_id: string;
  text: string;
}
export interface TypedBodies {
  'neos.neop.task': TypedTaskBody;
  'neos.neop.ask': TypedAskBody;
  'neos.neop.answer': TypedAnswerBody;
  'neos.neop.propose': TypedProposeBody;
  'neos.neop.approve': TypedApproveBody;
  'neos.neop.done': TypedDoneBody;
  'neos.neop.note': TypedNoteBody;
}

// ── JSON Schemas (draft 2020-12 subset; checked by validateTypedBody below, no dependency) ──────────────────
type Schema = {
  type?: 'object' | 'string' | 'array' | 'number' | 'boolean';
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  maxProperties?: number;
  pattern?: string;
  enum?: readonly string[];
  anyOf?: readonly Schema[];
};

const ID = { type: 'string', minLength: 1, maxLength: 200 } as const;
const MXID = { type: 'string', pattern: '^@[^:\\s]+:\\S+$', maxLength: 255 } as const;
const TEXT = (n: number) => ({ type: 'string', minLength: 1, maxLength: n }) as const;
const TIME = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$', maxLength: 40 } as const;
const SCALAR = { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }] } as const;

export const TYPED_EVENT_SCHEMAS: Record<TypedEventType, Schema & { $id: string; title: string }> = {
  'neos.neop.task': {
    $id: 'neos.neop.task',
    title: 'A task: opens a job; the thread is rooted at this event',
    type: 'object',
    required: ['task_id', 'company', 'on_behalf_of', 'text'],
    additionalProperties: false,
    properties: { task_id: ID, company: ID, on_behalf_of: MXID, text: TEXT(8000), fields: { type: 'object', maxProperties: 20, additionalProperties: SCALAR } },
  },
  'neos.neop.ask': {
    $id: 'neos.neop.ask',
    title: "A job's question: the asker's job waits on wait_id",
    type: 'object',
    required: ['job_id', 'wait_id', 'question', 'due'],
    additionalProperties: false,
    properties: {
      job_id: ID,
      wait_id: ID,
      due: TIME,
      question: {
        type: 'object',
        required: ['text', 'why', 'fields'],
        additionalProperties: false,
        properties: {
          text: TEXT(2000),
          why: TEXT(2000),
          fields: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              required: ['key', 'label'],
              additionalProperties: false,
              properties: { key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' }, label: TEXT(200), type: { type: 'string', enum: ['text', 'number', 'date', 'boolean'] }, required: { type: 'boolean' } },
            },
          },
        },
      },
    },
  },
  'neos.neop.answer': {
    $id: 'neos.neop.answer',
    title: 'An answer to an open wait; a closed wait is stale',
    type: 'object',
    required: ['wait_id', 'answers'],
    additionalProperties: false,
    properties: { wait_id: ID, answers: { type: 'object', maxProperties: 10, additionalProperties: SCALAR } },
  },
  'neos.neop.propose': {
    $id: 'neos.neop.propose',
    title: 'The card: what a yes would carry out, bound to its fingerprint',
    type: 'object',
    required: ['proposal_id', 'fingerprint', 'text', 'expires'],
    additionalProperties: false,
    properties: { proposal_id: ID, fingerprint: TEXT(200), text: TEXT(8000), expires: TIME },
  },
  'neos.neop.approve': {
    $id: 'neos.neop.approve',
    title: "A person's decision on a card, against the fingerprint they saw",
    type: 'object',
    required: ['proposal_id', 'fingerprint', 'decision'],
    additionalProperties: false,
    properties: { proposal_id: ID, fingerprint: TEXT(200), decision: { type: 'string', enum: ['yes', 'no', 'change', 'withdraw'] }, feedback: { type: 'string', maxLength: 2000 } },
  },
  'neos.neop.done': {
    $id: 'neos.neop.done',
    title: 'The result, in the thread of the task',
    type: 'object',
    required: ['task_id', 'job_id', 'result', 'could_not'],
    additionalProperties: false,
    properties: { task_id: ID, job_id: ID, result: { type: 'object' }, could_not: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 2000 } } },
  },
  'neos.neop.note': {
    $id: 'neos.neop.note',
    title: 'The short mirror of a step; deduped by step_id',
    type: 'object',
    required: ['job_id', 'step_id', 'text'],
    additionalProperties: false,
    properties: { job_id: ID, step_id: ID, text: TEXT(2000) },
  },
};

/** Keys of the Matrix envelope that ride next to a typed body (not validated as part of it). */
export const ENVELOPE_KEYS = ['body', 'msgtype', 'format', 'formatted_body', 'm.relates_to', 'm.mentions'] as const;

function check(s: Schema, v: unknown, at: string): string | null {
  if (s.anyOf) return s.anyOf.some((x) => check(x, v, at) === null) ? null : `${at} has the wrong type`;
  switch (s.type) {
    case 'string':
      if (typeof v !== 'string') return `${at} must be a string`;
      if (s.minLength != null && v.length < s.minLength) return `${at} must not be empty`;
      if (s.maxLength != null && v.length > s.maxLength) return `${at} is longer than ${s.maxLength}`;
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `${at} is not well-formed`;
      if (s.enum && !s.enum.includes(v)) return `${at} must be one of ${s.enum.join(', ')}`;
      return null;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${at} must be a number`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${at} must be true or false`;
    case 'array': {
      if (!Array.isArray(v)) return `${at} must be an array`;
      if (s.maxItems != null && v.length > s.maxItems) return `${at} has more than ${s.maxItems} items`;
      for (const [i, x] of v.entries()) {
        const e = s.items ? check(s.items, x, `${at}[${i}]`) : null;
        if (e) return e;
      }
      return null;
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} must be an object`;
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (o[k] === undefined) return `${at === '$' ? '' : `${at}.`}${k} is required`;
      const keys = Object.keys(o);
      if (s.maxProperties != null && keys.length > s.maxProperties) return `${at} has more than ${s.maxProperties} entries`;
      for (const k of keys) {
        const p = s.properties?.[k];
        const name = at === '$' ? k : `${at}.${k}`;
        if (p) {
          const e = check(p, o[k], name);
          if (e) return e;
        } else if (s.additionalProperties === false) return `${name} is not allowed`;
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
          const e = check(s.additionalProperties, o[k], name);
          if (e) return e;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The typed body of a Matrix event's content (envelope keys removed), checked against the schema for its type.
 * `{ ok: false }` means drop it (and audit why): Matrix never validated it for us.
 */
export function validateTypedBody<T extends TypedEventType>(type: T, content: unknown): { ok: true; body: TypedBodies[T] } | { ok: false; error: string } {
  if (!isTypedEventType(type)) return { ok: false, error: `unknown event type ${String(type)}` };
  if (!content || typeof content !== 'object' || Array.isArray(content)) return { ok: false, error: 'content must be an object' };
  const body: Record<string, unknown> = { ...(content as Record<string, unknown>) };
  for (const k of ENVELOPE_KEYS) delete body[k];
  const e = check(TYPED_EVENT_SCHEMAS[type], body, '$');
  return e ? { ok: false, error: e } : { ok: true, body: body as unknown as TypedBodies[T] };
}

// ── threads ──────────────────────────────────────────────────────────────────
/** m.relates_to for an event in the thread rooted at the task event (with a reply fallback for older clients). */
export function threadRelation(rootEventId: string, inReplyTo?: string | null): Record<string, unknown> {
  return { rel_type: 'm.thread', event_id: rootEventId, is_falling_back: !inReplyTo, 'm.in_reply_to': { event_id: inReplyTo ?? rootEventId } };
}

/** The thread root an event belongs to, or null (not in a thread). */
export function threadRootOf(content: unknown): string | null {
  const r = (content as { 'm.relates_to'?: { rel_type?: unknown; event_id?: unknown } } | null)?.['m.relates_to'];
  return r && r.rel_type === 'm.thread' && typeof r.event_id === 'string' ? r.event_id : null;
}

/** Full content of an outbound typed event: the typed body, the m.notice text fallback, and the thread. */
export function typedContent<T extends TypedEventType>(_type: T, body: TypedBodies[T], fallback: string, root: string | null, inReplyTo?: string | null): Record<string, unknown> {
  return { ...body, msgtype: 'm.notice', body: fallback, ...(root ? { 'm.relates_to': threadRelation(root, inReplyTo) } : {}) };
}

// ── rooms (v3 §8: invite-only, no end-to-end encryption, only people post …approve) ───────────────────────────
/** Power levels for a NEOP room: people post approve; bots, bridges and NEOPs sit below it. */
export const ROOM_LEVELS = { people: 50, agents: 10 } as const;

export interface RoomStateView {
  join_rule: string | null;
  encrypted: boolean;
  power_levels: { users?: Record<string, number>; users_default?: number; events?: Record<string, number>; events_default?: number } | null;
}

/** Read the three settings from a /rooms/{id}/state array. */
export function roomStateView(state: { type?: string; state_key?: string; content?: any }[]): RoomStateView {
  const get = (t: string) => state.find((e) => e?.type === t && (e.state_key ?? '') === '')?.content ?? null;
  const jr = get('m.room.join_rules');
  const enc = get('m.room.encryption');
  return { join_rule: typeof jr?.join_rule === 'string' ? jr.join_rule : null, encrypted: !!enc && Object.keys(enc).length > 0, power_levels: get('m.room.power_levels') };
}

/**
 * Why a room is not fit to bind to a NEOP, or [] when it is: it must be invite-only, must NOT be end-to-end
 * encrypted (audit needs the plaintext and we run the server), `neos.neop.approve` must need a level above the
 * default and above every non-person named (the app's own identity, bridges, other NEOPs), and the app's own
 * identity (`self`) must be able to post its notices and its typed ask · propose · done · note.
 */
export function roomProblems(v: RoomStateView, o: { self: string; nonPeople?: string[] }): string[] {
  const out: string[] = [];
  if (v.encrypted) out.push('the room is end-to-end encrypted (NEOP rooms are not: audit needs the plaintext)');
  if (v.join_rule !== 'invite') out.push(`the room is not invite-only (join rule: ${v.join_rule ?? 'unknown'})`);
  const pl = v.power_levels;
  if (!pl) out.push('the room has no power levels');
  else {
    const dflt = pl.users_default ?? 0;
    const level = (u: string) => pl.users?.[u] ?? dflt;
    const need = (t: string) => pl.events?.[t] ?? pl.events_default ?? 0;
    const approve = need('neos.neop.approve');
    if (approve <= dflt) out.push(`neos.neop.approve needs level ${approve}, which everyone has by default (${dflt})`);
    const over = [o.self, ...(o.nonPeople ?? [])].filter((u) => level(u) >= approve);
    if (over.length) out.push(`${over.join(', ')} could post neos.neop.approve (level ≥ ${approve}); only people may`);
    const cannot = ['m.room.message', 'neos.neop.ask', 'neos.neop.propose', 'neos.neop.done', 'neos.neop.note'].filter((t) => level(o.self) < need(t));
    if (cannot.length) out.push(`${o.self} cannot post ${cannot.join(', ')} (level ${level(o.self)})`);
  }
  return out;
}

/** May `user` post an event of `type` in a room with these power levels? (Matrix's own rule, for the fail-safe.) */
export function canPost(v: RoomStateView, user: string, type: string): boolean {
  const pl = v.power_levels;
  if (!pl) return false;
  const level = pl.users?.[user] ?? pl.users_default ?? 0;
  return level >= (pl.events?.[type] ?? pl.events_default ?? 0);
}

/** power_level_content_override for a new NEOP room (createRoom, preset private_chat). */
export function neopRoomPowerLevels(o: { people: string[]; nonPeople: string[]; admins?: string[] }): Record<string, unknown> {
  const users: Record<string, number> = {};
  for (const u of o.nonPeople) users[u] = ROOM_LEVELS.agents;
  for (const u of o.people) users[u] = ROOM_LEVELS.people;
  for (const u of o.admins ?? []) users[u] = 100;
  return {
    users,
    users_default: 0,
    events_default: 0,
    state_default: 100,
    events: {
      'neos.neop.approve': ROOM_LEVELS.people,
      'neos.neop.task': 0,
      'neos.neop.answer': 0,
      'neos.neop.ask': ROOM_LEVELS.agents,
      'neos.neop.propose': ROOM_LEVELS.agents,
      'neos.neop.done': ROOM_LEVELS.agents,
      'neos.neop.note': ROOM_LEVELS.agents,
      'm.room.power_levels': 100,
      'm.room.encryption': 100,
      'm.room.join_rules': 100,
    },
  };
}
