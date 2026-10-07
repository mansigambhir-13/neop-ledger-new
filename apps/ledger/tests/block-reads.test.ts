// block-reads.test · v3 S9: the NEOS screens (blocks) read Ledger on the database, never through an app API. Every
// block source is ONE SQL function Ledger declared in its migration file (010, registered in ledger.declared_reads);
// the desk runs it through ledger.block_read() as neos_desk (POST /api/apps/ledger/read/<key>), and Ledger's own
// handler runs the same function — so the screen and the assistant see one answer.
//   · every declared read = exactly the block sources; desk result == handler result on the seeded book
//   · an undeclared read is refused (403 not_declared); a switched-off read is refused (403 switched_off)
//   · company B's person sees only company B's rows (row-level security under block_read)
//   · neos_desk cannot call a read_* function itself, nor select Ledger's tables (42501)
//   · 010 applies forward on a populated book
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { DeskHarness } from '@neop/testkit';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
let desk: DeskHarness;
beforeAll(async () => {
  P = await bootPilot();
  desk = await DeskHarness.connect(P.adminUrl);
}, 120_000);
afterAll(async () => {
  await desk?.close();
  await P?.close();
});

/** Every `source.ability` in Ledger's blocks. */
async function blockSources(): Promise<string[]> {
  const dir = path.join(LEDGER_ROOT, 'blocks');
  const out = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.source && typeof v.source.ability === 'string') out.add(v.source.ability);
      Object.values(v).forEach(walk);
    }
  };
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) walk(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
  return [...out].sort();
}

// Realistic arguments, as the blocks send them for September 2026.
const ARGS: Record<string, unknown[]> = {
  'ledger.accounts.list': [{}, { include_inactive: true }, { type: 'expense' }, { type: 'asset' }],
  'ledger.account.ledger': [{ account_code: '1010', from: '2026-09-01', to: '2026-09-30' }, { account_code: '9999', from: '2026-09-01', to: '2026-09-30' }],
  'ledger.journal.list': [{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-01-01', to: '2026-12-31', search: 'rent', limit: 5 }],
  'ledger.documents.list': [{ kind: 'invoice', status: 'open' }, { kind: 'bill', status: 'paid' }, { kind: 'invoice', status: 'all' }, { kind: 'bill', status: 'overdue', as_of: '2026-09-30' }],
  'ledger.parties.list': [{}, { kind: 'customer' }, { kind: 'vendor' }],
  'ledger.bank.unreconciled': [{}],
  'ledger.coding_rules.list': [{}],
  'ledger.home.summary': [{}, { as_of: '2026-09-30' }],
  'ledger.close.checklist': [{ month: '2026-09' }, { month: '2026-08' }],
  'ledger.periods.status': [{}],
  'ledger.report.pnl': [{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-07-01', to: '2026-09-30' }],
  'ledger.report.balance_sheet': [{ as_of: '2026-09-30' }],
  'ledger.report.cash_flow': [{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-08-01', to: '2026-08-31' }],
  'ledger.report.trial_balance': [{ as_of: '2026-09-30' }],
  'ledger.report.aging': [{ kind: 'receivable', as_of: '2026-09-30' }, { kind: 'payable', as_of: '2026-09-30' }, { kind: 'receivable', as_of: '2099-01-01' }],
  'ledger.report.vat_summary': [{ from: '2026-07-01', to: '2026-09-30' }],
  'ledger.report.cash_forecast': [{ as_of: '2026-09-30' }, { as_of: '2026-09-30', weeks: 4 }],
  'ledger.report.tax_return': [{ from: '2026-09-01', to: '2026-09-30' }],
};

const strip = (x: any): any => {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'generatedAt').map(([k, v]) => [k, strip(v)]));
  return x;
};

describe('declared reads', () => {
  it('are exactly the reads Ledger’s screens use', async () => {
    const declared = (await P.backend.core.runnerPool.query<{ ability: string }>('select ability from ledger.declared_reads order by ability')).rows.map((r) => r.ability);
    expect(declared).toEqual(await blockSources());
    expect(Object.keys(ARGS).sort()).toEqual(declared);
  });

  it('the desk (block_read as neos_desk) answers exactly what the handler answers, for every one', async () => {
    for (const [key, list] of Object.entries(ARGS)) {
      for (const args of list) {
        const viaDesk = await P.api('POST', `/api/apps/ledger/read/${key}`, args);
        expect(viaDesk.status, `${key} ${JSON.stringify(args)}: ${JSON.stringify(viaDesk.body)}`).toBe(200);
        const viaHandler = await P.read(key, args);
        expect(viaHandler.status, key).toBe(200);
        expect(strip(viaDesk.body.result), `${key} ${JSON.stringify(args)}`).toEqual(strip(viaHandler.body.result));
        expect(viaDesk.body.result.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(P.backend.core.validators.checkOutput(key, viaDesk.body.result), key).toBeNull();
      }
    }
    // The seeded book is not empty: the comparisons above compared real figures.
    const tb = (await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' })).body.result;
    expect(tb.sources.entries).toBeGreaterThan(20);
    expect(tb.balanced).toBe(true);
  });

  it('refuses a read that is not declared, bad arguments, and a read switched off at the company', async () => {
    const r = await P.api('POST', '/api/apps/ledger/read/ledger.settings.get', {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_declared');
    expect((await P.api('POST', '/api/apps/ledger/read/tasks.open', { task_id: crypto.randomUUID(), ask: 'x', requester: `user:${P.admin.id}` })).status).toBe(403);
    const bad = await P.api('POST', '/api/apps/ledger/read/ledger.report.pnl', { from: 'last month', to: '2026-09-30' });
    expect(bad.status).toBe(400);
    expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'off' } })).status).toBe(200);
    const off = await P.api('POST', '/api/apps/ledger/read/ledger.report.cash_flow', { from: '2026-09-01', to: '2026-09-30' });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('switched_off');
    expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'on' } })).status).toBe(200);
    expect((await P.api('POST', '/api/apps/ledger/read/ledger.report.cash_flow', { from: '2026-09-01', to: '2026-09-30' })).status).toBe(200);
  });

  it('a person of company B sees only company B’s rows (row-level security under block_read)', async () => {
    const B = await P.platform.createCompany('Bharat Exports', 'Asia/Kolkata');
    const bUser = await P.platform.createUser(B.id, { name: 'Bina', email: 'bina@bharat.example', role: 'admin' });
    await P.platform.installApp(B.id, 'ledger');
    const b = await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, bUser.token);
    expect(b.status).toBe(200);
    expect(b.body.result.sources.entries).toBe(0);
    expect(b.body.result.empty).toBe(true);
    const docs = await P.api('POST', '/api/apps/ledger/read/ledger.documents.list', { kind: 'invoice', status: 'all' }, bUser.token);
    expect(docs.body.result.documents).toEqual([]);
    const a = await P.api('POST', '/api/apps/ledger/read/ledger.documents.list', { kind: 'invoice', status: 'all' });
    expect(a.body.result.documents.length).toBeGreaterThan(0);
  });

  it('neos_desk cannot call a read function itself, nor read Ledger’s tables — only block_read', async () => {
    expect(await desk.errorOf(P.company.id, `select ledger.read_trial_balance('{"as_of":"2026-09-30"}'::jsonb)`)).toBe('42501');
    expect(await desk.errorOf(P.company.id, 'select count(*) from ledger.journal_entries')).toBe('42501');
    expect(await desk.errorOf(P.company.id, 'select count(*) from ledger.declared_reads')).toBe('42501');
    const [row] = await desk.query(P.company.id, `select ledger.block_read('ledger.report.trial_balance', '{"as_of":"2026-09-30"}'::jsonb) as r`);
    expect(row.r.sources.entries).toBeGreaterThan(20);
  });
});

describe('010 on a populated book', () => {
  it('010 applies forward on a populated book', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-010-'));
    try {
      // Ledger as it was before 010.
      await cp(path.join(LEDGER_ROOT, 'migrations'), dir, { recursive: true });
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      for (const m of led.migrations.filter((x: any) => x.file >= '010')) await rm(path.join(dir, m.file));
      led.migrations = led.migrations.filter((m: any) => m.file < '010');
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (appDir: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: appDir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(dir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      try {
        await seedLedger(pool, CO);
        const count = (c: any, t: string) => c.query(`select count(*)::int as n from ledger.${t}`).then((r: any) => r.rows[0].n);
        const before = await withCompany(pool, CO, async (c) => ({ entries: await count(c, 'journal_entries'), lines: await count(c, 'journal_lines'), docs: await count(c, 'documents'), bank: await count(c, 'bank_transactions') }));
        const applied = await run(path.join(LEDGER_ROOT, 'migrations'));
        expect(applied.map((m) => m.name)).toEqual(['010_declared_reads.sql']);
        await withCompany(pool, CO, async (c) => {
          expect({ entries: await count(c, 'journal_entries'), lines: await count(c, 'journal_lines'), docs: await count(c, 'documents'), bank: await count(c, 'bank_transactions') }).toEqual(before);
          const tb = (await c.query(`select ledger.read_trial_balance('{"as_of":"2026-12-31"}'::jsonb) as r`)).rows[0].r;
          expect(tb.sources.entries).toBe(before.entries);
          expect(tb.balanced).toBe(true);
          const docs = (await c.query(`select ledger.read_documents_list('{"kind":"invoice","status":"all"}'::jsonb) as r`)).rows[0].r;
          expect(docs.documents.length).toBeGreaterThan(0);
          expect((await c.query('select count(*)::int as n from ledger.declared_reads')).rows[0].n).toBe(18);
        });
      } finally {
        await pool.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.drop();
    }
  }, 120_000);
});
