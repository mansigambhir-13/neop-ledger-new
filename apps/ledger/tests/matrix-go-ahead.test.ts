// matrix-go-ahead.test · v3 §5/§8/§16 "only a person can say yes; the reasoning agent never approves", on the Matrix
// client road. NeuralChat (neos-agent-neuralchat #143) sends plain m.text and may send a free-text go-ahead such as
// "Go ahead with the ₹500 expense." — that is NEVER a yes, from any bridge (migration 017 withdrew 016's per-bridge
// may_approve). The one reply re-shows the card and says "I can't take a yes through NeuralChat. Please approve #<id>
// on your desk."; nothing executes and no job opens. A person's yes on the desk then executes it once. A bridge's
// clear DECLINE still binds (caution may be added, never removed).
// End to end: real platform + gateway + L3 + runner + scripted agent, against the in-memory fake homeserver.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate } from '@neop/pgkit';
import { cardTextOf, ChatClient, DEFAULT_REPLY_DEADLINE_MS, goAheadOf, migratePlatform, numbersIn, numbersNotOn, PLATFORM_MIGRATIONS } from '@neop/platform';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';

const ME = '@ledger:hs.test';
const AGENT = '@reasoning_agent:hs.test'; // relays for Priya (admin)
const AGENT2 = '@reasoning_agent_two:hs.test'; // relays for Priya too, its own DM
const PRIYA = '@priya:hs.test';
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const replyTo = (ev: { event_id: string }) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: ev.event_id } } });
const inReplyTo = (e: { content: any }) => e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let P: Pilot;
const running: ChatClient[] = [];

beforeAll(async () => {
  P = await bootPilot();
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  for (const e of [
    { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
    { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
    { app: 'ledger', matrix_id: AGENT2, kind: 'bridge', acts_for: P.admin.id },
  ]) {
    const r = await P.api('PUT', '/api/chat/allowlist', e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});
const stopClients = async () => {
  while (running.length) await running.pop()!.stop();
};
afterEach(stopClients);
afterAll(async () => P?.close());

async function client(hs: FakeClientHomeserver) {
  await P.platform.db.query('update neos.chat_accounts set next_batch = null where account = $1', [ME]);
  await P.platform.db.query("update neos.chat_client_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
  const c = new ChatClient(P.platform, { account: ME, company: P.company.id, app: 'ledger', accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
  await c.start();
  running.push(c);
  return c;
}
async function dmWith(hs: FakeClientHomeserver, from: string) {
  const dm = hs.invite(from);
  await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await P.platform.db.query('select 1 from neos.chat_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
  return dm;
}
const notices = (hs: FakeClientHomeserver, room: string, n: number, what: string) => P.waitFor(async () => hs.notices(room).length >= n && hs.notices(room), what);
const tasks = async () => (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n as number;
const approval = async (id: string) => (await P.platform.db.query('select status, decision, decided_by, fingerprint_seen, feedback from neos.approvals where id = $1', [id])).rows[0];
const consentAudit = async (approvalId: string) =>
  (await P.platform.db.query("select actor, outcome from neos.audit where action = 'chat.bridge_consent' and detail->'approvals' ? $1 order by id", [approvalId])).rows;
const executions = async (key: string) => (await P.backend.core.runnerPool.query("select count(*)::int as n from ledger.operations where ability_key = $1 and outcome = 'DONE'", [key])).rows[0].n as number;

const DONE = 'Recorded the ₹500.00 office-supplies expense in the books.';
/** The job proposes an expense (a card) and, once woken by the answer, finishes with DONE. */
const expenseBrain = (description: string, amountMinor = 50_000) =>
  P.setBrain((v) =>
    v.job.includes('WOKEN')
      ? finish(DONE)
      : v.calls === 0
        ? call('ledger.expense.record', {
            date: '2026-09-21',
            currency: 'INR',
            description,
            amount_minor: amountMinor,
            gst_rate_bps: 0,
            account_code: '6200',
            card: { what: `Record a ₹${(amountMinor / 100).toFixed(2)} expense: ${description}`, why: 'asked in chat', changes: 'one expense entry in the books', if_no_answer: 'nothing is recorded' },
          })
        : { text: 'waiting' },
  );

/** NeuralChat's first message: a plain ask to prepare, not apply. Returns the proposal reply and its card. */
async function propose(hs: FakeClientHomeserver, dm: string, bridge: string, description: string, n = 1) {
  expenseBrain(description);
  const ask = hs.say(dm, bridge, text(`Please prepare, but do not apply, an expense of ₹500 for ${description}.`));
  const all = await notices(hs, dm, n, 'the proposal reply');
  const proposal = all[n - 1]!;
  expect(inReplyTo(proposal)).toBe(ask.event_id);
  const card = await P.waitFor(
    async () => (await P.platform.db.query("select * from neos.approvals where status = 'PENDING' and card->>'what' like $1 order by created_at desc limit 1", [`%${description}`])).rows[0],
    'the card',
  );
  return { ask, proposal, card, id8: String(card.id).slice(0, 8) };
}

describe('the go-ahead lexicon and the number check (deterministic, kept for recognising a go-ahead)', () => {
  it('a clear go-ahead is an affirmative with no hold word; both is ambiguous; neither is none', () => {
    for (const t of ['Go ahead with the ₹500 expense.', 'Go ahead with the ₹500 change.', 'Yes, go ahead.', 'Proceed.', 'Approved — apply it', 'ok', 'Sure, do it', 'Confirmed.', 'yeah carry on']) {
      expect(goAheadOf(t), t).toBe('go_ahead');
    }
    for (const t of ["Don't go ahead with the ₹500 expense yet.", 'don’t go ahead', 'Go ahead? Wait, not yet.', 'No, do not proceed', 'Yes, but hold it until later', 'Go ahead but change the amount to ₹600', 'change: yes with ₹600', 'ok, cancel it', 'Yes — never mind, drop it', 'Go ahead with some changes', "I can't say yes"]) {
      expect(goAheadOf(t), t).toBe('ambiguous');
    }
    for (const t of ['What was our net profit in August 2026?', 'Record a ₹500 expense for office supplies.', 'Transfer ₹10,000 to Kapoor Traders right now.']) {
      expect(goAheadOf(t), t).toBe('none');
    }
  });

  it('numbers normalise ₹, commas, Indian grouping and decimals', () => {
    expect(numbersIn('₹500')).toEqual([500]);
    expect(numbersIn('₹500.00')).toEqual([500]);
    expect(numbersIn('₹50,000.00 and 5,00,000 and Rs. 1,200')).toEqual([50000, 500000, 1200]);
    expect(numbersNotOn('Go ahead with the ₹500 expense.', 'Record a ₹500.00 expense')).toEqual([]);
    expect(numbersNotOn('Go ahead with the ₹5,000 expense.', 'Record a ₹500.00 expense')).toEqual([5000]);
    expect(numbersNotOn('Go ahead with the ₹500 expense.', cardTextOf({ what: 'Record an expense' }, { amount_minor: 50_000 }))).toEqual([]);
  });

  it('the reply deadline defaults to 55 s, under NeuralChat’s 60 s wait', () => {
    expect(DEFAULT_REPLY_DEADLINE_MS).toBe(55_000);
  });
});

describe('a bridge’s go-ahead is never a yes (NeuralChat-shaped: plain messages, never replies)', () => {
  it('plain ask → proposal → plain "Go ahead with the ₹500 change." → refused, card re-shown, nothing executed; the desk yes then executes it once', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { proposal, card, id8 } = await propose(hs, dm, AGENT, 'office supplies');
    const body = String(proposal.content.body);
    expect(body).toMatch(/^Ledger proposes: Record a ₹500\.00 expense: office supplies/);
    expect(body).toMatch(/awaits a person's approval — a bridge cannot approve it/);
    expect(body).not.toContain('Shall I go ahead?');
    const opsBefore = await executions('ledger.expense.record');

    const before = await tasks();
    const go = hs.say(dm, AGENT, text('Go ahead with the ₹500 change.'));
    const replies = await notices(hs, dm, 2, 'the refusal');
    expect(inReplyTo(replies[1]!)).toBe(go.event_id);
    const refusal = String(replies[1]!.content.body);
    expect(refusal).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(refusal).toContain(`I can't take a yes through NeuralChat. Please approve #${id8} on your desk.`);
    expect(refusal).toMatch(/The change still waiting:\nLedger proposes: Record a ₹500\.00 expense: office supplies/);
    expect(refusal).toContain('Amounts: amount ₹500.00');
    await pause(400);
    expect(await approval(card.id)).toMatchObject({ status: 'PENDING', decided_by: null });
    expect(await tasks()).toBe(before); // no job opened by the go-ahead
    expect(await executions('ledger.expense.record')).toBe(opsBefore);
    expect(await consentAudit(card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'not_a_yes' }]);
    // the re-shown card is recorded with its fingerprint (so a "no" to it binds), never as a yes
    expect((await P.platform.db.query('select outcome, approval_id from neos.chat_client_events where event_id = $1', [go.event_id])).rows[0]).toEqual({ outcome: 'bridge_consent_refused', approval_id: card.id });

    // A person's yes on the desk: executed exactly once.
    const desk = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(desk.status, JSON.stringify(desk.body)).toBe(200);
    await P.waitFor(async () => (await approval(card.id)).status === 'EXECUTED', 'executed');
    expect(await approval(card.id)).toMatchObject({ status: 'EXECUTED', decision: 'yes', decided_by: P.admin.id, fingerprint_seen: card.fingerprint });
    expect(await executions('ledger.expense.record')).toBe(opsBefore + 1);
    // …and a later go-ahead from the bridge changes nothing.
    hs.say(dm, AGENT, text('Yes, go ahead.'));
    await pause(500);
    expect(await executions('ledger.expense.record')).toBe(opsBefore + 1);
  });

  it('a go-ahead as a REPLY to the card notice is refused the same way', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT2);
    const { proposal, card, id8 } = await propose(hs, dm, AGENT2, 'printer paper');
    const before = await tasks();
    hs.say(dm, AGENT2, text('Approved — apply it.', replyTo(proposal)));
    const r = await notices(hs, dm, 2, 'the refusal');
    expect(r[1]!.content.body).toContain(`Please approve #${id8} on your desk.`);
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [card.id]);
  });

  it('a negation ("don’t go ahead") is an ordinary request: nothing is approved', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card } = await propose(hs, dm, AGENT, 'stationery', 1);
    const before = await tasks();
    P.setBrain(() => finish('Understood — nothing was applied.'));
    hs.say(dm, AGENT, text("Don't go ahead with the ₹500 expense yet."));
    const r = await notices(hs, dm, 2, 'the reply');
    expect(r[1]!.content.body).toBe('Understood — nothing was applied.');
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before + 1);
    await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [card.id]);
  });
});

describe('a bridge’s clear decline still binds (caution may be added, never removed)', () => {
  it('NeuralChat’s plain decline — no reply, no card id — binds to the card the DM is at', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card, id8 } = await propose(hs, dm, AGENT, 'desk lamps');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT, text('The user declined. Please drop that proposal.'));
    const r = await notices(hs, dm, 2, 'the decline');
    expect(r[1]!.content.body).toBe(`Recorded: card ${id8} declined for Priya, via ${AGENT}. Nothing will be done.`);
    expect(await approval(card.id)).toMatchObject({ decision: 'no', fingerprint_seen: card.fingerprint });
  });

  it('a decline as a reply to the card', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT2);
    const { proposal, card, id8 } = await propose(hs, dm, AGENT2, 'magazine subscription');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT2, text('No, drop it — the user declined.', replyTo(proposal)));
    const r = await notices(hs, dm, 2, 'the decline');
    expect(r[1]!.content.body).toBe(`Recorded: card ${id8} declined for Priya, via ${AGENT2}. Nothing will be done.`);
    expect(await approval(card.id)).toMatchObject({ decision: 'no', decided_by: P.admin.id, fingerprint_seen: card.fingerprint });
  });
});

describe('may_approve can never be granted', () => {
  const OTHER = '@other_agent:hs.test';
  const entry = async (id: string) => ((await P.api('GET', '/api/chat/allowlist?app=ledger')).body.entries as any[]).find((e) => e.matrix_id === id);

  it('PUT may_approve:true is 400 bridge_cannot_approve (403 for a member); false or absent is a plain entry; SQL cannot set it', async () => {
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.member.id, may_approve: true }, P.member.token)).status).toBe(403);
    for (const b of [
      { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: true },
      { app: 'ledger', matrix_id: PRIYA, kind: 'person', may_approve: true },
      { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: 'yes' },
    ]) {
      const r = await P.api('PUT', '/api/chat/allowlist', b);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('bridge_cannot_approve');
    }
    expect(await entry(OTHER)).toBeUndefined();
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: false })).status).toBe(200);
    expect(await entry(OTHER)).toMatchObject({ kind: 'bridge', acts_for: P.admin.id });
    await expect(P.platform.db.query('update neos.chat_allowlist set may_approve = true where matrix_id = $1 and company_id = $2', [OTHER, P.company.id])).rejects.toThrow(/chat_allowlist_bridge_never_approves/);
    expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(OTHER)}`)).status).toBe(200);
  });
});

describe('migration 016', () => {
  it('016 applies forward on a populated platform database (allowlist rows kept, may_approve false); 017 then forbids it', async () => {
    const db = await createTestDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-016-'));
    try {
      await cp(PLATFORM_MIGRATIONS, dir, { recursive: true });
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      for (const m of led.migrations.filter((x: any) => x.file >= '016')) await rm(path.join(dir, m.file));
      led.migrations = led.migrations.filter((m: any) => m.file < '016');
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
      await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
      await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir }, tenantLint: false });
      const c = new pg.Client({ connectionString: db.adminUrl });
      await c.connect();
      try {
        const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
        const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash, matrix_user_id) values ($1, 'P', 'p@x', 'admin', 'h', '@p:hs') returning id", [co])).rows[0].id;
        await c.query(`insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', '{"name":"Ledger","abilities":[]}', '1', 'h')`);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', '@p:hs', 'person')", [co]);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind, acts_for) values ($1, 'ledger', '@agent:hs', 'bridge', $2)", [co, u]);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', '@platform:hs', 'bridge')", [co]);
        const before = (await c.query("select md5(string_agg(matrix_id || kind || coalesce(acts_for::text, '-'), ',' order by matrix_id)) h from neos.chat_allowlist")).rows[0];

        const applied = await migratePlatform(db.adminUrl);
        expect(applied.map((m) => m.name).slice(0, 2)).toEqual(['016_bridge_approve.sql', '017_bridge_never_approves.sql']);
        expect((await c.query("select md5(string_agg(matrix_id || kind || coalesce(acts_for::text, '-'), ',' order by matrix_id)) h from neos.chat_allowlist")).rows[0]).toEqual(before);
        expect((await c.query('select matrix_id, may_approve from neos.chat_allowlist order by matrix_id')).rows).toEqual([
          { matrix_id: '@agent:hs', may_approve: false },
          { matrix_id: '@p:hs', may_approve: false },
          { matrix_id: '@platform:hs', may_approve: false },
        ]);
        for (const mx of ['@agent:hs', '@p:hs', '@platform:hs']) {
          await expect(c.query('update neos.chat_allowlist set may_approve = true where matrix_id = $1', [mx])).rejects.toThrow(/may_approve_check|bridge_never_approves/);
        }
      } finally {
        await c.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.drop();
    }
  });
});
