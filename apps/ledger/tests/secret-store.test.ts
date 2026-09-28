// secret-store.test · v3 §12 "credentials for the doors: the secret store, per (app, company); ops provisions;
// the backend reads at the moment of a call; the assistant never". The backend no longer borrows a key from the
// platform vault: it reads `<root>/<company>/[<app>/]<door>.json` on every call — a rotated file is used on the next
// call, the app's own file wins over the company-wide one, another company's (or another app's) file is never read,
// a missing credential fails the door definitely with nothing sent, and the assistant's session carries no secret.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeResend, toolName, type FakeProvider } from '@neop/testkit';
import { doorSecretPaths, FileSecretStore, MemorySecretStore } from '@neop/template';
import { vaultAad, VaultCipher } from '@neop/platform';
import { bootPilot, type Pilot } from './harness.ts';
import { LEDGER_ROOT } from '../src/index.ts';
import { exportDoorSecrets } from '../../../scripts/v3/export-door-secrets.ts';
import { restoreDoors, sealDoors, writeDoorSecret } from '../../../scripts/v3/door-secrets.ts';

const ROOT = path.join(LEDGER_ROOT, '../..');

let P: Pilot;
let RS: FakeProvider;
const tmp: string[] = [];
beforeAll(async () => {
  RS = await fakeResend();
  P = await bootPilot();
});
afterAll(async () => {
  await P?.close();
  await RS?.close();
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const box = async (name: string) => {
  const d = await mkdtemp(path.join(os.tmpdir(), `neop-box-${name}-`));
  tmp.push(d);
  return d;
};
const inbox = async (dir: string) => (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
const msg = { to: ['cfo@acme.example'], subject: 'hello', text: 'body' };
const email = () => P.backend.core.doors(P.company.id).email;

describe('read per call, from the store, by the backend', () => {
  it('a rotated credential is used on the very next call: no cache beyond the call', async () => {
    const a = await box('a');
    const b = await box('b');
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: a });
    const door = email(); // one door object across both calls, as a long execution would hold it
    await door.send(msg, 'rotate-1');
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: b }); // ops rotates the file
    await door.send(msg, 'rotate-2');
    expect(await inbox(a)).toEqual([expect.stringContaining('rotate-1')]);
    expect(await inbox(b)).toEqual([expect.stringContaining('rotate-2')]);
  });

  it("the app's own credential wins over the company-wide one; without it the company-wide one is used", async () => {
    const shared = await box('shared');
    const own = await box('own');
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: shared });
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: own }, { app: 'ledger' });
    await email().send(msg, 'own-1');
    expect(await inbox(own)).toHaveLength(1);
    expect(await inbox(shared)).toHaveLength(0);
    await P.removeDoorSecret('email', { app: 'ledger' });
    await email().send(msg, 'shared-1');
    expect(await inbox(shared)).toHaveLength(1);
    // Another app's own file is never this app's: marketing's slot is not read by ledger.
    const theirs = await box('marketing');
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: theirs }, { app: 'marketing' });
    await email().send(msg, 'shared-2');
    expect(await inbox(theirs)).toHaveLength(0);
    expect(await inbox(shared)).toHaveLength(2);
    await P.removeDoorSecret('email', { app: 'marketing' });
  });

  it("another company's file is never read: not by the company id, not by a name that climbs out", async () => {
    const other = await P.platform.createCompany('Other Co');
    const theirs = await box('other');
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: theirs }, { company: other.id });
    const store = new FileSecretStore({ root: P.doorsDir, app: 'ledger' });
    expect(await store.get(other.id, 'email')).toMatchObject({ dir: theirs }); // it is there …
    const mine = await store.get(P.company.id, 'email');
    expect(mine?.dir).not.toBe(theirs); // … and never answers for this company
    for (const bad of [`../${other.id}`, `${P.company.id}/../${other.id}`, '..', '.hidden', '']) {
      await expect(store.get(bad, 'email')).rejects.toMatchObject({ code: 'bad_name', definite: true });
    }
    await expect(store.get(P.company.id, `../../${other.id}/email`)).rejects.toMatchObject({ code: 'bad_name' });
    await expect(new FileSecretStore({ root: P.doorsDir, app: 'ledger' }).get(P.company.id, 'email/../x')).rejects.toMatchObject({ code: 'bad_name' });
    // The layout the deploy kit writes: own under the app, company-wide beside it.
    const p = doorSecretPaths('/run/secrets/doors', 'co1', 'ledger', 'email');
    expect(p).toEqual({ own: '/run/secrets/doors/co1/ledger/email.json', company: '/run/secrets/doors/co1/email.json' });
  });
});

describe('a door with no credential', () => {
  it('fails definitely with a clear error and sends nothing — directly and on the approved path', async () => {
    const before = await inbox(P.mailDir);
    await P.removeDoorSecret('email');
    await expect(email().send(msg, 'missing-1')).rejects.toMatchObject({ code: 'no_secret', definite: true, message: expect.stringMatching(/not connected for this company/) });
    // Through the whole path: approved, then FAILED (never UNKNOWN), nothing sent.
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'failed', summary: 'not connected' } };
      return v.calls === 0
        ? { tool: toolName('ledger.close_pack.email'), args: { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: { what: 'send', why: 'asked', changes: 'one email', if_no_answer: 'nothing' } } }
        : { text: 'waiting' };
    });
    const t = await P.ask('send the pack');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    const done = await P.waitFor(async () => (await P.platform.db.query("select status, proof from neos.v_desk_cards where id = $1 and status in ('EXECUTED','FAILED','UNKNOWN','REFUSED')", [card.id])).rows[0], 'executed');
    expect(done.proof.outcome).toBe('FAILED');
    expect(JSON.stringify(done.proof)).toMatch(/not connected/);
    expect(await inbox(P.mailDir)).toEqual(before);
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: P.mailDir });
  });

  it('a credential that is not JSON, or a world-writable file, is refused without echoing it; a group-readable one is warned about', async () => {
    const root = await box('store');
    const warnings: string[] = [];
    const store = new FileSecretStore({ root, app: 'ledger', warn: (m) => warnings.push(m) });
    await mkdir(path.join(root, 'co1'), { recursive: true });
    const f = path.join(root, 'co1', 'email.json');
    await writeFile(f, 'sk-live-NOT-JSON', { mode: 0o600 });
    const e = await store.get('co1', 'email').catch((x) => x);
    expect(e).toMatchObject({ code: 'secret_store', definite: true });
    expect(String(e.message)).not.toContain('sk-live');
    await writeFile(f, JSON.stringify({ provider: 'dev-mailbox', dir: root }));
    await chmod(f, 0o646);
    await expect(store.get('co1', 'email')).rejects.toMatchObject({ message: expect.stringMatching(/world-writable/) });
    await chmod(f, 0o640);
    expect(await store.get('co1', 'email')).toMatchObject({ provider: 'dev-mailbox' });
    expect(warnings).toHaveLength(1);
    await chmod(f, 0o600);
    expect(await store.get('co1', 'nothing')).toBeNull();
  });

  it('the in-memory store keeps the same binding (for tests of other apps)', async () => {
    const m = new MemorySecretStore('ledger');
    m.set('co1', 'email', { v: 'shared' });
    m.set('co1', 'email', { v: 'marketing' }, 'marketing');
    expect(await m.get('co1', 'email')).toEqual({ v: 'shared' });
    m.set('co1', 'email', { v: 'own' }, 'ledger');
    expect(await m.get('co1', 'email')).toEqual({ v: 'own' });
    expect(await m.get('co2', 'email')).toBeNull();
  });
});

describe('the assistant never holds a door credential', () => {
  it('a job that sends through the door: the key is used by the backend, and nothing the assistant is given contains it', async () => {
    const KEY = `${RS.token}`;
    await P.setDoorSecret('email', { provider: 'resend', api_key: KEY, from: 'Acme Books <books@acme.example>', base_url: RS.url });
    let seen = '';
    let token = '';
    P.setBrain((v) => {
      seen += `${v.system}\n${v.job}\n${v.results.map((r) => r.text).join('\n')}\n`;
      if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'sent' } };
      return v.calls === 0
        ? { tool: toolName('ledger.close_pack.email'), args: { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: { what: 'send', why: 'asked', changes: 'one email', if_no_answer: 'nothing' } } }
        : { text: 'waiting' };
    });
    // What the runner hands the agent container: the bundle, a job token, the gate URL and (here, none) an LLM session.
    const origFetch = globalThis.fetch;
    const handed: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith('/sessions') && init?.body) {
        handed.push(String(init.body));
        token = JSON.parse(String(init.body)).token;
      }
      return origFetch(input, init);
    }) as typeof fetch;
    try {
      const t = await P.ask('send the close pack');
      const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card');
      const before = RS.performed.length;
      await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
      await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'completed', 20_000);
      expect(RS.performed.length).toBe(before + 1); // the backend used the key
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(handed.length).toBeGreaterThan(0);
    for (const body of handed) {
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(P.doorsDir);
    }
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(P.doorsDir);
    // The job token names the job, the session, the company and the abilities — nothing else.
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}');
    expect(JSON.stringify(claims)).not.toContain(KEY);
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: P.mailDir });
  });
});

describe('moving to the store, and backing it up', () => {
  it('export-door-secrets opens the platform vault exactly as the platform did and writes 0600 files; it never prints a value', async () => {
    const keys = VaultCipher.generate();
    const cipher = new VaultCipher(keys);
    const co = await P.platform.createCompany('Moving Co');
    const seal = (app: string, door: string, v: Record<string, unknown>) =>
      P.platform.db.query('insert into neos.vault_secrets (company_id, app_key, door, secret) values ($1, $2, $3, $4)', [co.id, app, door, JSON.stringify(cipher.seal(v, vaultAad(co.id, app, door)))]);
    await seal('*', 'email', { provider: 'resend', api_key: 'sk-shared-MOVE-1' });
    await seal('ledger', 'email', { provider: 'resend', api_key: 'sk-ledger-MOVE-2' });
    // A row copied into another slot does not open (AAD): skipped, never written.
    const row = (await P.platform.db.query("select secret from neos.vault_secrets where company_id = $1 and app_key = 'ledger'", [co.id])).rows[0];
    await P.platform.db.query("insert into neos.vault_secrets (company_id, app_key, door, secret) values ($1, 'marketing', 'email', $2)", [co.id, JSON.stringify(row.secret)]);
    const target = await box('export');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/v3/export-door-secrets.ts'), target, '--company', co.id], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, NEOS_DB_URL: P.adminUrl, NEOS_VAULT_KEYS: JSON.stringify(keys) },
      });
    } catch (e: any) {
      out = String(e.stdout ?? '') + String(e.stderr ?? '');
      code = e.status;
    }
    expect(code).toBe(1); // one row could not be opened: said so, not hidden
    expect(out).not.toMatch(/sk-(shared|ledger)-MOVE/);
    const lines = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.app, l.door, l.result])).toEqual([
      [null, 'email', 'written'],
      ['ledger', 'email', 'written'],
      ['marketing', 'email', 'unreadable_skipped'],
    ]);
    const ledger = new FileSecretStore({ root: target, app: 'ledger' });
    const wage = new FileSecretStore({ root: target, app: 'wage' });
    expect(await ledger.get(co.id, 'email')).toEqual({ provider: 'resend', api_key: 'sk-ledger-MOVE-2' });
    expect(await wage.get(co.id, 'email')).toEqual({ provider: 'resend', api_key: 'sk-shared-MOVE-1' });
    for (const rel of [`${co.id}/email.json`, `${co.id}/ledger/email.json`]) expect((await stat(path.join(target, rel))).mode & 0o777).toBe(0o600);
    // Re-running keeps what is there (the store may be newer) unless --overwrite.
    const again = await exportDoorSecrets({ db: P.platform.db, cipher, target, company: co.id });
    expect(again.filter((r) => r.result === 'kept')).toHaveLength(2);
  });

  it('the nightly backup seals the store; restore gives the same files back, 0600; the wrong key opens nothing', async () => {
    const root = await box('doors-src');
    await writeDoorSecret(root, 'co1', 'email', { provider: 'resend', api_key: 'sk-BACKUP-1' });
    await writeDoorSecret(root, 'co1', 'gst_portal', { provider: 'gsp', client_secret: 'cs-BACKUP-2' }, 'ledger');
    const key = randomBytes(32);
    const { blob, files } = await sealDoors(root, key);
    expect(files).toBe(2);
    expect(blob.toString('utf8')).not.toMatch(/BACKUP-|resend|gsp/);
    await expect(restoreDoors(blob, randomBytes(32), await box('nope'))).rejects.toThrow();
    const back = await box('doors-back');
    expect((await restoreDoors(blob, key, back)).sort()).toEqual(['co1/email.json', 'co1/ledger/gst_portal.json']);
    expect(await new FileSecretStore({ root: back, app: 'ledger' }).get('co1', 'gst_portal')).toEqual({ provider: 'gsp', client_secret: 'cs-BACKUP-2' });
    expect((await stat(path.join(back, 'co1/ledger/gst_portal.json'))).mode & 0o777).toBe(0o600);
  });
});
