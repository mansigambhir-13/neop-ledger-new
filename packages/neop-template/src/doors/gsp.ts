// GST Suvidha Provider (GSP) provider for a door, modelled on the GSTN
// taxpayer API as GSPs expose it:
//
//   authenticate  POST {paths.authenticate}  {action: OTPREQUEST | AUTHTOKEN | REFRESHTOKEN | EVCOTP}
//   save          PUT  {paths.gstr3b}        {action: RETSAVE, data: <GSTR-3B JSON>}  → reference_id
//   status        GET  {paths.returns}?action=RETSTATUS&gstin&ret_period&ref_id   → P | PE | ER | IP
//   summary       GET  {paths.gstr3b}?action=RETSUM&gstin&ret_period             → the saved return
//   submit        POST {paths.gstr3b}        {action: RETSUBMIT, data: {gstin, ret_period}}
//   file          POST {paths.gstr3b}        {action: RETFILE, data, st: EVC, sid: PAN|OTP} → ack_num (ARN)
//   track         GET  {paths.returns}?action=RETTRACK&gstin&ret_period&type=R3B  → EFiledlist
//
// Every call carries the GSTN header set (clientid, client-secret, state-cd,
// ip-usr, txn, username, gstin, ret_period, auth-token). Bodies are plain JSON:
// the GSP holds the GSTN public key and does the AES/RSA payload encryption and
// the EVC signing envelope. (A direct GSTN integration — being a GSP yourself —
// would need that encryption here; it is not implemented.)
//
// Secrets stay here. The GSP credential (client id/secret, username) comes from
// the secret store per call. The session auth token lives only in this process's
// memory, per company — never in the database, never in a result, never seen by
// a model. OTPs are entered by a person into a separate secret-store slot (default
// `<door>_otp`: { provider: 'person', auth_otp?, evc_otp? }); a used OTP is never
// replayed by this process.
//
// Effects (save, file) are journaled first and keyed by the proposal's
// idempotency key; GSTN has no idempotency key, so "did it happen?" is answered
// by the portal itself: RETSUM for a save, RETTRACK for a filing. A filing
// already on record for the period is never sent again.

import { createHash, randomUUID } from 'node:crypto';
import { DoorError } from './errors.ts';
import { isDefiniteRefusal, providerCall } from './http.ts';
import type { DoorJournal } from './journal.ts';

export interface GspCredential {
  provider: 'gsp';
  base_url: string;
  client_id: string;
  client_secret: string;
  /** The taxpayer's GST portal username (API access must be enabled on the portal). */
  username: string;
  gstin: string;
  /** GSTN app key (GSP-specific; some GSPs generate it themselves). */
  app_key?: string;
  /** PAN of the authorised signatory, for EVC filing. */
  signatory_pan?: string;
  /** When the books cannot tell intra- from inter-state supplies: which to assume. Unset → the package refuses. */
  assume_supply?: 'intra_state' | 'inter_state';
  paths?: { authenticate?: string; gstr3b?: string; returns?: string };
  /** Extra static headers some GSPs need (e.g. their own API key header). */
  headers?: Record<string, string>;
  timeout_ms?: number;
  ip_usr?: string;
  /** Secret-store slot a person's OTP is written into. Default `<door>_otp`. */
  person_door?: string;
  /** Call RETSUBMIT before RETFILE (default true). */
  submit_before_file?: boolean;
  /** How many RETSTATUS polls after a save (default 3, 300 ms apart). */
  status_polls?: number;
}

export const GSP_DEFAULT_PATHS = {
  authenticate: '/taxpayerapi/v1.0/authenticate',
  gstr3b: '/taxpayerapi/v1.1/returns/gstr3b',
  returns: '/taxpayerapi/v0.3/returns',
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

interface Session {
  token: string;
  expiresAt: number;
}

// Per process, per company: tokens are never persisted.
const sessions = new Map<string, Session>();
const usedOtps = new Set<string>();

/** Forget every GSP session (tests; or on a credential change). */
export function resetGspSessions(): void {
  sessions.clear();
  usedOtps.clear();
}

class AuthProblem extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export interface GspContext {
  door: string;
  companyId: string;
  journal: DoorJournal | null;
  /** Read another secret-store slot the host declared (for the person's OTPs). */
  lend: (door: string) => Promise<Record<string, unknown>>;
}

/** Every numeric leaf of `approved` must be present with the same value in `onPortal` (the portal may add fields). */
export function sameFigures(approved: unknown, onPortal: unknown, at = ''): string | null {
  if (typeof approved === 'number') {
    return typeof onPortal === 'number' && Math.round(onPortal * 100) === Math.round(approved * 100) ? null : `${at || '/'}: approved ${approved}, portal has ${JSON.stringify(onPortal)}`;
  }
  if (Array.isArray(approved)) {
    if (!Array.isArray(onPortal)) return `${at}: missing on the portal`;
    for (const [i, x] of approved.entries()) {
      const key = x && typeof x === 'object' && 'ty' in x ? (x as { ty: unknown }).ty : undefined;
      const match = key !== undefined ? onPortal.find((y) => y && typeof y === 'object' && y.ty === key) : onPortal[i];
      const d = sameFigures(x, match, `${at}/${key ?? i}`);
      if (d) return d;
    }
    return null;
  }
  if (approved && typeof approved === 'object') {
    if (!onPortal || typeof onPortal !== 'object') return `${at}: missing on the portal`;
    for (const [k, v] of Object.entries(approved)) {
      const d = sameFigures(v, (onPortal as Record<string, unknown>)[k], `${at}/${k}`);
      if (d) return d;
    }
  }
  return null;
}

export class GspProvider {
  private readonly cred: GspCredential;
  private readonly ctx: GspContext;
  constructor(cred: Record<string, unknown>, ctx: GspContext) {
    for (const k of ['base_url', 'client_id', 'client_secret', 'username', 'gstin']) {
      if (typeof cred[k] !== 'string' || !cred[k]) throw new DoorError(`${ctx.door} GSP credential needs ${k}`, { definite: true });
    }
    if (!GSTIN_RE.test(String(cred.gstin))) throw new DoorError(`${ctx.door} GSP credential has an invalid GSTIN`, { definite: true });
    this.cred = cred as unknown as GspCredential;
    this.ctx = ctx;
  }

  private get sessionKey(): string {
    return `${this.ctx.companyId}|${this.cred.base_url}|${this.cred.gstin}|${this.cred.username}`;
  }

  private path(which: keyof typeof GSP_DEFAULT_PATHS): string {
    return this.cred.base_url.replace(/\/$/, '') + (this.cred.paths?.[which] ?? GSP_DEFAULT_PATHS[which]);
  }

  private headers(extra: { token?: string; ret_period?: string }): Record<string, string> {
    return {
      'content-type': 'application/json',
      clientid: this.cred.client_id,
      'client-secret': this.cred.client_secret,
      'state-cd': this.cred.gstin.slice(0, 2),
      'ip-usr': this.cred.ip_usr ?? '127.0.0.1',
      txn: randomUUID().replace(/-/g, ''),
      username: this.cred.username,
      gstin: this.cred.gstin,
      ...(extra.ret_period ? { ret_period: extra.ret_period } : {}),
      ...(extra.token ? { 'auth-token': extra.token } : {}),
      ...(this.cred.headers ?? {}),
    };
  }

  /** One GSTN-style call. Returns `data` on success; throws AuthProblem or a DoorError. */
  private async call(method: 'GET' | 'POST' | 'PUT', which: keyof typeof GSP_DEFAULT_PATHS, opts: { query?: Record<string, string>; body?: unknown; token?: string; ret_period?: string }): Promise<any> {
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const r = await providerCall(this.path(which) + qs, {
      method,
      headers: this.headers({ token: opts.token, ret_period: opts.ret_period }),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      timeoutMs: this.cred.timeout_ms ?? 5_000,
    });
    const b = r.body ?? {};
    const err = b.error ?? {};
    const code = String(err.error_cd ?? b.error_cd ?? '');
    const msg = String(err.message ?? b.message ?? b.raw ?? '');
    if (r.status === 401 || r.status === 403 || /^AUTH/.test(code)) throw new AuthProblem(`${code || r.status} ${msg}`.trim());
    if (r.status >= 200 && r.status < 300 && String(b.status_cd ?? '1') === '1') return b.data ?? b;
    const what = `${this.ctx.door} ${String((opts.body as any)?.action ?? opts.query?.action ?? which)}`;
    // HTTP 200 with status_cd 0 is the portal refusing: definite.
    const definite = r.status >= 200 && r.status < 300 ? true : isDefiniteRefusal(r.status);
    throw new DoorError(`${what}: GSP answered ${r.status}${code ? ` ${code}` : ''}${msg ? ` (${msg.slice(0, 200)})` : ''}`, { definite });
  }

  private async personInput(): Promise<{ auth_otp?: string; evc_otp?: string }> {
    const slot = this.cred.person_door ?? `${this.ctx.door}_otp`;
    try {
      const v = await this.ctx.lend(slot);
      return { auth_otp: typeof v.auth_otp === 'string' ? v.auth_otp : undefined, evc_otp: typeof v.evc_otp === 'string' ? v.evc_otp : undefined };
    } catch {
      return {};
    }
  }

  private otpKey(purpose: string, otp: string): string {
    return `${this.sessionKey}|${purpose}|${hash(otp)}`;
  }

  private async requestAuthOtp(): Promise<void> {
    await this.call('POST', 'authenticate', { body: { action: 'OTPREQUEST', app_key: this.cred.app_key ?? null, username: this.cred.username } });
  }

  /** Establish a session from the OTP a person entered; with none, ask the portal to send one and stop. */
  private async authenticate(): Promise<Session> {
    const { auth_otp } = await this.personInput();
    const slot = this.cred.person_door ?? `${this.ctx.door}_otp`;
    if (!auth_otp || usedOtps.has(this.otpKey('auth', auth_otp))) {
      await this.requestAuthOtp().catch((e) => {
        if (e instanceof AuthProblem) throw new DoorError(`${this.ctx.door}: the GSP refused the OTP request (${e.message})`, { definite: true });
        throw e;
      });
      throw new DoorError(
        `${this.ctx.door}: no GST portal session. The portal has sent an OTP to the registered mobile of ${this.cred.username}; a person enters it as auth_otp in the ${slot} door (secret store: scripts/deploy.sh door set), then asks again. Nothing was sent.`,
        { definite: true },
      );
    }
    let data: any;
    try {
      data = await this.call('POST', 'authenticate', { body: { action: 'AUTHTOKEN', app_key: this.cred.app_key ?? null, username: this.cred.username, otp: auth_otp } });
    } catch (e) {
      if (e instanceof AuthProblem) {
        usedOtps.add(this.otpKey('auth', auth_otp));
        throw new DoorError(`${this.ctx.door}: the GST portal did not accept the OTP (${e.message}); request a new one. Nothing was sent.`, { definite: true });
      }
      throw e;
    }
    usedOtps.add(this.otpKey('auth', auth_otp));
    if (typeof data?.auth_token !== 'string') throw new DoorError(`${this.ctx.door}: the GSP returned no auth token`, { definite: true });
    const s = { token: data.auth_token, expiresAt: Date.now() + Number(data.expiry ?? 360) * 60_000 };
    sessions.set(this.sessionKey, s);
    return s;
  }

  private async refresh(s: Session): Promise<Session | null> {
    try {
      const data = await this.call('POST', 'authenticate', { body: { action: 'REFRESHTOKEN', app_key: this.cred.app_key ?? null, username: this.cred.username, auth_token: s.token } });
      if (typeof data?.auth_token !== 'string') return null;
      const n = { token: data.auth_token, expiresAt: Date.now() + Number(data.expiry ?? 360) * 60_000 };
      sessions.set(this.sessionKey, n);
      return n;
    } catch (e) {
      if (e instanceof AuthProblem) return null;
      throw e;
    }
  }

  /** Run `fn` with a live session: refresh near expiry; on an auth error refresh once, else re-authenticate. */
  private async withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let s = sessions.get(this.sessionKey) ?? null;
    if (s && s.expiresAt - Date.now() < 60_000) s = await this.refresh(s);
    if (!s) s = await this.authenticate();
    try {
      return await fn(s.token);
    } catch (e) {
      if (!(e instanceof AuthProblem)) throw e;
      sessions.delete(this.sessionKey);
      const n = (await this.refresh(s)) ?? (await this.authenticate());
      try {
        return await fn(n.token);
      } catch (e2) {
        if (e2 instanceof AuthProblem) {
          sessions.delete(this.sessionKey);
          throw new DoorError(`${this.ctx.door}: the GST portal session was refused twice (${e2.message})`, { definite: true });
        }
        throw e2;
      }
    }
  }

  private checkPeriod(p: unknown): string {
    if (typeof p !== 'string' || !/^(0[1-9]|1[0-2])\d{4}$/.test(p)) throw new DoorError(`${this.ctx.door}: ret_period must be MMYYYY`, { definite: true });
    return p;
  }

  // ── effects ─────────────────────────────────────────────────────────────

  async send(record: Record<string, unknown>, key: string): Promise<{ id: string; detail?: unknown }> {
    switch (record.action) {
      case 'gstr3b.save':
        return this.save(record, key);
      case 'gstr3b.file':
        return this.file(record, key);
      case 'otp.request':
        return this.requestOtp(record);
      default:
        throw new DoorError(`${this.ctx.door}: unknown GSP action ${String(record.action)}`, { definite: true });
    }
  }

  private async save(record: Record<string, unknown>, key: string): Promise<{ id: string; detail?: unknown }> {
    const period = this.checkPeriod(record.ret_period);
    const data = record.data as Record<string, unknown> | undefined;
    if (!data || data.gstin !== this.cred.gstin || data.ret_period !== period) {
      throw new DoorError(`${this.ctx.door}: the return is for ${String(data?.gstin)}/${String(data?.ret_period)}, this door files for ${this.cred.gstin}/${period}`, { definite: true });
    }
    const j = this.ctx.journal ? await this.ctx.journal.begin(this.ctx.door, key, 'gsp', record) : null;
    if (j?.provider_ref) return { id: j.provider_ref };
    try {
      const ref = await this.withSession(async (token) => {
        const d = await this.call('PUT', 'gstr3b', { body: { action: 'RETSAVE', data }, token, ret_period: period });
        const r = d?.reference_id ?? d?.ref_id;
        if (typeof r !== 'string') throw new DoorError(`${this.ctx.door} RETSAVE: no reference_id in the answer`, { definite: false });
        return r;
      });
      await this.ctx.journal?.accept(this.ctx.door, key, ref);
      return { id: ref };
    } catch (e) {
      if (e instanceof DoorError && e.definite) await this.ctx.journal?.reject(this.ctx.door, key, e.message);
      throw e;
    }
  }

  private async file(record: Record<string, unknown>, key: string): Promise<{ id: string; detail?: unknown }> {
    const period = this.checkPeriod(record.ret_period);
    const approved = record.data as Record<string, unknown> | undefined;
    if (!approved || approved.gstin !== this.cred.gstin || approved.ret_period !== period) throw new DoorError(`${this.ctx.door}: the approved return is not for ${this.cred.gstin}/${period}`, { definite: true });
    const j = this.ctx.journal ? await this.ctx.journal.begin(this.ctx.door, key, 'gsp', { action: record.action, ret_period: period, payload_sha256: record.payload_sha256 ?? null }) : null;
    if (j?.provider_ref) return { id: j.provider_ref };
    try {
      const arn = await this.withSession(async (token) => {
        // Never twice: a filing on record for the period is the answer.
        const onRecord = await this.trackWith(token, period);
        if (onRecord) return onRecord.arn;
        // What is filed is what the person approved: the portal's saved return must carry the same figures.
        const saved = await this.call('GET', 'gstr3b', { query: { action: 'RETSUM', gstin: this.cred.gstin, ret_period: period }, token, ret_period: period });
        const diff = sameFigures(approved, saved);
        if (diff) throw new DoorError(`${this.ctx.door}: the return saved on the portal differs from the one approved (${diff}); nothing was filed`, { definite: true });
        if (!this.cred.signatory_pan) throw new DoorError(`${this.ctx.door}: the GSP credential has no signatory_pan for EVC`, { definite: true });
        const { evc_otp } = await this.personInput();
        const slot = this.cred.person_door ?? `${this.ctx.door}_otp`;
        if (!evc_otp || usedOtps.has(this.otpKey('evc', evc_otp))) {
          throw new DoorError(`${this.ctx.door}: no fresh EVC OTP. Request one (gst.otp.request, purpose evc), a person enters it as evc_otp in the ${slot} door, then approve the filing again. Nothing was filed.`, { definite: true });
        }
        if (this.cred.submit_before_file !== false) {
          await this.call('POST', 'gstr3b', { body: { action: 'RETSUBMIT', data: { gstin: this.cred.gstin, ret_period: period } }, token, ret_period: period });
        }
        usedOtps.add(this.otpKey('evc', evc_otp)); // spent from here on, whatever the answer
        const d = await this.call('POST', 'gstr3b', { body: { action: 'RETFILE', data: approved, st: 'EVC', sid: `${this.cred.signatory_pan}|${evc_otp}` }, token, ret_period: period });
        const ack = d?.ack_num ?? d?.arn;
        if (typeof ack !== 'string') throw new DoorError(`${this.ctx.door} RETFILE: no acknowledgement number in the answer`, { definite: false });
        return ack;
      });
      await this.ctx.journal?.accept(this.ctx.door, key, arn);
      return { id: arn };
    } catch (e) {
      if (e instanceof DoorError && e.definite) await this.ctx.journal?.reject(this.ctx.door, key, e.message);
      throw e;
    }
  }

  private async requestOtp(record: Record<string, unknown>): Promise<{ id: string }> {
    if (record.purpose === 'auth') {
      await this.requestAuthOtp();
      return { id: `otp:auth:${new Date().toISOString()}` };
    }
    if (record.purpose === 'evc') {
      if (!this.cred.signatory_pan) throw new DoorError(`${this.ctx.door}: the GSP credential has no signatory_pan for EVC`, { definite: true });
      await this.withSession((token) => this.call('POST', 'authenticate', { body: { action: 'EVCOTP', pan: this.cred.signatory_pan, form_type: 'R3B', gstin: this.cred.gstin }, token }));
      return { id: `otp:evc:${new Date().toISOString()}` };
    }
    throw new DoorError(`${this.ctx.door}: OTP purpose must be auth or evc`, { definite: true });
  }

  // ── read-back ───────────────────────────────────────────────────────────

  private async trackWith(token: string, period: string): Promise<{ arn: string; dof: string | null; status: string } | null> {
    const d = await this.call('GET', 'returns', { query: { action: 'RETTRACK', gstin: this.cred.gstin, ret_period: period, type: 'R3B' }, token, ret_period: period });
    const list: any[] = d?.EFiledlist ?? [];
    const hit = list.find((x) => String(x.rtntype).replace(/[^A-Z0-9]/gi, '').toUpperCase() === 'GSTR3B' && x.ret_prd === period && /^filed$/i.test(String(x.status)) && x.valid !== 'N');
    return hit ? { arn: String(hit.arn), dof: hit.dof ?? null, status: String(hit.status) } : null;
  }

  /**
   * Read-only questions. `query.action`:
   *   profile              the non-secret configuration (GSTIN, state, split assumption)
   *   gstr3b.status        RETSTATUS for a save reference (polled a few times while IP)
   *   gstr3b.summary       RETSUM: the return as saved on the portal
   *   gstr3b.track         RETTRACK: the filing on record for the period, or null
   * Without a query: the effect journaled under `key`.
   */
  async lookup(key: string, query?: Record<string, unknown>): Promise<(Record<string, unknown> & { id: string }) | null> {
    const action = query?.action;
    if (action === 'profile') {
      return {
        id: `profile:${this.cred.gstin}`,
        gstin: this.cred.gstin,
        state_cd: this.cred.gstin.slice(0, 2),
        assume_supply: this.cred.assume_supply ?? null,
        evc_ready: !!this.cred.signatory_pan,
      };
    }
    if (action === 'gstr3b.status') {
      const period = this.checkPeriod(query!.ret_period);
      const ref = String(query!.reference_id ?? (await this.ctx.journal?.get(this.ctx.door, key))?.provider_ref ?? '');
      if (!ref) return null;
      return this.withSession(async (token) => {
        let d: any = null;
        const polls = Math.max(1, this.cred.status_polls ?? 3);
        for (let i = 0; i < polls; i++) {
          d = await this.call('GET', 'returns', { query: { action: 'RETSTATUS', gstin: this.cred.gstin, ret_period: period, ref_id: ref }, token, ret_period: period });
          if (d?.status_cd !== 'IP') break;
          if (i < polls - 1) await sleep(300);
        }
        return { id: ref, reference_id: ref, status_cd: String(d?.status_cd ?? ''), error_report: d?.error_report ?? null };
      });
    }
    if (action === 'gstr3b.summary') {
      const period = this.checkPeriod(query!.ret_period);
      return this.withSession(async (token) => {
        const d = await this.call('GET', 'gstr3b', { query: { action: 'RETSUM', gstin: this.cred.gstin, ret_period: period }, token, ret_period: period });
        return d ? { id: `retsum:${period}`, return: d } : null;
      });
    }
    if (action === 'gstr3b.track') {
      const period = this.checkPeriod(query!.ret_period);
      return this.withSession(async (token) => {
        const t = await this.trackWith(token, period);
        return t ? { id: t.arn, ...t, ret_period: period } : null;
      });
    }
    if (action !== undefined && action !== null) throw new DoorError(`${this.ctx.door}: unknown GSP lookup ${String(action)}`, { definite: true });
    // The journaled effect under this key.
    const j = await this.ctx.journal?.get(this.ctx.door, key);
    if (!j || j.status === 'rejected') return null;
    const p = j.payload as Record<string, unknown>;
    if (p?.action === 'gstr3b.file') return this.lookup(key, { action: 'gstr3b.track', ret_period: p.ret_period });
    if (p?.action === 'gstr3b.save') return j.provider_ref ? this.lookup(key, { action: 'gstr3b.status', ret_period: p.ret_period, reference_id: j.provider_ref }) : null;
    return null;
  }
}
