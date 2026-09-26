// A faithful fake GST Suvidha Provider, speaking the GSTN taxpayer API the way
// GSPs expose it (plain JSON; the GSP does the GSTN encryption). What it holds
// to, because production depends on it:
//   - every call needs the GSP client headers (clientid, client-secret) and the
//     taxpayer headers (username, gstin, state-cd, txn); calls after login need a
//     live auth-token → otherwise 401 AUTH4033 "Invalid Session"
//   - login is OTP-based: OTPREQUEST "sends" a fresh 6-digit OTP by SMS (read it
//     with lastOtp('auth'), as the person reads their phone), AUTHTOKEN exchanges
//     it once for a token with an expiry; REFRESHTOKEN extends a token (also an
//     expired one, until refuseRefresh); EVCOTP sends the signatory's filing OTP
//   - RETSAVE validates the GSTR-3B (sections, 2-decimal non-negative amounts,
//     gstin/period matching the headers, itc_net = avl − rev) — a malformed
//     return is 400 RET191106; a saved return processes asynchronously
//     (RETSTATUS: IP on the first poll, then P)
//   - RETFILE needs a submitted return and `sid` = PAN|EVC-OTP of the last EVC
//     OTP sent; a month is filed once (a second RETFILE is RT-3BFL-1004)
//   - RETTRACK lists the filing with its ARN
// Faults: 'outage' (503 everything), 'save_invalid' (422 on save), 'file_drop'
// (files, then the answer is lost: 504), 'file_then_outage' (files, then 503 on
// everything until cleared), 'file_hang' (files, then answers after `hangMs`),
// plus expireTokens() and refuseRefresh.
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { closeServer } from '@neop/pgkit';

export type GspFault = null | 'outage' | 'save_invalid' | 'file_drop' | 'file_then_outage' | 'file_hang';

export interface FakeGspFiling {
  ret_period: string;
  arn: string;
  data: any;
  dof: string;
}

export interface FakeGsp {
  url: string;
  client_id: string;
  client_secret: string;
  username: string;
  gstin: string;
  signatory_pan: string;
  /** Per-period saved returns (the portal's copy). */
  saved: Map<string, { data: any; reference_id: string; submitted: boolean; polls: number }>;
  filings: FakeGspFiling[];
  /** Every call: method, path, action, whether it carried a token. */
  requests: { method: string; path: string; action: string | null; token: boolean; status: number }[];
  /** OTPs "sent by SMS". */
  otpsSent: { purpose: 'auth' | 'evc'; otp: string; at: number }[];
  /** The last OTP sent for a purpose (what the person reads on their phone). */
  lastOtp(purpose: 'auth' | 'evc'): string | null;
  fault: GspFault;
  hangMs: number;
  refuseRefresh: boolean;
  /** Invalidate every live token (as if their 6 hours ran out). */
  expireTokens(): void;
  actions(name: string): number;
  close(): Promise<void>;
}

const TWO_DP = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const HEADS = ['iamt', 'camt', 'samt', 'csamt'];

/** GSTN-side validation of a GSTR-3B save, independent of the package's schema. */
export function gstnCheck3b(d: any, gstin: string, period: string): string | null {
  if (!d || typeof d !== 'object') return 'data missing';
  if (d.gstin !== gstin) return `gstin ${d.gstin} does not match the header ${gstin}`;
  if (d.ret_period !== period) return `ret_period ${d.ret_period} does not match the header ${period}`;
  const need = (o: any, keys: string[], at: string): string | null => {
    if (!o || typeof o !== 'object') return `${at} missing`;
    for (const k of keys) if (!TWO_DP(o[k])) return `${at}.${k} must be a non-negative amount with at most 2 decimals`;
    return null;
  };
  const s = d.sup_details;
  const e =
    need(s?.osup_det, ['txval', ...HEADS], 'sup_details.osup_det') ??
    need(s?.osup_zero, ['txval', 'iamt', 'csamt'], 'sup_details.osup_zero') ??
    need(s?.osup_nil_exmp, ['txval'], 'sup_details.osup_nil_exmp') ??
    need(s?.isup_rev, ['txval', ...HEADS], 'sup_details.isup_rev') ??
    need(s?.osup_nongst, ['txval'], 'sup_details.osup_nongst') ??
    need(d.itc_elg?.itc_net, HEADS, 'itc_elg.itc_net') ??
    need(d.intr_ltfee?.intr_details, HEADS, 'intr_ltfee.intr_details');
  if (e) return e;
  const avl = d.itc_elg.itc_avl;
  const rev = d.itc_elg.itc_rev;
  if (!Array.isArray(avl) || ['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH'].some((t) => !avl.find((x: any) => x.ty === t))) return 'itc_elg.itc_avl needs IMPG, IMPS, ISRC, ISD, OTH';
  if (!Array.isArray(rev) || ['RUL', 'OTH'].some((t) => !rev.find((x: any) => x.ty === t))) return 'itc_elg.itc_rev needs RUL, OTH';
  for (const h of HEADS) {
    const net = avl.reduce((a: number, x: any) => a + Math.round((x[h] ?? 0) * 100), 0) - rev.reduce((a: number, x: any) => a + Math.round((x[h] ?? 0) * 100), 0);
    if (net !== Math.round(d.itc_elg.itc_net[h] * 100)) return `itc_elg.itc_net.${h} is not itc_avl − itc_rev`;
  }
  if (!Array.isArray(d.inward_sup?.isup_details)) return 'inward_sup.isup_details missing';
  return null;
}

export async function fakeGstSuvidhaProvider(opts: { gstin: string; username?: string; signatory_pan?: string; tokenMinutes?: number }): Promise<FakeGsp> {
  const client_id = 'gsp_client_' + randomBytes(4).toString('hex');
  const client_secret = 'gsp_secret_' + randomBytes(8).toString('hex');
  const username = opts.username ?? 'acme.traders';
  const signatory_pan = opts.signatory_pan ?? opts.gstin.slice(2, 12);
  const tokens = new Map<string, number>(); // token → expires at
  let lastEvcOtp: string | null = null;
  let lastAuthOtp: string | null = null;
  const otp = () => String(100000 + (randomBytes(4).readUInt32BE() % 900000));
  const state: Omit<FakeGsp, 'url' | 'close' | 'expireTokens' | 'actions' | 'lastOtp'> = {
    client_id,
    client_secret,
    username,
    gstin: opts.gstin,
    signatory_pan,
    saved: new Map(),
    filings: [],
    requests: [],
    otpsSent: [],
    fault: null,
    hangMs: 3_000,
    refuseRefresh: false,
  };
  const ok = (c: Context, data: unknown) => c.json({ status_cd: '1', data });
  const err = (c: Context, http: number, code: string, message: string) => c.json({ status_cd: '0', error: { error_cd: code, message } }, http as any);
  const newToken = () => {
    const t = 'tok_' + randomBytes(12).toString('hex');
    tokens.set(t, Date.now() + (opts.tokenMinutes ?? 360) * 60_000);
    return t;
  };
  const live = (c: Context) => {
    const t = c.req.header('auth-token');
    const exp = t ? tokens.get(t) : undefined;
    return !!exp && exp > Date.now();
  };

  const app = new Hono();
  // Record, check the GSP client and taxpayer headers, apply outages.
  app.use('*', async (c, next) => {
    let action: string | null = c.req.query('action') ?? null;
    if (!action && c.req.method !== 'GET') {
      try {
        action = (await c.req.raw.clone().json())?.action ?? null;
      } catch {
        action = null;
      }
    }
    const rec = { method: c.req.method, path: c.req.path, action, token: !!c.req.header('auth-token'), status: 0 };
    state.requests.push(rec);
    let res: Response | void;
    if (state.fault === 'outage') res = err(c, 503, 'SYS503', 'service unavailable');
    else if (c.req.header('clientid') !== client_id || c.req.header('client-secret') !== client_secret) res = err(c, 401, 'AUTH4031', 'invalid client credentials');
    else if (c.req.header('username') !== username || c.req.header('gstin') !== opts.gstin || c.req.header('state-cd') !== opts.gstin.slice(0, 2) || !c.req.header('txn')) {
      res = err(c, 400, 'RET11416', 'taxpayer headers missing or wrong');
    } else {
      await next();
      res = undefined;
    }
    if (res) {
      rec.status = res.status;
      return res;
    }
    rec.status = c.res.status;
  });

  // ── authentication ──
  app.post('/taxpayerapi/v1.0/authenticate', async (c) => {
    const b = await c.req.json();
    switch (b.action) {
      case 'OTPREQUEST':
        if (b.username !== username) return err(c, 400, 'AUTH158', 'invalid username');
        lastAuthOtp = otp();
        state.otpsSent.push({ purpose: 'auth', otp: lastAuthOtp, at: Date.now() });
        return ok(c, { status_cd: '1' });
      case 'AUTHTOKEN':
        if (!lastAuthOtp || b.otp !== lastAuthOtp) return err(c, 401, 'AUTH4034', 'invalid OTP');
        lastAuthOtp = null;
        return ok(c, { auth_token: newToken(), expiry: opts.tokenMinutes ?? 360, sek: randomBytes(16).toString('base64') });
      case 'REFRESHTOKEN': {
        if (state.refuseRefresh || !tokens.has(b.auth_token)) return err(c, 401, 'AUTH4033', 'invalid session; login again');
        tokens.delete(b.auth_token);
        return ok(c, { auth_token: newToken(), expiry: opts.tokenMinutes ?? 360 });
      }
      case 'EVCOTP':
        if (!live(c)) return err(c, 401, 'AUTH4033', 'Invalid Session');
        if (b.pan !== signatory_pan) return err(c, 400, 'RT-EVC-01', 'PAN is not an authorised signatory');
        lastEvcOtp = otp();
        state.otpsSent.push({ purpose: 'evc', otp: lastEvcOtp, at: Date.now() });
        return ok(c, { status_cd: '1' });
      default:
        return err(c, 400, 'AUTH400', `unknown action ${b.action}`);
    }
  });

  // ── GSTR-3B ──
  app.put('/taxpayerapi/v1.1/returns/gstr3b', async (c) => {
    if (!live(c)) return err(c, 401, 'AUTH4033', 'Invalid Session');
    const b = await c.req.json();
    const period = c.req.header('ret_period') ?? '';
    if (b.action !== 'RETSAVE') return err(c, 400, 'RET400', 'unknown action');
    if (state.fault === 'save_invalid') return err(c, 422, 'RET191106', 'validation failed: the return is not accepted');
    if (state.filings.find((f) => f.ret_period === period)) return err(c, 400, 'RT-3BSV-1003', 'return already filed for the period');
    const bad = gstnCheck3b(b.data, opts.gstin, period);
    if (bad) return err(c, 400, 'RET191106', `invalid return: ${bad}`);
    const reference_id = 'REF' + randomBytes(6).toString('hex').toUpperCase();
    state.saved.set(period, { data: structuredClone(b.data), reference_id, submitted: false, polls: 0 });
    return ok(c, { reference_id });
  });
  app.get('/taxpayerapi/v1.1/returns/gstr3b', (c) => {
    if (!live(c)) return err(c, 401, 'AUTH4033', 'Invalid Session');
    if (c.req.query('action') !== 'RETSUM') return err(c, 400, 'RET400', 'unknown action');
    const s = state.saved.get(c.req.query('ret_period') ?? '');
    if (!s) return err(c, 404, 'RET13510', 'no return saved for the period');
    // The portal's summary: the saved figures plus fields it computes.
    return ok(c, { ...structuredClone(s.data), qn: {}, tx_pmt: { tx_py: [] } });
  });
  app.post('/taxpayerapi/v1.1/returns/gstr3b', async (c) => {
    if (!live(c)) return err(c, 401, 'AUTH4033', 'Invalid Session');
    const b = await c.req.json();
    const period = c.req.header('ret_period') ?? '';
    const s = state.saved.get(period);
    if (b.action === 'RETSUBMIT') {
      if (!s) return err(c, 400, 'RET13510', 'no return saved for the period');
      s.submitted = true;
      return ok(c, { reference_id: s.reference_id });
    }
    if (b.action !== 'RETFILE') return err(c, 400, 'RET400', 'unknown action');
    if (state.filings.find((f) => f.ret_period === period)) return err(c, 400, 'RT-3BFL-1004', 'return already filed for the period');
    if (!s || !s.submitted) return err(c, 400, 'RT-3BFL-1001', 'return not submitted');
    if (b.st !== 'EVC' || !lastEvcOtp || b.sid !== `${signatory_pan}|${lastEvcOtp}`) return err(c, 400, 'RT-EVC-02', 'EVC verification failed');
    lastEvcOtp = null;
    if (JSON.stringify(b.data?.sup_details) !== JSON.stringify(s.data.sup_details)) return err(c, 400, 'RT-3BFL-1002', 'filed data differs from the saved return');
    const arn = `AA${opts.gstin.slice(0, 2)}${period.slice(0, 2)}${period.slice(4, 6)}${randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 15);
    const now = new Date();
    state.filings.push({ ret_period: period, arn, data: structuredClone(b.data), dof: `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}` });
    const f = state.fault;
    if (f === 'file_drop') {
      state.fault = null;
      return err(c, 504, 'SYS504', 'upstream gateway timeout');
    }
    if (f === 'file_then_outage') {
      state.fault = 'outage';
      return err(c, 503, 'SYS503', 'service unavailable');
    }
    if (f === 'file_hang') {
      state.fault = null;
      await new Promise((r) => setTimeout(r, state.hangMs));
    }
    return ok(c, { ack_num: arn });
  });

  // ── status and tracking ──
  app.get('/taxpayerapi/v0.3/returns', (c) => {
    if (!live(c)) return err(c, 401, 'AUTH4033', 'Invalid Session');
    const period = c.req.query('ret_period') ?? '';
    if (c.req.query('action') === 'RETSTATUS') {
      const s = [...state.saved.values()].find((x) => x.reference_id === c.req.query('ref_id'));
      if (!s) return err(c, 404, 'RET11417', 'no such reference');
      s.polls += 1;
      return ok(c, { status_cd: s.polls === 1 ? 'IP' : 'P' });
    }
    if (c.req.query('action') === 'RETTRACK') {
      const list = state.filings
        .filter((f) => f.ret_period === period && (c.req.query('type') ?? 'R3B') === 'R3B')
        .map((f) => ({ valid: 'Y', mof: 'ONLINE', dof: f.dof, rtntype: 'GSTR3B', ret_prd: f.ret_period, arn: f.arn, status: 'Filed' }));
      return ok(c, { EFiledlist: list });
    }
    return err(c, 400, 'RET400', 'unknown action');
  });

  const { url, server } = await new Promise<{ url: string; server: any }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ url: `http://127.0.0.1:${info.port}`, server: s }));
  });
  return Object.assign(state, {
    url,
    // Expired, but still refreshable (REFRESHTOKEN works until refuseRefresh).
    expireTokens: () => {
      for (const t of tokens.keys()) tokens.set(t, Date.now() - 1);
    },
    lastOtp: (purpose: 'auth' | 'evc') => [...state.otpsSent].reverse().find((o) => o.purpose === purpose)?.otp ?? null,
    actions: (name: string) => state.requests.filter((r) => r.action === name).length,
    close: () => closeServer(server),
  }) as FakeGsp;
}
