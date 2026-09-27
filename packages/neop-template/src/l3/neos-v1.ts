// The bridge to the NEOS platform as it runs today (neos-service-platform-api): its
// descriptor registry and its capability gateway. That platform installs a NEOP from a
// descriptor + schema document and calls `POST /capabilities/<id>` with a 90 s EdDSA
// operation token (iss `platform`, sub `svc:gateway`, aud `neop:<app>`, claims
// cust/inst/act/scope/cap/op/mth/pth/req). This module speaks that contract without
// giving up the plan's rules:
//   · reads are served as capabilities (switchboard still applies; off = refused);
//   · a person's request becomes a job (`<app>.ask`), never a direct write;
//   · a job's open questions are listed by `<app>.job` and answered with `<app>.answer` — relayed by
//     NeuralChat, so the assistant receives the answer as untrusted data, never as an instruction;
//   · the yes on a proposal is a human-gated capability the platform never dispatches —
//     it is answered on the desk, bound to the card's fingerprint.
// Nothing here widens what reaches the app: same L3 listener, same RLS, single-use tokens.

import { createHash } from 'node:crypto';
import type { Manifest, ManifestAbility } from '@neop/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import { Hono, type Context } from 'hono';
import { importSPKI, jwtVerify, type CryptoKey, type KeyObject } from 'jose';
import { openJob } from '../capabilities/platform/tasks.open.ts';
import { answerWait } from '../capabilities/platform/waits.answer.ts';
import { ExecError } from '../capabilities/execute.ts';
import type { Core } from '../core.ts';

export interface NeosV1Config {
  /** The platform's Ed25519 public key (SPKI PEM) for its NEOP binding. */
  publicKeyPem: string;
  /** Platform customer id → this app's company id. Explicit: an unmapped customer is refused. */
  customers: Record<string, string>;
}

export const NEOS_V1_CONTRACT = 'neop.v1';
export const NEOS_V1_EVENTS = ['job.opened'] as const;
const LIMITS = { MAX_BATCH: 16, MAX_KEYS: 8, MAX_KEY_LEN: 64, MAX_VAL_LEN: 500, MAX_SUBJECT: 128 };
const MAX_TOKEN_AGE_S = 125; // the platform signs for 90 s and allows up to 120 s
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** `ledger.report.balance_sheet` → `ledger.report.balance-sheet` (the platform's id grammar has no `_`). */
export const capabilityId = (abilityKey: string): string => abilityKey.replaceAll('_', '-');

interface Cap { id: string; scope: string; gated: boolean; input: Obj; output: Obj; ability?: string; kind: 'read' | 'ask' | 'job' | 'answer' | 'decide' }

function capabilities(manifest: Manifest): Cap[] {
  const app = manifest.app;
  const reads: Cap[] = manifest.abilities
    .filter((a: ManifestAbility) => a.kind === 'read' && a.floor !== 'off')
    .map((a) => ({ id: capabilityId(a.key), scope: `${app}.read`, gated: false, input: a.input as Obj, output: a.output as Obj, ability: a.key, kind: 'read' as const }));
  const obj = (properties: Obj, required: string[]): Obj => ({ type: 'object', additionalProperties: false, required, properties });
  const str = (extra: Obj = {}): Obj => ({ type: 'string', ...extra });
  const nstr = (): Obj => ({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  return [
    ...reads,
    {
      id: `${app}.ask`, scope: `${app}.ask`, gated: false, kind: 'ask',
      input: obj({ text: str({ minLength: 1, maxLength: 8000 }) }, ['text']),
      output: obj({ task_id: str({ pattern: UUID }), job_id: str({ pattern: UUID }), status: str(), created: { type: 'boolean' }, ack: str() }, ['task_id', 'job_id', 'status', 'created', 'ack']),
    },
    {
      id: `${app}.job`, scope: `${app}.read`, gated: false, kind: 'job',
      input: obj({ job_id: str({ pattern: UUID }) }, ['job_id']),
      output: obj({
        job_id: str(), status: str(), ask: str(), summary: nstr(), updated_at: str(),
        waiting_on: {
          type: 'array', maxItems: 20,
          items: obj({ proposal_id: str(), title: str(), fingerprint: str(), expires_at: str() }, ['proposal_id', 'title', 'fingerprint', 'expires_at']),
        },
        // Questions the job waits on (WP §8 `ask`): what NeuralChat shows as needs_input, answered with <app>.answer.
        questions: {
          type: 'array', maxItems: 20,
          items: obj({
            wait_id: str(), text: str(), why: str(), due_at: str(),
            fields: {
              type: 'array', maxItems: 10,
              items: obj({ key: str(), label: str(), type: { enum: ['text', 'number', 'date', 'boolean'] }, required: { type: 'boolean' } }, ['key', 'label', 'type', 'required']),
            },
          }, ['wait_id', 'text', 'why', 'fields', 'due_at']),
        },
      }, ['job_id', 'status', 'ask', 'summary', 'updated_at', 'waiting_on', 'questions']),
    },
    {
      // The answer to a question a job asked. Not a yes: it resumes the job with information. Relayed by
      // NeuralChat, so the assistant receives it as untrusted data, never as the person's own instruction.
      id: `${app}.answer`, scope: `${app}.ask`, gated: false, kind: 'answer',
      input: obj({
        job_id: str({ pattern: UUID }), wait_id: str({ pattern: UUID }),
        answers: {
          type: 'array', minItems: 1, maxItems: 10,
          items: obj({ key: str({ pattern: '^[a-z][a-z0-9_]{0,39}$' }), value: { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }] } }, ['key', 'value']),
        },
      }, ['job_id', 'wait_id', 'answers']),
      output: obj({ status: str(), job_id: str({ pattern: UUID }), wait_id: str({ pattern: UUID }), idempotent: { type: 'boolean' } }, ['status', 'job_id', 'wait_id', 'idempotent']),
    },
    {
      // Declared so the platform shows the gate; never dispatched (humanGate). The yes is given on the desk.
      id: `${app}.proposal.decide`, scope: 'proposal.decide', gated: true, kind: 'decide',
      input: obj({ proposal_id: str({ pattern: UUID }), decision: { enum: ['yes', 'no'] }, fingerprint_seen: str({ pattern: '^sha256:[0-9a-f]{64}$' }) }, ['proposal_id', 'decision', 'fingerprint_seen']),
      output: obj({ status: str() }, ['status']),
    },
  ];
}

/**
 * Rewrite a manifest JSON Schema into the subset the platform compiles (Ajv strict,
 * no formats): formats become patterns or go, `type: [t, 'null']` becomes anyOf with
 * t's keywords inside its branch, and every object must already be closed.
 */
export function strictSchema(s: Json, path = '$'): Json {
  if (Array.isArray(s)) return s.map((x, i) => strictSchema(x, `${path}[${i}]`));
  if (!s || typeof s !== 'object') return s;
  const o: Obj = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'format') continue;
    o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Obj).map(([pk, pv]) => [pk, strictSchema(pv, `${path}.${pk}`)])) : strictSchema(v, `${path}.${k}`);
  }
  const fmt = (s as Obj).format;
  if (fmt === 'date' && !o.pattern) o.pattern = '^\\d{4}-\\d{2}-\\d{2}$';
  if (fmt === 'date-time' && !o.pattern) o.pattern = '^\\d{4}-\\d{2}-\\d{2}T';
  if (fmt === 'uuid' && !o.pattern) o.pattern = UUID;
  if ((o.type === 'object' || 'properties' in o) && o.additionalProperties !== false) {
    throw new Error(`${path}: object schema is not closed (additionalProperties: false)`);
  }
  if (Array.isArray(o.type)) {
    const types = o.type as string[];
    const { type: _t, ...rest } = o;
    const shared = ['description', 'title'];
    const outer: Obj = {};
    const inner: Obj = {};
    for (const [k, v] of Object.entries(rest)) (shared.includes(k) ? outer : inner)[k] = v;
    return { ...outer, anyOf: types.map((t) => (t === 'null' ? { type: 'null' } : { type: t, ...inner })) };
  }
  return o;
}

/** The descriptor and schema document the platform's `neop:register` accepts. Deterministic. */
export function neosV1Descriptor(manifest: Manifest): { descriptor: Obj; schema: Obj } {
  const caps = capabilities(manifest);
  const defs: Obj = {};
  const ref = (name: string) => `contract.json#/$defs/${name}`;
  const descriptorCaps: Json[] = caps.map((c) => {
    const n = c.id.replaceAll('.', '_');
    defs[`${n}_request`] = strictSchema(c.input);
    defs[`${n}_result`] = strictSchema(c.output);
    return { id: c.id, method: 'POST', scope: c.scope, humanGate: c.gated, requestSchema: ref(`${n}_request`), responseSchema: ref(`${n}_result`) };
  });
  const scopes = [...new Set(caps.map((c) => c.scope))].sort();
  return {
    descriptor: {
      schemaVersion: '1',
      service: { id: manifest.app, version: manifest.version, contractVersion: NEOS_V1_CONTRACT, profile: 'neop-template' },
      capabilities: descriptorCaps,
      permissions: scopes,
      humanGates: [...new Set(caps.filter((c) => c.gated).map((c) => c.scope))],
      events: { names: [...NEOS_V1_EVENTS], limits: LIMITS },
    },
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: defs },
  };
}

/** Compile a descriptor schema exactly as the platform does (Ajv strict, no formats, money-safe multipleOf). */
export function neosV1Compile(schema: object): ValidateFunction {
  return new Ajv({ allErrors: false, strict: true, multipleOfPrecision: 2 }).compile(schema);
}

class V1Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** `/capabilities/<id>` on the L3 listener. Error bodies use only the platform's safe codes. */
export function neosV1App(core: Core, cfg: NeosV1Config): Hono {
  const app = new Hono();
  const caps = new Map(capabilities(core.manifest).map((c) => [c.id, c]));
  let answerInput: ValidateFunction | null = null;
  const audience = `neop:${core.key}`;
  let key: Promise<CryptoKey | KeyObject> | null = null;
  const publicKey = () => (key ??= importSPKI(cfg.publicKeyPem, 'EdDSA'));

  app.onError((err, c) => {
    if (err instanceof V1Error) return c.json({ error: { code: err.code } }, err.status as 400);
    core.log('neos-v1 error', { error: (err as Error).message });
    return c.json({ error: { code: 'unavailable' } }, 503);
  });

  app.all('/capabilities/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const cap = caps.get(id);
    if (!cap) throw new V1Error(404, 'not_found');
    if (c.req.method !== 'POST') throw new V1Error(400, 'bad_request');
    const token = c.req.header('authorization')?.startsWith('Bearer ') ? c.req.header('authorization')!.slice(7) : null;
    if (!token) throw new V1Error(401, 'unauthenticated');
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, await publicKey(), {
        issuer: 'platform', subject: 'svc:gateway', audience, algorithms: ['EdDSA'],
        maxTokenAge: `${MAX_TOKEN_AGE_S}s`, requiredClaims: ['jti', 'exp', 'iat', 'cust', 'act', 'cap', 'op', 'mth', 'pth', 'req', 'scope'],
      }));
    } catch {
      throw new V1Error(401, 'unauthenticated');
    }
    if (c.req.header('contract-version') !== NEOS_V1_CONTRACT) throw new V1Error(400, 'bad_request');
    // The token names exactly this call: capability, method, path, and the bytes of the body.
    const raw = Buffer.from(await c.req.arrayBuffer());
    const req = createHash('sha256').update(raw).digest('hex');
    const path = `/capabilities/${id}`;
    if (claims.cap !== id || claims.mth !== 'POST' || claims.pth !== path || claims.req !== req) throw new V1Error(403, 'denied');
    if (!Array.isArray(claims.scope) || !claims.scope.includes(cap.scope)) throw new V1Error(403, 'denied');
    if (c.req.header('idempotency-key') !== `neop:${claims.op}`) throw new V1Error(400, 'bad_request');
    if (cap.gated) throw new V1Error(403, 'denied'); // a yes is never an API call; it is answered on the desk
    const cust = String(claims.cust);
    if (c.req.header('x-customer-id') !== cust) throw new V1Error(403, 'customer_mismatch');
    const companyId = cfg.customers[cust];
    if (!companyId) throw new V1Error(403, 'customer_mismatch');
    const burned = await core.runnerPool.query(
      `insert into ${core.key}.seen_tokens (jti, expires_at) values ($1, to_timestamp($2)) on conflict do nothing`,
      [`v1:${claims.jti}`, claims.exp],
    );
    if (!burned.rowCount) throw new V1Error(401, 'replayed');
    let input: Obj;
    try {
      input = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new V1Error(400, 'bad_request');
    }
    const act = String(claims.act);

    if (cap.kind === 'read') {
      const resolved = await core.resolve(companyId, cap.ability!);
      const handler = resolved?.handler;
      if (!resolved || !handler || handler.kind !== 'read') throw new V1Error(404, 'not_found');
      const board = await core.board.get(companyId);
      if (board.setting(resolved.meta) === 'off') throw new V1Error(403, 'denied');
      if (resolved.checkInput(input)) throw new V1Error(400, 'bad_request');
      const result = await core.company(companyId, (db) => handler.run(input, { company_id: companyId, caller: `user:${act}`, job_id: null, now: new Date(), time_zone: board.company.time_zone, db }));
      const bad = resolved.checkOutput(result);
      if (bad) {
        core.log('contract violation', { key: cap.ability, bad });
        throw new V1Error(503, 'unavailable');
      }
      return c.json({ result, events: [] });
    }

    if (cap.kind === 'ask') {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 8000) throw new V1Error(400, 'bad_request');
      // The operation id is the platform's idempotency key: a retried ask opens the same job.
      const task_id = uuidFrom(`${core.key}:${cust}:${claims.op}`);
      const r = await openJob(core, companyId, { task_id, ask: text, requester: `user:${act}`, source: 'task', trace: c.req.header('traceparent') ?? null });
      const event = {
        at: new Date().toISOString(), customer_id: cust, event: 'job.opened', installation_id: String(claims.inst ?? ''),
        neop_key: core.key, run_id: r.job_id, subject_ref: `job:${r.job_id}`, summary: { status: r.status, created: r.created },
      };
      return c.json({ result: { task_id, job_id: r.job_id, status: r.status, created: r.created, ack: r.ack }, events: [event] });
    }

    if (cap.kind === 'answer') {
      if (!(answerInput ??= neosV1Compile(strictSchema(cap.input) as object))(input)) throw new V1Error(400, 'bad_request');
      const pairs = input.answers as { key: string; value: string | number | boolean }[];
      if (new Set(pairs.map((p) => p.key)).size !== pairs.length) throw new V1Error(400, 'bad_request');
      const w = await core.company(companyId, (db) => core.book.getWait(db, String(input.wait_id)));
      if (!w || w.kind !== 'input' || w.job_id !== input.job_id) throw new V1Error(404, 'not_found');
      try {
        // NeuralChat relays the person's reply: recorded as the reasoning agent's, and shown to the assistant as data.
        const r = await answerWait(core, companyId, { wait_id: w.id, answers: Object.fromEntries(pairs.map((p) => [p.key, p.value])), answered_by: `agent:neuralchat:user:${act}`, via: 'reasoning_agent' });
        return c.json({ result: { status: r.status, job_id: r.job_id, wait_id: r.wait_id, idempotent: r.idempotent }, events: [] });
      } catch (e) {
        if (e instanceof ExecError) throw new V1Error(e.status === 409 ? 409 : e.status === 404 ? 404 : 400, e.status === 409 ? 'conflict' : e.status === 404 ? 'not_found' : 'bad_request');
        throw e;
      }
    }

    // kind === 'job': where a job stands, and what it waits on (cards and questions).
    if (typeof input.job_id !== 'string' || !new RegExp(UUID).test(input.job_id)) throw new V1Error(400, 'bad_request');
    const out = await core.company(companyId, async (db) => {
      const j = (await db.query(`select id, status, ask, result, updated_at from ${core.key}.jobs where id = $1`, [input.job_id])).rows[0];
      if (!j) return null;
      const p = (await db.query(
        `select id, card, fingerprint, expires_at from ${core.key}.proposals where job_id = $1 and status = 'PROPOSED' and expires_at > now() order by created_at limit 20`,
        [j.id],
      )).rows;
      const q = (await db.query(
        `select id, question, expires_at from ${core.key}.waits where job_id = $1 and kind = 'input' and status = 'pending' and expires_at > now() order by created_at limit 20`,
        [j.id],
      )).rows;
      return {
        job_id: j.id, status: j.status, ask: j.ask, summary: typeof j.result?.summary === 'string' ? j.result.summary : null,
        updated_at: new Date(j.updated_at).toISOString(),
        questions: q.map((x) => ({
          wait_id: x.id, text: String(x.question.text), why: String(x.question.why), due_at: new Date(x.expires_at).toISOString(),
          fields: (x.question.fields ?? []).map((f: any) => ({ key: String(f.key), label: String(f.label), type: f.type ?? 'text', required: f.required !== false })),
        })),
        waiting_on: p.map((x) => ({ proposal_id: x.id, title: String(x.card?.what ?? 'Approval needed'), fingerprint: x.fingerprint, expires_at: new Date(x.expires_at).toISOString() })),
      };
    });
    if (!out) throw new V1Error(404, 'not_found');
    return c.json({ result: out, events: [] });
  });

  return app;
}

function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
