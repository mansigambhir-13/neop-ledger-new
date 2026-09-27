// verify-install.test · scripts/verify-install.ts, the read-only post-install check (ported from 930eb38), run
// against the real pilot: a complete install passes; each broken part is a named FAIL with a plain reason, and any
// FAIL makes the whole check fail. It never writes and never prints a secret.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyInstall, type CheckResult } from '../../../scripts/verify-install.ts';
import { ledgerApp } from '../src/index.ts';
import { bootPilot, fakeClientHomeserver, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const by = (rs: CheckResult[]) => Object.fromEntries(rs.map((r) => [r.name, r]));
async function run(env: Record<string, string> = {}, fetchImpl?: any) {
  const lines: string[] = [];
  const r = await verifyInstall({
    app: 'ledger',
    company: P.company.id,
    def: await ledgerApp(),
    env: { NEOS_PLATFORM_URL: P.platformUrl, NEOS_DB_URL: P.adminUrl, NEOP_LLM_UPSTREAM_KEY: 'sk-never-printed', ...env },
    fetchImpl,
    out: (l) => lines.push(l),
  });
  return { ...r, by: by(r.results), text: lines.join('\n') };
}

describe('verify-install (read-only, against a running deployment)', () => {
  it('a complete install passes every check it can make; the table never shows a secret', async () => {
    await P.api('PUT', '/api/vault/email', { secret: { from: 'books@acme.example' } }).catch(() => null);
    const r = await run();
    for (const name of [
      'build: ledger is an app of this build',
      'platform: reachable',
      'database: platform link connects (read-only)',
      `platform: ledger is installed for ${P.company.id}`,
      'database: roles ledger_migrator, ledger_app, ledger_runner',
      'database: grants (app and runner use, never create)',
      "database: schema in step with this build's migrations",
      'switchboard: every line within its floor',
      'llm proxy: provider key present (not read)',
      'backend: /l3/ready, reached as the platform reaches it',
    ]) expect(r.by[name]?.status, `${name}: ${r.by[name]?.detail}`).toBe('PASS');
    expect(['PASS', 'WARN']).toContain(r.by['platform: ledger is registered, active and attested']!.status);
    expect(r.by['matrix: client tokens valid (whoami)']!.status).toBe('SKIP');
    expect(r.text).toMatch(/^STATUS\s+CHECK\s+DETAIL/);
    expect(r.text).not.toContain('sk-never-printed');
    expect(r.text).not.toContain(P.adminUrl);
  });

  it('a switchboard line looser than its floor, a missing key and an unreachable platform are named FAILs; the run fails', async () => {
    // A write whose floor is ask_first, recorded as "on" behind the platform's back (the API would refuse it).
    const m = (await ledgerApp()).manifest;
    const write = m.abilities.find((a) => a.kind === 'write' && a.floor === 'ask_first')!;
    const [cur] = (await P.platform.db.query('select version, settings from neos.switchboards where company_id = $1 and app_key = $2 order by version desc limit 1', [P.company.id, 'ledger'])).rows;
    const v = (cur?.version ?? 0) + 1;
    await P.platform.db.query('insert into neos.switchboards (company_id, app_key, version, settings) values ($1, $2, $3, $4)', [P.company.id, 'ledger', v, { ...(cur?.settings ?? {}), [write.key]: 'on' }]);
    try {
      const r = await run({ NEOP_LLM_UPSTREAM_KEY: '', NEOS_PLATFORM_URL: 'http://127.0.0.1:1' });
      expect(r.ok).toBe(false);
      expect(r.by['switchboard: every line within its floor']).toMatchObject({ status: 'FAIL' });
      expect(r.by['switchboard: every line within its floor']!.detail).toContain(`${write.key} is on, looser than its floor ask_first`);
      expect(r.by['llm proxy: provider key present (not read)']).toMatchObject({ status: 'FAIL' });
      expect(r.by['platform: reachable']).toMatchObject({ status: 'FAIL' });
      expect(r.text).toMatch(/\d+ check\(s\) FAILED/);
    } finally {
      await P.platform.db.query('delete from neos.switchboards where company_id = $1 and app_key = $2 and version = $3', [P.company.id, 'ledger', v]);
    }
  });

  it('MATRIX_MODE=client: each account’s token is checked with whoami — its own account passes, another’s fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-verify-'));
    try {
      await writeFile(path.join(dir, 'tok'), 'tok-ledger\n');
      const accounts = JSON.stringify([{ account: '@ledger:hs.test', company: P.company.id, app: 'ledger', token_file: path.join(dir, 'tok') }]);
      const env = { MATRIX_MODE: 'client', MATRIX_HOMESERVER_URL: 'http://hs.test', MATRIX_CLIENT_ACCOUNTS: accounts };
      const good = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger' });
      const passthrough = (hs: any) => (url: string, init: any) => (url.startsWith('http://hs.test') ? hs.fetchImpl(url, init) : fetch(url, init));
      expect((await run(env, passthrough(good))).by['matrix: client tokens valid (whoami)']).toMatchObject({ status: 'PASS', detail: '@ledger:hs.test' });
      const other = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger', whoamiAs: '@someone_else:hs.test' });
      expect((await run(env, passthrough(other))).by['matrix: client tokens valid (whoami)']!.detail).toContain('belongs to @someone_else:hs.test');
      const expired = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger' });
      expired.expireToken();
      const r = await run(env, passthrough(expired));
      expect(r.by['matrix: client tokens valid (whoami)']).toMatchObject({ status: 'FAIL' });
      expect(r.text).not.toContain('tok-ledger');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
