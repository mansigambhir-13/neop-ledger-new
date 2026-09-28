// vault-per-app.test · WP §12 "credentials for the doors: the secret store, per (app, company)".
// 015 keys the vault by (company_id, app_key, door). Rows written before it become company-wide
// ('*') and still open; an app borrows its own key when it has one, else the company-wide one,
// and never another app's. Two apps with the same door name hold different keys.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate, roleUrl } from '@neop/pgkit';
import { generateSigningKeys, migratePlatform, Platform, platformApp, PLATFORM_MIGRATIONS, VaultCipher } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dirBefore = '';
let c: pg.Client;
let p: Platform;
const keys = VaultCipher.generate();
let co = '';
let other = '';
let token = '';

const manifest = (key: string, doors: string[]) => JSON.stringify({ app: key, name: key, abilities: [], doors: doors.map((d) => ({ key: d, scopes: [] })), uses: [], skills: [], packages: [], blocks: [] });

beforeAll(async () => {
  db = await createTestDatabase();
  dirBefore = await mkdtemp(path.join(os.tmpdir(), 'neos-pre015-'));
  await cp(PLATFORM_MIGRATIONS, dirBefore, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dirBefore, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '015')) await rm(path.join(dirBefore, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '015');
  await writeFile(path.join(dirBefore, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await p?.stop();
  await c?.end();
  await db?.drop();
  if (dirBefore) await rm(dirBefore, { recursive: true, force: true });
});

describe('015 on a populated vault', () => {
  it('existing sealed rows become company-wide, keep their bytes and still open', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dirBefore }, tenantLint: false });
    co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    other = (await c.query("insert into neos.companies (name, slug) values ('Beta', 'beta') returning id")).rows[0].id;
    for (const [k, doors] of [['ledger', ['email', 'gst_portal']], ['marketing', ['email', 'social']], ['wage', ['email']]] as const) {
      await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ($1, 'http://l3', $2, '1', 'h')", [k, manifest(k, [...doors])]);
      for (const company of [co, other]) await c.query('insert into neos.installs (company_id, app_key) values ($1, $2)', [company, k]);
    }
    // What the platform wrote before 015: sealed under "<company>:<door>".
    const cipher = new VaultCipher(keys);
    for (const [company, door, v] of [[co, 'email', 'acme-shared'], [co, 'gst_portal', 'acme-gst'], [other, 'email', 'beta-shared']] as const) {
      await c.query('insert into neos.vault_secrets (company_id, door, secret) values ($1, $2, $3)', [company, door, JSON.stringify(cipher.seal({ provider: 'x', v }, `${company}:${door}`))]);
    }
    const before = (await c.query('select company_id, door, secret::text, updated_at from neos.vault_secrets order by company_id, door')).rows;

    const applied = await migratePlatform(db.adminUrl);
    expect(applied.map((m) => m.name)).toContain('015_vault_per_app.sql');
    const after = (await c.query('select company_id, app_key, door, secret::text, updated_at from neos.vault_secrets order by company_id, door')).rows;
    expect(after).toEqual(before.map((r) => ({ ...r, app_key: '*' })));
    const pk = (await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'vault_secrets_pkey'")).rows[0].d;
    expect(pk).toBe('PRIMARY KEY (company_id, app_key, door)');

    p = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: await generateSigningKeys(), vaultKeys: keys, dbPoolSize: 3 });
    // Every app that declares the door borrows the company-wide key, as before.
    expect(await p.lend('ledger', co, 'email')).toEqual({ provider: 'x', v: 'acme-shared' });
    expect(await p.lend('marketing', co, 'email')).toEqual({ provider: 'x', v: 'acme-shared' });
    expect(await p.lend('ledger', other, 'email')).toEqual({ provider: 'x', v: 'beta-shared' });
    expect(await p.rekeyVault()).toBe(0); // already under the active key; the company-wide AAD still matches
  });
});

describe('keys per (company, app, door)', () => {
  it('two apps with the same door name get different keys; a third without its own gets the company-wide one', async () => {
    await p.setVaultSecret(co, 'email', { provider: 'resend', v: 'ledger-own' }, 'ledger');
    await p.setVaultSecret(co, 'email', { provider: 'resend', v: 'marketing-own' }, 'marketing');
    expect((await p.lend('ledger', co, 'email')).v).toBe('ledger-own');
    expect((await p.lend('marketing', co, 'email')).v).toBe('marketing-own');
    expect((await p.lend('wage', co, 'email')).v).toBe('acme-shared');
    // Another company is its own world.
    expect((await p.lend('ledger', other, 'email')).v).toBe('beta-shared');
    const audit = (await c.query("select app_key, detail from neos.audit where action = 'vault.lend' and ability_key = 'email' and company_id = $1 order by id desc limit 3", [co])).rows;
    expect(audit.map((a) => [a.app_key, a.detail.slot])).toEqual([['wage', 'company'], ['marketing', 'app'], ['ledger', 'app']]);
  });

  it('an app cannot read another app’s credential — not by lending, not by a row moved between slots', async () => {
    await p.setVaultSecret(co, 'social', { provider: 'x', v: 'marketing-social' }, 'marketing');
    // ledger does not declare social; wage neither: refused before the vault is read.
    await expect(p.lend('ledger', co, 'social')).rejects.toThrow(/does not declare/);
    // A door ledger declares but only marketing holds a key for (and no company-wide one): nothing.
    await p.setVaultSecret(co, 'gst_portal', { provider: 'x', v: 'marketing-gst' }, 'marketing');
    await c.query("delete from neos.vault_secrets where company_id = $1 and app_key = '*' and door = 'gst_portal'", [co]);
    await expect(p.lend('ledger', co, 'gst_portal')).rejects.toThrow(/no gst_portal credential for ledger/);
    // A sealed row copied into another app's slot does not open: the AAD binds company, app and door.
    const row = (await c.query("select secret from neos.vault_secrets where company_id = $1 and app_key = 'marketing' and door = 'gst_portal'", [co])).rows[0];
    await c.query("insert into neos.vault_secrets (company_id, app_key, door, secret) values ($1, 'ledger', 'gst_portal', $2)", [co, JSON.stringify(row.secret)]);
    await expect(p.lend('ledger', co, 'gst_portal')).rejects.toThrow();
    await c.query("delete from neos.vault_secrets where company_id = $1 and app_key = 'ledger' and door = 'gst_portal'", [co]);
    // Taking marketing's own email key away falls back to the company-wide one, never to ledger's.
    await c.query("delete from neos.vault_secrets where company_id = $1 and app_key = 'marketing' and door = 'email'", [co]);
    expect((await p.lend('marketing', co, 'email')).v).toBe('acme-shared');
  });

  it('the desk API: PUT /api/vault/<door>?app=<key> for one app (installed, door declared), without it company-wide; GET lists owners, never secrets', async () => {
    token = (await p.createUser(co, { name: 'Priya', email: 'priya@acme.example', role: 'admin' })).token;
    const member = (await p.createUser(co, { name: 'Rahul', email: 'rahul@acme.example', role: 'member' })).token;
    const web = platformApp(p);
    const put = (url: string, body: unknown, t = token) => web.request(url, { method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await put('/api/vault/email?app=wage', { provider: 'resend', v: 'wage-own' });
    expect(r.status).toBe(200);
    // Deprecated with v3 (S8): still stored, but the answer says no backend reads it any more.
    expect(await r.json()).toEqual({ ok: true, door: 'email', app: 'wage', provider: 'resend', deprecated: expect.stringMatching(/secret store/) });
    expect((await p.lend('wage', co, 'email')).v).toBe('wage-own');
    expect((await put('/api/vault/social?app=ledger', { provider: 'x' })).status).toBe(422); // ledger declares no social door
    expect((await put('/api/vault/email?app=nosuch', { provider: 'x' })).status).toBe(403); // not installed
    expect((await put('/api/vault/email?app=wage', { provider: 'x' }, member)).status).toBe(403); // admins only
    expect((await put('/api/vault/email', { provider: 'resend', v: 'acme-shared-2' })).status).toBe(200);
    expect((await p.lend('marketing', co, 'email')).v).toBe('acme-shared-2');
    expect((await p.lend('wage', co, 'email')).v).toBe('wage-own');
    const list = await (await web.request('/api/vault', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(list.doors.map((d: { door: string; app: string | null }) => [d.door, d.app])).toEqual([
      ['email', null],
      ['email', 'ledger'],
      ['email', 'wage'],
      ['gst_portal', 'marketing'],
      ['social', 'marketing'],
    ]);
    expect(JSON.stringify(list)).not.toContain('acme-shared');
  });
});
