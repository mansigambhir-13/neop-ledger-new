// documents-kept.test · WP §11 "files go to object storage keyed under the schema name; the row
// keeps the id". An attached file's bytes are stored (key ledger/<company>/<sha256>) before the
// documents door reads them; ledger.documents_files links the id to its name, type, size and job;
// a bill recorded from it keeps source_document; ledger.document.get gives metadata and a
// short-lived link the app's own files listener serves (never bytes to the model). One company never
// sees another's files.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { documents, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, finish, toolName, type Pilot } from './harness.ts';

let P: Pilot;
let filesDir: string;
let B: { id: string; token: string };
/** The DBA's view (the test reads across companies; the app and runner roles cannot). */
let adm: pg.Pool;
const bill = await readFile(path.join(LEDGER_ROOT, '../../packages/neop-template/tests/fixtures/documents/bill-quartz.pdf'));
const CARD = { what: 'record the bill', why: 'from the attached file', changes: 'the books', if_no_answer: 'nothing changes' };
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  filesDir = await mkdtemp(path.join(os.tmpdir(), 'neop-files-'));
  P = await bootPilot({ backendConfig: () => ({ documents: { backend: 'local', dir: filesDir } }) });
  // A second company with Ledger installed.
  const co = await P.platform.createCompany('Beta Traders', 'Asia/Kolkata');
  const u = await P.platform.createUser(co.id, { name: 'Bea', email: 'bea@beta.example', role: 'admin' });
  await P.platform.installApp(co.id, 'ledger', u.id);
  const slug = (await P.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [co.id])).rows[0]!.slug;
  const server = P.neopUser!.split(':').slice(1).join(':');
  const betaUser = `@neop_ledger_${slug}:${server}`;
  const betaRoom = `!ledger-${slug}:${server}`;
  await P.platform.setChatIdentity(co.id, 'ledger', { matrix_user: betaUser, room_ids: [betaRoom] }, `user:${u.id}`);
  await P.waitFor(async () => P.hs!.joined.some((j) => j.room === betaRoom && j.user === betaUser), 'Beta Ledger joined its room');
  B = { id: co.id, token: u.token };
  adm = new pg.Pool({ connectionString: P.adminUrl, max: 2 });
});
afterAll(async () => {
  await adm?.end();
  await P?.close();
  await rm(filesDir, { recursive: true, force: true });
});

const sha = (b: Buffer) => documents.readDocument({ bytes: b, filename: 'x.pdf' }).sha256;

async function attach(token: string, file: Buffer, filename: string) {
  P.setBrain(() => finish('read the file'));
  const r = await P.api('POST', '/api/ask', { text: 'Keep this bill', app: 'ledger', attachments: [{ filename, content_type: 'application/pdf', content_base64: file.toString('base64') }] }, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await P.waitFor(async () => (await P.api('GET', `/api/tasks/${r.body.task_id}`, undefined, token)).body.task.status === 'COMPLETED', 'job done', 30_000);
  return r.body as { task_id: string; job_id: string };
}

/** One write in a job, approved on the desk; returns the first tool result's text. */
async function propose(key: string, args: Record<string, unknown>) {
  let first = '';
  P.setBrain((v) => {
    if (v.job.includes('WOKEN')) return finish(`${key} verified`);
    if (v.calls === 0) return { tool: toolName(key), args: { ...args, card: CARD } };
    if (!first) first = v.results[0]!.text;
    return v.results.some((x) => x.text.includes('Proposal ')) ? { text: 'waiting' } : finish(`${key} refused`);
  });
  const t = await P.ask(`book: ${key}`);
  await P.waitFor(async () => {
    const x = await P.task(t.task_id);
    if (['COMPLETED', 'FAILED'].includes(x.task.status)) return true;
    const card = (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING');
    if (card) await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    return false;
  }, key, 30_000);
  return first;
}

describe('source documents are kept', () => {
  it('stores the bytes before extraction, under ledger/<company>/<sha256>, and the row and the fact keep the id', async () => {
    const t = await attach(P.admin.token, bill, 'bill-quartz.pdf');
    const id = sha(bill);
    expect(await readFile(path.join(filesDir, 'ledger', P.company.id, id))).toEqual(bill);
    const rows = (await adm.query('select * from ledger.documents_files where sha256 = $1', [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company_id: P.company.id, filename: 'bill-quartz.pdf', content_type: 'application/pdf', bytes: bill.length, store: 'local', store_key: `ledger/${P.company.id}/${id}`, job_id: t.job_id });
    const fact = (await P.backend.core.runnerPool.query('select value from ledger.facts where job_id = $1', [t.job_id])).rows[0].value;
    expect(fact).toMatchObject({ kind: 'attached_document', sha256: id, document_id: id, stored: true });
  });

  it('a bill recorded from the file keeps source_document; a sha256 that was never attached is refused before anyone is asked', async () => {
    const id = sha(bill);
    P.setBrain((v) => (v.calls === 0 ? call('ledger.party.create', { kind: 'vendor', name: 'Quartz Supplies', email: 'ap@quartz.example' }) : finish('vendor added')));
    const v = await P.ask('add vendor Quartz');
    await P.waitFor(async () => (await P.task(v.task_id)).task.status === 'COMPLETED', 'vendor');
    const lines = [{ description: 'Printer paper', amount_minor: 1_000_000, account_code: '6100' }];
    const base = { vendor: 'Quartz Supplies', issue_date: '2026-09-18', due_date: FUTURE, currency: 'INR', gst_rate_bps: 1800, lines };
    const refused = await propose('ledger.bill.record', { ...base, number: 'QZ-NOPE', source_document: 'f'.repeat(64) });
    expect(refused).toMatch(/no attached file ffffffffffff… is kept for this company/);
    await propose('ledger.bill.record', { ...base, number: 'QZ-1001', source_document: id });
    const row = (await adm.query("select source_document from ledger.documents where kind = 'bill' and number = 'QZ-1001'")).rows[0];
    expect(row.source_document).toBe(id);
  });

  it('ledger.document.get: metadata, the bills that cite it and a short-lived link; the app files listener serves the bytes', async () => {
    const id = sha(bill);
    const r = await P.read('ledger.document.get', { sha256: id });
    expect(r.status).toBe(200);
    const res = r.body.result;
    expect(P.backend.core.validators.checkOutput('ledger.document.get', res)).toBeNull();
    expect(res.document).toMatchObject({ sha256: id, filename: 'bill-quartz.pdf', bytes: bill.length, store: 'local' });
    expect(res.bills.map((b: { number: string }) => b.number)).toEqual(['QZ-1001']);
    // No bytes in what a reader (or the model) gets.
    expect(JSON.stringify(res)).not.toContain(bill.subarray(0, 32).toString('base64'));
    expect(res.download.path).toMatch(new RegExp(`^/files/${P.company.id}/${id}\\?exp=\\d+&sig=`));
    expect(Date.parse(res.download.expires_at) - Date.now()).toBeLessThanOrEqual(documents.DOCUMENT_LINK_TTL_S * 1000);

    const files = `http://127.0.0.1:${P.backend.ports.files}`;
    const dl = await fetch(files + res.download.path);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment; filename="bill-quartz.pdf"');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await dl.arrayBuffer())).toEqual(bill);
    // The short-lived signed URL is the browser's bearer capability; a tampered or expired link is refused by the app.
    const tampered = res.download.path.replace(/exp=(\d+)/, (_: string, e: string) => `exp=${Number(e) + 3600}`);
    expect((await fetch(files + tampered)).status).toBe(403);
    const old = documents.documentLink('ledger', P.company.id, id, Date.now() - 3_600_000)!;
    const gone = await fetch(files + old.path);
    expect(gone.status).toBe(410);
  });

  it('company isolation: another company cannot mint a link for this file; its own copy is its own', async () => {
    const id = sha(bill);
    const theirs = await P.read('ledger.document.get', { sha256: id }, { company: B.id });
    expect(theirs.status).toBe(200);
    expect(theirs.body.result).toMatchObject({ empty: true, document: null, bills: [], download: null });
    // A link minted for Beta, for a file only Acme has: nothing to serve.
    const forged = documents.documentLink('ledger', B.id, id)!;
    const files = `http://127.0.0.1:${P.backend.ports.files}`;
    expect((await fetch(files + forged.path)).status).toBe(404);
    // Beta attaches the same file: a separate object and row, under Beta's key.
    await attach(B.token, bill, 'same-bill.pdf');
    expect(await readFile(path.join(filesDir, 'ledger', B.id, id))).toEqual(bill);
    const rows = (await adm.query('select company_id, filename from ledger.documents_files where sha256 = $1 order by stored_at', [id])).rows;
    expect(rows).toEqual([
      { company_id: P.company.id, filename: 'bill-quartz.pdf' },
      { company_id: B.id, filename: 'same-bill.pdf' },
    ]);
    // RLS: the app role, scoped to Acme, sees only Acme's row; and cannot rewrite history.
    await withCompany(P.backend.core.appPool, P.company.id, async (c) => {
      expect((await c.query('select company_id from ledger.documents_files where sha256 = $1', [id])).rows).toEqual([{ company_id: P.company.id }]);
      await expect(c.query('delete from ledger.documents_files')).rejects.toThrow(/permission denied/);
    });
  });
});

it('t006 + 006 apply forward on a populated book: history kept, bills without a source stay null', async () => {
  const db = await createTestDatabase();
  const CO = '11111111-2222-3333-4444-555555555555';
  const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t006-'));
  const adir = await mkdtemp(path.join(os.tmpdir(), 'neop-006-'));
  try {
    await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
    await rm(path.join(tdir, 't006_documents_files.sql'));
    const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
    tled.migrations = tled.migrations.filter((m: { file: string }) => m.file !== 't006_documents_files.sql');
    await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
    await cp(path.join(LEDGER_ROOT, 'migrations'), adir, { recursive: true });
    await rm(path.join(adir, '006_source_documents.sql'));
    const aled = JSON.parse(await readFile(path.join(adir, 'migrate.json'), 'utf8'));
    aled.migrations = aled.migrations.filter((m: { file: string }) => m.file !== '006_source_documents.sql');
    await writeFile(path.join(adir, 'migrate.json'), JSON.stringify(aled));
    await bootstrapFamily(db.adminUrl, 'ledger');
    const run = async (t: string, a: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: a, prepend: await templateFiles(t) }, lintExempt: TEMPLATE_INFRA_TABLES });
    await run(tdir, adir);
    const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
    await seedLedger(pool, CO);
    const before = await withCompany(pool, CO, async (c) => (await c.query("select count(*)::int as n from ledger.documents where kind = 'bill'")).rows[0].n);
    expect(before).toBeGreaterThan(0);
    const applied = await run(TEMPLATE_MIGRATIONS, path.join(LEDGER_ROOT, 'migrations'));
    expect(applied.map((m) => m.name)).toEqual(['t006_documents_files.sql', '006_source_documents.sql']);
    await withCompany(pool, CO, async (c) => {
      expect((await c.query("select count(*)::int as n from ledger.documents where kind = 'bill' and source_document is null")).rows[0].n).toBe(before);
    });
    await expect(withCompany(pool, CO, (c) => c.query("update ledger.documents set source_document = 'not-a-hash' where kind = 'bill'"))).rejects.toThrow(/check/);
    await withCompany(pool, CO, async (c) => {
      const j = (await c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask) values ($1, 'task', 'user:x', gen_random_uuid(), 'x') returning id", [CO])).rows[0].id;
      await c.query("insert into ledger.documents_files (company_id, sha256, filename, content_type, bytes, store, store_key, job_id) values ($1, repeat('a', 64), 'a.pdf', 'application/pdf', 10, 'local', $3, $2)", [CO, j, `ledger/${CO}/${'a'.repeat(64)}`]);
    });
    // The key must be this company's: a row cannot point at another company's object.
    await withCompany(pool, CO, async (c) => {
      await expect(
        c.query("insert into ledger.documents_files (company_id, sha256, filename, content_type, bytes, store, store_key) values ($1, repeat('b', 64), 'b.pdf', 'application/pdf', 10, 'local', 'ledger/99999999-2222-3333-4444-555555555555/' || repeat('b', 64))", [CO]),
      ).rejects.toThrow(/check/);
    });
    await pool.end();
  } finally {
    await db.drop();
    await rm(tdir, { recursive: true, force: true });
    await rm(adir, { recursive: true, force: true });
  }
});
