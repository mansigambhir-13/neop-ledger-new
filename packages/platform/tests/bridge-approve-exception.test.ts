// bridge-approve-exception.test · v3 §5/§16 "only a person can say yes; the reasoning agent never approves".
// 016's per-bridge may_approve stays, but as an EXPLICIT exception: with NEOS_ENV=production an admin cannot
// grant it (403 bridge_approve_not_allowed) unless the platform runs with NEOS_ALLOW_BRIDGE_APPROVE=1, and then
// the grant is audited `chat.bridge_approve_exception`. At runtime a row that says may_approve counts as false
// in production without the flag (the flag is read live, so dropping it revokes every grant at once).
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, roleUrl } from '@neop/pgkit';
import { bridgeApproveAllowed, ChatClient, chatClientRoutes, generateSigningKeys, migratePlatform, Platform } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let p: Platform;
let c: pg.Client;
let co = '';
let admin = { id: '', token: '' };
const BRIDGE = '@reasoning_agent:hs.test';
const env = { ...process.env };

beforeAll(async () => {
  db = await createTestDatabase();
  await migratePlatform(db.adminUrl);
  p = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: await generateSigningKeys(), dbPoolSize: 3 });
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
  co = (await p.createCompany('Acme')).id;
  admin = await p.createUser(co, { name: 'Priya', email: 'p@x', role: 'admin' });
  const manifest = { app: 'ledger', name: 'Ledger', subject: 'books', description: 'd', version: '1.0.0', contract_version: '1', abilities: [], doors: [], uses: [], skills: [], packages: [], blocks: [] };
  await p.registerApp({ key: 'ledger', l3_url: 'http://l3', manifest: manifest as any, service_secret: 's' });
  await p.installApp(co, 'ledger');
});
afterEach(() => {
  process.env.NEOS_ENV = env.NEOS_ENV;
  process.env.NEOS_ALLOW_BRIDGE_APPROVE = env.NEOS_ALLOW_BRIDGE_APPROVE;
  if (env.NEOS_ENV === undefined) delete process.env.NEOS_ENV;
  if (env.NEOS_ALLOW_BRIDGE_APPROVE === undefined) delete process.env.NEOS_ALLOW_BRIDGE_APPROVE;
});
afterAll(async () => {
  await p?.stop();
  await c?.end();
  await db?.drop();
});

const routes = () => chatClientRoutes(p, () => []);
async function put(body: Record<string, unknown>) {
  const res = await routes().request('/api/chat/allowlist', { method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
const grant = { app: 'ledger', matrix_id: BRIDGE, kind: 'bridge', may_approve: true };
const audits = async (action: string) => (await c.query('select outcome, detail from neos.audit where action = $1 order by id', [action])).rows;

describe('the policy', () => {
  it('outside production a bridge may be granted; in production only with the flag', () => {
    expect(bridgeApproveAllowed({ NEOS_ENV: 'test' })).toBe(true);
    expect(bridgeApproveAllowed({})).toBe(true);
    expect(bridgeApproveAllowed({ NEOS_ENV: 'production' })).toBe(false);
    expect(bridgeApproveAllowed({ NEOS_ENV: 'production', NEOS_ALLOW_BRIDGE_APPROVE: '0' })).toBe(false);
    expect(bridgeApproveAllowed({ NEOS_ENV: 'production', NEOS_ALLOW_BRIDGE_APPROVE: 'true' })).toBe(false); // exactly 1
    expect(bridgeApproveAllowed({ NEOS_ENV: 'production', NEOS_ALLOW_BRIDGE_APPROVE: '1' })).toBe(true);
  });
});

describe('PUT /api/chat/allowlist may_approve:true', () => {
  it('in production without the flag: 403 bridge_approve_not_allowed, nothing written; a plain bridge entry still works', async () => {
    process.env.NEOS_ENV = 'production';
    delete process.env.NEOS_ALLOW_BRIDGE_APPROVE;
    const r = await put({ ...grant, acts_for: admin.id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('bridge_approve_not_allowed');
    expect((await c.query('select count(*)::int n from neos.chat_allowlist')).rows[0].n).toBe(0);
    expect((await audits('chat.bridge_approve_exception')).map((x) => x.outcome)).toEqual(['refused']);
    const plain = await put({ app: 'ledger', matrix_id: BRIDGE, kind: 'bridge', acts_for: admin.id });
    expect(plain).toMatchObject({ status: 200, body: { may_approve: false } });
  });

  it('in production with NEOS_ALLOW_BRIDGE_APPROVE=1: allowed and audited as the exception', async () => {
    process.env.NEOS_ENV = 'production';
    process.env.NEOS_ALLOW_BRIDGE_APPROVE = '1';
    const r = await put({ ...grant, acts_for: admin.id });
    expect(r).toMatchObject({ status: 200, body: { may_approve: true } });
    const ex = await audits('chat.bridge_approve_exception');
    expect(ex.map((x) => x.outcome)).toEqual(['refused', 'granted']);
    expect(ex[1].detail).toMatchObject({ matrix_id: BRIDGE, acts_for: admin.id });
  });

  it('outside production: allowed as before (016), not an exception', async () => {
    process.env.NEOS_ENV = 'test';
    const r = await put({ ...grant, acts_for: admin.id });
    expect(r).toMatchObject({ status: 200, body: { may_approve: true } });
    expect((await audits('chat.bridge_approve_exception')).length).toBe(2);
  });
});

describe('client-sync at runtime', () => {
  it('a may_approve row counts as false in production without the flag, and as true with it', async () => {
    const cl = new ChatClient(p, { account: '@ledger:hs.test', company: co, app: 'ledger', accessToken: 't' }, { homeserverUrl: 'http://hs.invalid' });
    cl.companyId = co;
    const x = cl as any;
    expect((await c.query('select may_approve from neos.chat_allowlist where matrix_id = $1', [BRIDGE])).rows[0].may_approve).toBe(true);
    process.env.NEOS_ENV = 'production';
    delete process.env.NEOS_ALLOW_BRIDGE_APPROVE;
    expect(await x.mayApprove(BRIDGE)).toBe(false);
    expect((await x.senderOf(BRIDGE)).mayApprove).toBe(false);
    process.env.NEOS_ALLOW_BRIDGE_APPROVE = '1';
    expect(await x.mayApprove(BRIDGE)).toBe(true);
    expect((await x.senderOf(BRIDGE)).mayApprove).toBe(true);
    process.env.NEOS_ENV = 'test';
    delete process.env.NEOS_ALLOW_BRIDGE_APPROVE;
    expect(await x.mayApprove(BRIDGE)).toBe(true);
  });
});
