// migration-020.test · proof on populated data (WP §11) for 020_approvals_frozen.sql (v3 S2): a platform database
// migrated through 019 and filled with approvals and the cards the bridges showed (room_events, room_messages,
// chat_client_events) upgrades with every approval row kept as it was — and frozen for the platform's role —, every
// card id the rooms hold rewritten to its proposal id (a typed card's sent-key too), the foreign keys to
// neos.approvals gone, and the desk's cards view in place. (Real app schemas feeding the view, and the drain of a
// RECORDED/RESOLVED row: apps/ledger/tests/approved-path.test.ts, desk-views.test.ts.)
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl } from '@neop/pgkit';
import { migratePlatform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir019 = '';
let c: pg.Client;
beforeAll(async () => {
  db = await createTestDatabase();
  dir019 = await mkdtemp(path.join(os.tmpdir(), 'neos-019-'));
  await cp(PLATFORM_MIGRATIONS, dir019, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dir019, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '020')) await rm(path.join(dir019, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '020');
  await writeFile(path.join(dir019, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c?.end();
  await db?.drop();
  if (dir019) await rm(dir019, { recursive: true, force: true });
});

const manifest = {
  app: 'ledger',
  name: 'Ledger',
  abilities: [{ key: 'ledger.expense.record', version: '1.0.0', kind: 'write', floor: 'ask_first', title: 'Record an expense', description: 'd', doors: [] }],
  doors: [],
  uses: [],
};

describe('020 on a populated platform database', () => {
  it('020 applies forward on a populated platform database (approvals kept and frozen, card ids rewritten to proposal ids, desk cards view in place)', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir019 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('019_registry_schema.sql');
    const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'P', 'p@x', 'admin', 'h') returning id", [co])).rows[0].id;
    await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', $1, '1', 'h')", [JSON.stringify(manifest)]);
    await c.query("insert into neos.rooms (room_id, company_id, app_key, bot_user) values ('!r:acme', $1, 'ledger', '@neop_ledger_acme:acme')", [co]);
    await c.query("insert into neos.chat_accounts (account, company_id, app_key) values ('@ledger:acme', $1, 'ledger')", [co]);
    const job = '11111111-1111-1111-1111-111111111111';
    const cards: { id: string; proposal_id: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const task = (await c.query("insert into neos.tasks (company_id, app_key, requester, ask, status) values ($1, 'ledger', $2, $3, 'WAITING') returning id", [co, `user:${u}`, `ask ${i}`])).rows[0].id;
      const status = ['PENDING', 'EXECUTED', 'RECORDED', 'RESOLVED'][i % 4]!;
      const a = (
        await c.query(
          `insert into neos.approvals (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at, status, decision, decided_by, fingerprint_seen, proof)
           values ($1, 'ledger', gen_random_uuid(), $2, $3, 'ledger.expense.record', '1.0.0', '{}', '{"what":"x"}', 'sha256:x', now() + interval '1 day', $4, $5, $6, $7, $8) returning id, proposal_id`,
          [co, job, task, status, status === 'PENDING' ? null : 'yes', status === 'PENDING' ? null : u, status === 'PENDING' ? null : 'sha256:x', status === 'EXECUTED' ? '{"outcome":"DONE"}' : null],
        )
      ).rows[0];
      cards.push(a);
      await c.query("insert into neos.room_events (event_id, room_id, direction, sender, task_id, approval_id, fingerprint_shown, outcome) values ($1, '!r:acme', 'outbound', '@neop_ledger_acme:acme', $2, $3, 'sha256:x', $4)", [`$re${i}`, task, a.id, `typed:propose:${a.id}`]);
      await c.query("insert into neos.room_messages (room_id, dedupe_key, kind, body, approval_id, fingerprint_shown) values ('!r:acme', $1, 'card', 'card', $2, 'sha256:x')", [`card:${a.proposal_id}`, a.id]);
      await c.query("insert into neos.chat_client_events (event_id, account, room_id, direction, sender, task_id, approval_id, fingerprint_shown, outcome) values ($1, '@ledger:acme', '!dm:acme', 'outbound', '@ledger:acme', $2, $3, 'sha256:x', $4)", [`$ce${i}`, task, a.id, `typed:propose:${a.id}`]);
    }
    // an unrelated outbound row keeps its outcome and no card
    await c.query("insert into neos.room_events (event_id, room_id, direction, sender, outcome) values ('$plain', '!r:acme', 'outbound', '@neop_ledger_acme:acme', 'typed:note:ack')");
    const approvals = async () => (await c.query('select md5(string_agg(a::text, \',\' order by id)) h, count(*)::int n from neos.approvals a')).rows[0];
    const before = await approvals();

    const applied = await migratePlatform(db.adminUrl, undefined, { through: '020' });
    expect(applied.map((m) => m.name)).toEqual(['020_approvals_frozen.sql']); // applied through 020; each later file has its own proof (021: migration-021.test.ts, 022: registry-v3.test.ts, 023–024: migration-023.test.ts, 025: migration-025.test.ts)
    expect(await approvals()).toEqual(before); // every approval row as it was

    // Card ids are proposal ids now, everywhere a card was shown; a typed card's sent-key follows.
    const byProposal = new Map(cards.map((a) => [a.id, a.proposal_id]));
    for (const t of ['room_events', 'room_messages', 'chat_client_events']) {
      const rows = (await c.query(`select approval_id from neos.${t} where approval_id is not null order by 1`)).rows.map((r) => r.approval_id);
      expect(rows.sort(), t).toEqual([...byProposal.values()].sort());
    }
    for (const t of ['room_events', 'chat_client_events']) {
      const rows = (await c.query(`select approval_id, outcome from neos.${t} where approval_id is not null`)).rows;
      expect(rows.every((r) => r.outcome === `typed:propose:${r.approval_id}`), t).toBe(true);
    }
    expect((await c.query("select outcome, approval_id from neos.room_events where event_id = '$plain'")).rows[0]).toEqual({ outcome: 'typed:note:ack', approval_id: null });
    expect((await c.query("select count(*)::int n from pg_constraint where contype = 'f' and confrelid = 'neos.approvals'::regclass and conrelid <> 'neos.approvals'::regclass")).rows[0].n).toBe(0);

    // Frozen: the platform's role reads it (an old card id still maps to its proposal) and writes nothing.
    const priv = (await c.query("select has_table_privilege('neos_app', 'neos.approvals', 'select') s, has_table_privilege('neos_app', 'neos.approvals', 'insert') i, has_table_privilege('neos_app', 'neos.approvals', 'update') u, has_table_privilege('neos_app', 'neos.approvals', 'delete') d")).rows[0];
    expect(priv).toEqual({ s: true, i: false, u: false, d: false });
    const app = createPool(roleUrl(db.adminUrl, 'neos_app'), 2);
    try {
      await expect(app.query("update neos.approvals set status = 'CLOSED'")).rejects.toMatchObject({ code: '42501' });
      // The desk's cards: the view is in place and readable by the platform and the desk (no app schema here: no rows).
      expect((await app.query('select count(*)::int n from neos.v_desk_cards')).rows[0].n).toBe(0);
      expect((await c.query("select pg_get_viewdef('neos.v_desk_cards'::regclass) d")).rows[0].d).toContain("desk_cards('ledger'::text)");
      // The S2 drain (deleted in S9 with the table) handed these to their apps' answer_proposal() at the S2 deploy; 020
      // itself keeps every row as it was. 024 refuses to drop the table while any answered row was never handed over
      // (packages/platform/tests/migration-025.test.ts).
      expect(await approvals()).toEqual(before);
    } finally {
      await app.end();
    }
    // A re-run is a no-op.
    expect(await migratePlatform(db.adminUrl, undefined, { through: '020' })).toEqual([]);
  });
});
