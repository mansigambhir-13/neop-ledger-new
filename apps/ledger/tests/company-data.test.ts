// company-data.test · WP §11, the DBA's company-scoped tools:
//   personal data — columns tagged in the manifest (personal_data) are what export (subject access)
//     and erase touch: only those columns, only that company; money and journals stay intact
//     (names are pseudonymised, rows are never deleted); each run is audited.
//   uninstall — `ops.ts uninstall <company> <app> [--purge] [--yes]`: dry run by default; --yes marks
//     the install removed (no routing, no offering); --purge takes a backup, then deletes that
//     company's rows from every table in the app's schema, children first. Other companies untouched.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalDataProblems } from '@neop/contracts';
import { eraseSubject, importCompany, roleUrl, tablesInOrder, type CompanyDump } from '@neop/pgkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifest, seedLedger } from '../src/index.ts';
import { bootPilot, finish, type Pilot } from './harness.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let P: Pilot;
let adm: pg.Client;
let B: { id: string; token: string };
let backupDir: string;
const tags = manifest.personal_data!;

beforeAll(async () => {
  P = await bootPilot();
  const co = await P.platform.createCompany('Beta Traders', 'Asia/Kolkata');
  const u = await P.platform.createUser(co.id, { name: 'Bea', email: 'bea@beta.example', role: 'admin' });
  await P.platform.installApp(co.id, 'ledger', u.id);
  await seedLedger(P.backend.core.appPool, co.id);
  B = { id: co.id, token: u.token };
  adm = new pg.Client({ connectionString: P.adminUrl });
  await adm.connect();
  backupDir = await mkdtemp(path.join(os.tmpdir(), 'neop-uninstall-'));
});
afterAll(async () => {
  await adm?.end();
  await P?.close();
  await rm(backupDir, { recursive: true, force: true });
});

function tsx(script: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      path.join(root, 'node_modules/.bin/tsx'),
      [script, ...args],
      { cwd: root, timeout: 60_000, env: { ...process.env, NEOS_ENV: 'test', NEOS_ADMIN_URL: P.adminUrl, NEOS_DB_URL: roleUrl(P.adminUrl, 'neos_app') } },
      (e, out, err) => resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out, err }),
    );
  });
}

/** Every row of every company_id table in the ledger schema, for one company, as JSON. */
async function snapshot(companyId: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of await tablesInOrder(adm, 'ledger')) {
    out[t] = (await adm.query(`select to_jsonb(x) as r from ledger.${t} x where company_id = $1 order by to_jsonb(x)::text`, [companyId])).rows.map((r) => r.r);
  }
  return out;
}
const tb = async (token: string) => (await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, token)).body.result;

describe('personal data is tagged in the manifest', () => {
  it('the contract validates the tags; Ledger tags the party columns that identify a person; registration refuses bad tags', async () => {
    expect(personalDataProblems(manifest)).toEqual([]);
    expect(tags).toEqual([{ table: 'parties', columns: ['name', 'email', 'gstin'], subject_key: 'id' }]);
    expect(personalDataProblems({ personal_data: [{ table: 'ledger.parties', columns: [], subject_key: 'name' }] as any })).toHaveLength(2);
    expect(personalDataProblems({ personal_data: [{ table: 'parties', columns: ['name'], subject_key: 'name' }] })[0]).toMatch(/cannot also be a personal column/);
    expect(personalDataProblems({ personal_data: [{ table: 'parties', columns: ['company_id'], subject_key: 'id' }] })[0]).toMatch(/company_id/);
    // Every tagged table and column exists in the migrated schema.
    for (const t of tags) {
      const cols = (await adm.query("select column_name from information_schema.columns where table_schema = 'ledger' and table_name = $1", [t.table])).rows.map((r) => r.column_name);
      for (const c of [t.subject_key, ...t.columns]) expect(cols).toContain(c);
    }
    const bad = { ...manifest, personal_data: [{ table: 'parties', columns: ['name'], subject_key: 'name' }] };
    await expect(P.platform.registerApp({ key: 'ledger', l3_url: 'http://127.0.0.1:1', manifest: bad, service_secret: 'z'.repeat(40) })).rejects.toThrow(/personal column/);
  });
});

describe('export and erase one data subject', () => {
  let party: { id: string; name: string };

  it('export (subject access) returns only the tagged columns of that company, and is audited', async () => {
    party = (await adm.query("select id, name from ledger.parties where company_id = $1 and name = 'Kapoor Traders'", [P.company.id])).rows[0];
    await adm.query("update ledger.parties set gstin = '27ABCDE1234F1Z5' where id = $1", [party.id]);
    const r = await tsx('scripts/erase.ts', ['export', P.company.id, 'ledger', party.id, '--by', 'dba:test']);
    expect(r.code, r.err).toBe(0);
    const dump = JSON.parse(r.out);
    expect(dump.tables).toEqual({ parties: [{ id: party.id, name: 'Kapoor Traders', email: 'finance@kapoortraders.example', gstin: '27ABCDE1234F1Z5' }] });
    // The same subject id asked for in another company: nothing.
    const other = await tsx('scripts/erase.ts', ['export', B.id, 'ledger', party.id]);
    expect(JSON.parse(other.out).tables).toEqual({ parties: [] });
    const audit = (await adm.query("select actor, outcome, detail from neos.audit where action = 'personal_data.export' and company_id = $1", [P.company.id])).rows;
    expect(audit).toEqual([{ actor: 'dba:test', outcome: '1', detail: { subject: party.id, tables: { parties: 1 } } }]);
    // find: who is this?
    const found = JSON.parse((await tsx('scripts/ops.ts', ['personal-find', P.company.id, 'ledger', 'kapoortraders'])).out);
    expect(found.matches.map((m: { subject: string }) => m.subject)).toEqual([party.id]);
  }, 90_000);

  it('erase: dry run by default; then the tagged columns go (pseudonym / null) — nothing else in either company moves', async () => {
    // (The trial balance first: a read loads the switchboard, which the book mirrors — t009 — and that is not the erase.)
    const tbA = await tb(P.admin.token);
    const beforeA = await snapshot(P.company.id);
    const beforeB = await snapshot(B.id);
    const dry = await tsx('scripts/erase.ts', ['erase', P.company.id, 'ledger', party.id]);
    expect(dry.code, dry.err).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ dry_run: true, tables: { parties: { rows: 1, columns: { name: 'pseudonym', email: 'null', gstin: 'null' } } } });
    expect(await snapshot(P.company.id)).toEqual(beforeA);

    const r = await eraseSubject(P.adminUrl, 'ledger', P.company.id, tags, party.id, { by: 'dba:test', dryRun: false });
    expect(r.tables.parties!.rows).toBe(1);
    const after = await snapshot(P.company.id);
    // Only the three tagged columns of that one row changed.
    for (const t of Object.keys(beforeA)) if (t !== 'parties') expect(after[t], t).toEqual(beforeA[t]);
    const was = (beforeA.parties as any[]).find((x) => x.id === party.id);
    const now = (after.parties as any[]).find((x) => x.id === party.id);
    expect(now).toEqual({ ...was, name: r.pseudonym, email: null, gstin: null });
    expect(r.pseudonym).toMatch(/^erased-[0-9a-f]{12}$/);
    expect((after.parties as any[]).filter((x) => x.id !== party.id)).toEqual((beforeA.parties as any[]).filter((x) => x.id !== party.id));
    // Money and journals intact: the same trial balance, invoices still point at the (renamed) party.
    expect({ ...(await tb(P.admin.token)), generatedAt: null }).toEqual({ ...tbA, generatedAt: null });
    expect((await adm.query("select count(*)::int as n from ledger.documents where party_id = $1", [party.id])).rows[0].n).toBeGreaterThan(0);
    // The other company: byte for byte the same (it has its own Kapoor Traders, untouched).
    expect(await snapshot(B.id)).toEqual(beforeB);
    expect((await adm.query("select email from ledger.parties where company_id = $1 and name = 'Kapoor Traders'", [B.id])).rows[0].email).toBe('finance@kapoortraders.example');
    const audit = (await adm.query("select actor, outcome from neos.audit where action = 'personal_data.erase' and company_id = $1", [P.company.id])).rows;
    expect(audit).toEqual([{ actor: 'dba:test', outcome: '1' }]);
  }, 90_000);
});

describe('company-scoped uninstall', () => {
  it('dry run by default: counts per table, nothing changes', async () => {
    const r = await tsx('scripts/ops.ts', ['uninstall', P.company.id, 'ledger', '--purge']);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ dry_run: true, install_status: 'active' });
    const truth = await snapshot(P.company.id);
    expect(out.would.purge.counts).toEqual(Object.fromEntries(Object.entries(truth).map(([t, rows]) => [t, rows.length])));
    expect(out.would.purge.total).toBeGreaterThan(50);
    expect((await P.platform.db.query("select status from neos.installs where company_id = $1 and app_key = 'ledger'", [P.company.id])).rows[0].status).toBe('active');
  }, 90_000);

  it('--yes: removed — the platform stops offering and routing it for that company only', async () => {
    const r = await tsx('scripts/ops.ts', ['uninstall', P.company.id, 'ledger', '--yes']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ install_status: 'removed', previous: 'active' });
    expect((await P.api('GET', '/api/registry')).body.apps).toEqual([]);
    const refused = await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('not_installed');
    await expect(P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'tasks.open', company_id: P.company.id, body: {}, idem_key: 'x' })).rejects.toThrow(/not installed/);
    P.setBrain(() => finish('n/a'));
    expect((await P.api('POST', '/api/ask', { text: 'show my trial balance', app: 'ledger' })).status).toBeGreaterThanOrEqual(400);
    // The other company still has it.
    expect((await P.api('GET', '/api/registry', undefined, B.token)).body.apps.map((a: { key: string }) => a.key)).toEqual(['ledger']);
    expect((await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, B.token)).status).toBe(200);
  }, 90_000);

  it('--yes --purge: a backup first, then every table loses exactly that company’s rows; other companies untouched; the backup restores', async () => {
    const before = await snapshot(P.company.id);
    const beforeB = await snapshot(B.id);
    const r = await tsx('scripts/ops.ts', ['uninstall', P.company.id, 'ledger', '--purge', '--yes', '--backup-dir', backupDir]);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out);
    const expected = Object.fromEntries(Object.entries(before).map(([t, rows]) => [t, rows.length]));
    expect(out.purged.counts).toEqual(expected);
    expect(out.purged.total).toBe(Object.values(expected).reduce((a, b) => a + b, 0));
    expect(out.purged.counts.journal_lines).toBeGreaterThan(0);
    expect(out.purged.counts.jobs).toBeGreaterThanOrEqual(0);
    for (const [t, rows] of Object.entries(await snapshot(P.company.id))) expect(rows, t).toEqual([]);
    expect(await snapshot(B.id)).toEqual(beforeB);
    const audit = (await adm.query("select outcome from neos.audit where action = 'app.purge' and company_id = $1", [P.company.id])).rows;
    expect(audit).toEqual([{ outcome: String(out.purged.total) }]);
    // The backup was taken first and is that company's rows, restorable alone.
    const dump = JSON.parse(await readFile(out.backup.company_export, 'utf8')) as CompanyDump;
    expect(Object.fromEntries(Object.entries(dump.tables).map(([t, rows]) => [t, rows.length]))).toEqual(expected);
    expect((await readdir(path.dirname(out.backup.company_export))).some((f) => f.endsWith('.json'))).toBe(true);
    await importCompany(P.adminUrl, dump);
    const restored = await snapshot(P.company.id);
    expect(Object.fromEntries(Object.entries(restored).map(([t, rows]) => [t, rows.length]))).toEqual(expected);
  }, 90_000);
});
