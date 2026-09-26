// web.test · the operator console's BFF: sign-in, cookie handling, CSRF, what it forwards,
// and the whole loop a person drives from the console (ask → proposal → yes → books).
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer } from '@neop/pgkit';
import { toolName } from '@neop/testkit';
import { webApp } from '../web/server.ts';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
let web: ReturnType<typeof serve>;
let base = '';
let cookie = '';

beforeAll(async () => {
  P = await bootPilot();
  web = serve({ fetch: webApp({ platformUrl: P.platformUrl }).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => web.once('listening', r));
  base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (web) await closeServer(web as any);
  await P?.close();
});

const H = { 'x-neos-web': '1', 'content-type': 'application/json' };
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H) =>
  fetch(base + path, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
const read = async (ability: string, args: unknown = {}) => (await (await call('POST', `/api/apps/ledger/read/${ability}`, args)).json()).result;

describe('sign-in', () => {
  it('serves the login page with strict security headers; the console needs a session', async () => {
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/login');
    const login = await fetch(`${base}/login`);
    expect(login.status).toBe(200);
    expect(login.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(login.headers.get('content-security-policy')).not.toMatch(/unsafe-inline/);
    expect(login.headers.get('x-frame-options')).toBe('DENY');
  });

  it('refuses a wrong token and sets no cookie', async () => {
    const r = await call('POST', '/auth/login', { token: 'nope' });
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('a desk token becomes an httpOnly, SameSite=Strict cookie and is never echoed back', async () => {
    const r = await call('POST', '/auth/login', { token: P.admin.token });
    expect(r.status).toBe(200);
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(await r.json())).not.toContain(P.admin.token);
    cookie = set.split(';')[0]!;
    const me = await (await call('GET', '/api/me')).json();
    expect(me.role).toBe('admin');
    expect(me.company.name).toBeTruthy();
  });
});

describe('what it forwards', () => {
  it('changes need the custom header (CSRF), even with the cookie', async () => {
    const r = await call('POST', '/api/ask', { text: 'hi' }, { 'content-type': 'application/json' });
    expect(r.status).toBe(403);
  });

  it('never forwards internal, operator or discovery routes', async () => {
    for (const p of ['/api/ops/keys/rotate', '/api/registry/packages', '/api/grants', '/api/acl', '/api/internal/x']) {
      expect((await call('POST', p, {})).status, p).toBe(404);
    }
    expect((await fetch(`${base}/internal/switchboard`, { headers: { cookie } })).status).toBe(404);
  });

  it('reads go through the gateway as the person: seeded books, the new rules read, floors', async () => {
    const rules = await read('ledger.coding_rules.list');
    expect(rules.rules.map((r: any) => r.pattern).sort()).toEqual(['AWS', 'CHARGES']);
    const { abilities } = await (await call('GET', '/api/apps/ledger/abilities')).json();
    expect(abilities).toHaveLength(30);
    const post = abilities.find((a: any) => a.key === 'ledger.journal.post');
    expect(post).toMatchObject({ kind: 'write', floor: 'ask_first', setting: 'ask_first' });
  });

  it('the team list is admin-only and never carries tokens', async () => {
    const r = await (await call('GET', '/api/users')).json();
    expect(r.users.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(r)).not.toMatch(/token/);
    const member = await fetch(`${P.platformUrl}/api/users`, { headers: { authorization: `Bearer ${P.member.token}` } });
    expect(member.status).toBe(403);
  });
});

describe('the loop a person drives from the console', () => {
  it('ask → Ledger proposes → the card is answered through the console → the books change once', async () => {
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Account 6550 created.' } };
      if (v.calls === 0) return { tool: toolName('ledger.account.create'), args: { code: '6550', name: 'Courier charges', type: 'expense', subtype: 'opex', card: { what: 'Add account 6550 Courier charges', why: 'You asked for it', changes: 'A new expense account', if_no_answer: 'Nothing is created' } } };
      return v.results.some((r) => r.text.includes('Proposal ')) ? { text: 'waiting for a yes' } : { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };
    });
    const asked = await (await call('POST', '/api/ask', { text: 'Create account 6550 Courier charges', app: 'ledger' })).json();
    expect(asked.task_id).toBeTruthy();

    // The conversation streams through the BFF (SSE passes straight through).
    const sse = await fetch(`${base}/api/conversations/${asked.conversation_id}/events`, { headers: { cookie } });
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = sse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^(id|event|data):/m);
    await reader.cancel();

    const card = await P.waitFor(async () => {
      const t = (await (await call('GET', `/api/tasks/${asked.task_id}`)).json()).task;
      if (['FAILED', 'COMPLETED'].includes(t.status)) throw new Error(`task ended ${t.status}: ${JSON.stringify(t.result)}`);
      const { cards } = await (await call('GET', '/api/desk')).json();
      return cards.find((c: any) => c.task_id === asked.task_id && c.status === 'PENDING');
    }, 'card on the desk');
    expect(card.ability_key).toBe('ledger.account.create');
    expect((await read('ledger.accounts.list')).accounts.some((a: any) => a.code === '6550')).toBe(false);

    const yes = await call('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(yes.status).toBe(200);
    await P.waitFor(async () => (await read('ledger.accounts.list')).accounts.some((a: any) => a.code === '6550'), 'account created');
    await P.waitFor(async () => (await (await call('GET', `/api/tasks/${asked.task_id}`)).json()).task.status === 'COMPLETED', 'task completed');
    expect((await read('ledger.accounts.list')).accounts.filter((a: any) => a.code === '6550')).toHaveLength(1);
  });

  it('an admin tightens a control from the console; loosening below the floor is refused', async () => {
    const ok = await call('PUT', '/api/switchboards/ledger', { settings: { 'ledger.party.create': 'ask_first' } });
    expect(ok.status).toBe(200);
    const { abilities } = await (await call('GET', '/api/apps/ledger/abilities')).json();
    expect(abilities.find((a: any) => a.key === 'ledger.party.create').setting).toBe('ask_first');
    const bad = await call('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'on' } });
    expect(bad.status).toBe(422);
  });

  it('logout clears the session; a revoked or bad cookie is dropped', async () => {
    const out = await call('POST', '/auth/logout');
    expect(out.headers.get('set-cookie')).toMatch(/neos_desk=;|Max-Age=0/);
    const saved = cookie;
    cookie = 'neos_desk=forged';
    const r = await call('GET', '/api/me');
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toMatch(/neos_desk=;|Max-Age=0/);
    cookie = saved;
  });
});
