// runtime-gate.test · the gate and the approved path hold what the plan says
// they hold, on real calls: the version a yes was given to (gate step 2), the
// setting at effect time, superseded_by, the tool-call cap with a report still
// possible, company rules through the real ruleUsage SQL, the switchboard cache
// (NOTIFY from the app's own switchboard, the short TTL) and step.mirror dedup on replay.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { withCompany } from '@neop/pgkit';
import { BOARD_TTL_MS, ruleUsage, zonedParts } from '@neop/template';
import { bootPilot, call, finish, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
  await P.api('PUT', '/api/switchboards/ledger', { rules: [] }); // a switchboard row exists from here on
});
afterAll(async () => P?.close());

const post = (amount: number, memo: string) =>
  call('ledger.journal.post', {
    date: '2026-08-31',
    memo,
    currency: 'INR',
    lines: [
      { account_code: '6300', debit_minor: amount, credit_minor: 0 },
      { account_code: '2000', debit_minor: 0, credit_minor: amount },
    ],
    card: { what: `Post ${amount} paise: ${memo}`, why: 'test', changes: 'One journal entry', if_no_answer: 'Nothing is posted' },
  });
const email = (to: string[]) =>
  call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to, card: { what: 'Email the pack', why: 'test', changes: 'One email', if_no_answer: 'Nothing is sent' } });

const pendingCard = (jobId: string) => P.waitFor(async () => (await P.desk()).find((c) => c.job_id === jobId && c.status === 'PENDING'), 'pending card');
const taskDone = (taskId: string) =>
  P.waitFor(async () => {
    const t = await P.task(taskId);
    return ['COMPLETED', 'FAILED'].includes(t.task.status) && t;
  }, 'task terminal');
const proposal = async (id: string) => (await P.backend.core.runnerPool.query('select * from ledger.proposals where id = $1', [id])).rows[0];
const entries = (memo: string) =>
  withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query('select count(*)::int as n from ledger.journal_entries where memo = $1', [memo])).rows[0].n as number);

/** Record a person's yes (answer_proposal, through the desk) while the runner's approved path is held: it stays APPROVED. */
async function yesWithoutExecuting(card: any) {
  P.backend.runner.approved.pause();
  const r = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
  expect(r.status).toBe(200);
  expect((await proposal(card.proposal_id)).status).toBe('APPROVED');
}

/**
 * A new board version written straight into the app's own switchboard by a DBA's hand with its triggers off
 * (session_replication_role = replica): no history, no NOTIFY — nothing tells the gate its cache is stale.
 */
async function silentSwitchboard(settings: Record<string, string>) {
  const dba = new pg.Client({ connectionString: P.adminUrl });
  await dba.connect();
  try {
    await dba.query('begin');
    await dba.query('set local session_replication_role = replica');
    const v = (await dba.query(`select greatest(coalesce((select max(version) from ledger.switchboard where company_id = $1), 0), coalesce((select max(version) from ledger.switchboard_history where company_id = $1), 0)) + 1 as v`, [P.company.id])).rows[0].v;
    for (const [line, setting] of Object.entries(settings)) {
      const a = P.backend.core.ability(line)!;
      await dba.query(
        `insert into ledger.switchboard (company_id, line, kind, floor, setting, version) values ($1, $2, $3, $4, $5, $6)
         on conflict (company_id, line) do update set setting = excluded.setting, version = excluded.version`,
        [P.company.id, line, a.kind, a.floor, setting, v],
      );
    }
    await dba.query('commit');
  } finally {
    await dba.end();
  }
}

describe('the approved path re-checks at effect time', () => {
  it('a yes given to one ability version does not run under another: FAILED version_changed, the job is told', async () => {
    let woke = '';
    P.setBrain((v: BrainView) => {
      if (v.job.includes('WOKEN')) {
        woke = v.job;
        return finish('The ability changed version; nothing was posted. I will propose again if you still want it.', 'blocked');
      }
      return v.calls === 0 ? post(111_100, 'version pin probe') : { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Accrue the version probe');
    const card = await pendingCard(job_id);
    const ability = P.backend.core.manifest.abilities.find((a) => a.key === 'ledger.journal.post')!;
    const was = ability.version;
    ability.version = '1.1.0'; // a deploy between the proposal and the yes
    try {
      expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);
      await taskDone(task_id);
    } finally {
      ability.version = was;
    }
    const p = await proposal(card.proposal_id);
    expect(p.status).toBe('FAILED');
    expect(p.proof.error).toMatch(/^version_changed: proposed against ledger\.journal\.post@1\.0\.0, this app now runs 1\.1\.0/);
    expect(await entries('version pin probe')).toBe(0);
    expect(woke).toContain('changed version after you proposed this, so it was NOT carried out');
  });

  it('a yes on record for one ability version does not run under another, whoever edited the row (v3: no token claim; the row is the truth)', async () => {
    // Was: an execution token naming another ability version was refused. v3 has no token: the version the yes
    // covers is the proposal's own ability_version, re-checked against what this app runs at effect time.
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('not run', 'blocked') : v.calls === 0 ? post(111_200, 'token version probe') : { text: 'waiting' }));
    const { job_id } = await P.ask('Accrue the token probe');
    const card = await pendingCard(job_id);
    await yesWithoutExecuting(card);
    const dba = new pg.Client({ connectionString: P.adminUrl });
    await dba.connect();
    try {
      await dba.query("update ledger.proposals set ability_version = '0.9.0' where id = $1", [card.proposal_id]);
    } finally {
      await dba.end();
    }
    P.backend.runner.approved.resume();
    const p = await P.waitFor(async () => {
      const x = await proposal(card.proposal_id);
      return ['DONE', 'FAILED', 'UNKNOWN'].includes(x.status) && x;
    }, 'carried out');
    expect(p.status).toBe('FAILED');
    expect(p.proof.error).toMatch(/^version_changed: proposed against ledger\.journal\.post@0\.9\.0, this app now runs 1\.0\.0/);
    expect(await entries('token version probe')).toBe(0);
    // The wait is ready: the job wakes to say so.
    await P.waitFor(async () => (await P.jobRow(job_id)).status === 'DONE', 'job reported');
  });

  it('switched off after the yes (the app’s cache still says on): the write does not run, FAILED switched_off, the job wakes', async () => {
    let woke = '';
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) {
        woke = v.job;
        return finish('Switched off before it ran; nothing posted.', 'blocked');
      }
      return v.calls === 0 ? post(111_300, 'switched off probe') : { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Accrue the switch probe');
    const card = await pendingCard(job_id);
    await yesWithoutExecuting(card);
    expect((await P.backend.core.board.get(P.company.id)).setting(P.backend.core.ability('ledger.journal.post')!)).toBe('ask_first'); // cache warm: on
    await silentSwitchboard({ 'ledger.journal.post': 'off' });
    P.backend.runner.approved.resume(); // the runner carries the yes out now: the setting is re-read, not the cache
    await taskDone(task_id);
    const p = await proposal(card.proposal_id);
    expect(p.status).toBe('FAILED');
    expect(p.proof.error).toMatch(/^switched_off/);
    expect(await entries('switched off probe')).toBe(0);
    expect(woke).toContain('switched off before it could run');
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'ask_first' } });
  });

  it('a grant-covered write re-reads the setting too: switched off since the gate’s cache, nothing runs', async () => {
    const g = await P.api('POST', '/api/grants', {
      app_key: 'ledger',
      ability_key: 'ledger.journal.post',
      limits: { per_call_minor: 1_000_000, currency: 'INR' },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(g.status).toBe(200);
    // Switched off (silently: no NOTIFY reaches the gate) after the gate decided and the grant was
    // matched, before the effect: exactly the window a cached setting would miss.
    const hooks = P.backend.core.hooks;
    const spy = vi.fn(async () => {
      await silentSwitchboard({ 'ledger.journal.post': 'off' });
    });
    hooks.afterGrantMatched = spy;
    let res = '';
    P.setBrain((v) => {
      if (v.calls === 0) return post(111_400, 'grant switched off probe');
      res = v.results[0]!.text;
      return finish('not run', 'blocked');
    });
    try {
      const a = await P.ask('Accrue under the grant');
      await taskDone(a.task_id);
      expect(spy).toHaveBeenCalled();
      const p = (await P.backend.core.runnerPool.query('select status, approved_via, proof from ledger.proposals where job_id = $1', [a.job_id])).rows[0];
      expect(p).toMatchObject({ status: 'FAILED', approved_via: 'grant' });
      expect(p.proof.error).toMatch(/^switched_off/);
      expect(res).toContain('switched_off');
      expect(await entries('grant switched off probe')).toBe(0);
    } finally {
      delete hooks.afterGrantMatched;
      expect((await P.api('DELETE', `/api/grants/${g.body.id}`)).status).toBe(200);
      await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'ask_first' } });
    }
  });
});

describe('proposals', () => {
  it('"change this first": the replacement proposal is recorded as superseded_by', async () => {
    P.setBrain((v) => {
      if (v.job.includes('SUPERSEDED') && !v.results.length) return email(['cfo@acme.example', 'ca@acme.example']);
      if (v.job.includes('WOKEN')) return finish('sent');
      return v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' };
    });
    const { job_id } = await P.ask('Email the pack to the CFO');
    const card = await pendingCard(job_id);
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'change', fingerprint_seen: card.fingerprint, feedback: 'Copy the CA too' });
    const next = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING' && c.id !== card.id), 'replacement card');
    const old = await proposal(card.proposal_id);
    expect(old.status).toBe('SUPERSEDED');
    expect(old.superseded_by).toBe(next.proposal_id);
    const ev = await P.backend.core.runnerPool.query("select detail from ledger.proposal_events where proposal_id = $1 and event = 'superseded_by'", [card.proposal_id]);
    expect(ev.rows[0].detail).toEqual({ replacement: next.proposal_id });
    // Only the same ability in the same job is linked: the replacement itself is not superseded.
    expect((await proposal(next.proposal_id)).superseded_by).toBeNull();
    await P.api('POST', `/api/desk/${next.id}/answer`, { decision: 'no', fingerprint_seen: next.fingerprint });
  });
});

describe('the tool-call cap (40)', () => {
  it('past 40 calls the assistant is stopped, and job.finish still goes through so the person gets a report', async () => {
    let capText = '';
    P.setBrain((v) => {
      const last = v.results.at(-1);
      if (last?.isError && /cap/i.test(last.text)) {
        capText = last.text;
        return finish('Stopped at the tool-call cap after 40 reads; here is what I found so far.', 'blocked');
      }
      return call('ledger.accounts.list', {});
    });
    const { task_id, job_id } = await P.ask('List the accounts, many times');
    const t = await taskDone(task_id);
    expect(t.task.status).toBe('COMPLETED');
    expect(t.task.result.summary).toMatch(/tool-call cap/);
    expect(capText).toMatch(/Tool call cap \(40\) reached .*Call job_finish now/);
    const job = await P.jobRow(job_id);
    expect(job.tool_calls).toBe(41); // 40 reads + the finish
    const reads = await P.backend.core.runnerPool.query("select count(*)::int as n from ledger.steps where job_id = $1 and kind = 'ability'", [job_id]);
    expect(reads.rows[0].n).toBe(40);
  });

  it('the gate enforces the cap itself (cap_tool_calls), but still takes job.finish', async () => {
    P.setBrain(() => ({ hang: true }));
    const { job_id } = await P.ask('Hold still');
    const job = await P.waitFor(async () => {
      const j = await P.jobRow(job_id);
      return j.status === 'RUNNING' && j.claimed_by && j;
    }, 'claimed');
    await P.backend.core.runnerPool.query('update ledger.jobs set tool_calls = 40 where id = $1', [job_id]);
    const token = await P.backend.core.jobTokens.mint({ sub: job_id, sid: job.claimed_by, company_id: P.company.id, abilities: ['ledger.accounts.list'] }, 60_000);
    const gate = async (tool: string, args: unknown) =>
      (
        await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool, args }),
        })
      ).json();
    expect(await gate('ledger.accounts.list', {})).toMatchObject({ status: 'refused', code: 'cap_tool_calls' });
    expect(await gate('book.note', { text: 'x' })).toMatchObject({ status: 'refused', code: 'cap_tool_calls' });
    expect(await gate('job.finish', { outcome: 'blocked', summary: 'Stopped at the cap.' })).toEqual({ status: 'ok' });
    expect((await P.jobRow(job_id)).status).toBe('DONE');
  });
});

describe('company rules on real gate calls', () => {
  const refusedWith = async (brainCall: ReturnType<typeof call>) => {
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return brainCall;
      seen = v.results[0]!.text;
      return finish('checked', 'blocked');
    });
    const a = await P.ask('Rule probe');
    await taskDone(a.task_id);
    const n = (await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.proposals where job_id = $1', [a.job_id])).rows[0].n;
    return { seen, proposals: n };
  };

  it('time_window: outside the allowed days, refused before anything is proposed', async () => {
    const today = zonedParts(new Date(), 'Asia/Kolkata').isoDay;
    const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
    await P.api('PUT', '/api/switchboards/ledger', { rules: [{ id: 'not-today', type: 'time_window', days, from: '00:00', to: '23:59', applies_to: ['ledger.journal.post'] }] });
    const r = await refusedWith(post(10_000, 'window probe'));
    expect(r.seen).toContain('rule:not-today');
    expect(r.proposals).toBe(0);
    await P.api('PUT', '/api/switchboards/ledger', { rules: [] });
  });

  it('recipient_cap: too many recipients, refused', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { rules: [{ id: 'one-recipient', type: 'recipient_cap', max: 1 }] });
    const r = await refusedWith(email(['cfo@acme.example', 'ca@acme.example']));
    expect(r.seen).toContain('rule:one-recipient');
    expect(r.proposals).toBe(0);
    await P.api('PUT', '/api/switchboards/ledger', { rules: [] });
  });

  it('amount_cap per day and per month count what already went out today (operations, via ruleUsage)', async () => {
    // What is already committed this month, e.g. by earlier tests in this file.
    const used = async () =>
      withCompany(P.backend.core.appPool, P.company.id, async (c) => {
        const board = await P.backend.core.board.get(P.company.id);
        return ruleUsage(P.backend.core, c, board, 'INR');
      });
    // One posting really executed today.
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('posted') : v.calls === 0 ? post(100_000, 'cap base posting') : { text: 'waiting' }));
    const a = await P.ask('Accrue the base amount');
    const card = await pendingCard(a.job_id);
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await taskDone(a.task_id);
    expect(await entries('cap base posting')).toBe(1);
    const u = await used();
    expect(u.day_minor).toBeGreaterThanOrEqual(100_000);
    expect(u.month_minor).toBeGreaterThanOrEqual(u.day_minor);

    await P.api('PUT', '/api/switchboards/ledger', { rules: [{ id: 'day-cap', type: 'amount_cap', currency: 'INR', per_day_minor: u.day_minor + 50_000, applies_to: ['ledger.journal.post'] }] });
    const over = await refusedWith(post(60_000, 'over the day'));
    expect(over.seen).toContain('rule:day-cap');
    expect(over.seen).toMatch(/daily cap/);
    expect(over.proposals).toBe(0);
    P.setBrain((v) => (v.calls === 0 ? post(40_000, 'under the day') : { text: 'waiting' }));
    const under = await P.ask('Accrue under the cap');
    const c2 = await pendingCard(under.job_id); // fits: proposed, not refused
    await P.api('POST', `/api/desk/${c2.id}/answer`, { decision: 'no', fingerprint_seen: c2.fingerprint });

    await P.api('PUT', '/api/switchboards/ledger', {
      rules: [{ id: 'month-cap', type: 'amount_cap', currency: 'INR', per_day_minor: 1_000_000_000, per_month_minor: u.month_minor + 50_000, applies_to: ['ledger.journal.post'] }],
    });
    const overMonth = await refusedWith(post(60_000, 'over the month'));
    expect(overMonth.seen).toContain('rule:month-cap');
    expect(overMonth.seen).toMatch(/monthly cap/);
    await P.api('PUT', '/api/switchboards/ledger', { rules: [] });
  });
});

describe('the switchboard cache', () => {
  it('a change to the app’s own switchboard NOTIFYs the gate, which drops its cache at once; with no notice the cache lives its short TTL', async () => {
    // (Before v3 S1 a gateway token carrying a newer sb_version forced the refetch; the board now lives in the
    // app's own schema and every change there NOTIFYs 'board:<company>', so no token needs to carry it.)
    const core = P.backend.core;
    const loads = vi.spyOn(core.board, 'load');
    try {
      const pnl = core.ability('ledger.report.pnl')!;
      core.board.invalidate(P.company.id);
      const v0 = await core.board.get(P.company.id);
      expect(v0.setting(pnl)).toBe('on');
      await core.board.get(P.company.id);
      expect(loads).toHaveBeenCalledTimes(1); // cached

      // Switched off by a hand that bypasses the triggers: no NOTIFY, so the cache stands until its TTL.
      await silentSwitchboard({ 'ledger.report.pnl': 'off' });
      const n = loads.mock.calls.length;
      expect((await core.board.get(P.company.id)).setting(pnl)).toBe('on'); // still the cached board
      expect(loads.mock.calls.length).toBe(n);
      const r = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'ledger.report.pnl', company_id: P.company.id, body: { from: '2026-08-01', to: '2026-08-31' }, idem_key: `sbv:${Date.now()}` });
      expect(r.status).toBe(200); // the cached board said on
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + BOARD_TTL_MS + 1_000);
      try {
        const b = await core.board.get(P.company.id);
        expect(b.setting(pnl)).toBe('off');
        expect(b.version).toBe(v0.version + 1);
      } finally {
        clock.mockRestore();
      }
      expect(loads.mock.calls.length).toBe(n + 1);

      // Back on through the desk (the platform writes through as neos_desk): the trigger NOTIFYs, the gate drops
      // its board well within a second, without waiting for the TTL.
      await core.board.get(P.company.id); // warm
      const t0 = Date.now();
      expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'on' } })).status).toBe(200);
      await P.waitFor(async () => (await core.board.get(P.company.id)).setting(pnl) === 'on', 'the NOTIFY dropped the cache', 1_000);
      expect(Date.now() - t0).toBeLessThan(BOARD_TTL_MS);
      const r2 = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'ledger.report.pnl', company_id: P.company.id, body: { from: '2026-08-01', to: '2026-08-31' }, idem_key: `sbv2:${Date.now()}` });
      expect(r2.status).toBe(200);

      // And off through the desk: refused on the very next call.
      expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'off' } })).status).toBe(200);
      await P.waitFor(async () => (await core.board.get(P.company.id)).setting(pnl) === 'off', 'the NOTIFY dropped the cache', 1_000);
      const r3 = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'ledger.report.pnl', company_id: P.company.id, body: { from: '2026-08-01', to: '2026-08-31' }, idem_key: `sbv3:${Date.now()}` });
      expect(r3.status).toBe(403);
      expect(r3.body.error.code).toBe('switched_off');
    } finally {
      loads.mockRestore();
      await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'on' } });
      P.backend.core.board.invalidate(P.company.id);
    }
  });
});

describe('step.mirror', () => {
  it('is deduplicated on replay: the app never writes one twice, the platform never applies one twice', async () => {
    P.setBrain((v) => (v.calls === 0 ? call('book.note', { text: 'A note to mirror' }) : finish('noted')));
    const { task_id, job_id } = await P.ask('Write a note');
    await taskDone(task_id);
    const count = async () => (await P.platform.db.query('select count(*)::int as n from neos.activity where job_id = $1', [job_id])).rows[0].n as number;
    const mirrors = async () => (await P.backend.core.runnerPool.query("select count(*)::int as n from ledger.outbox where event_type = 'step.mirror' and payload->>'job_id' = $1", [job_id])).rows[0].n as number;
    const steps = (await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.steps where job_id = $1', [job_id])).rows[0].n;
    await P.waitFor(async () => (await count()) === steps, 'every step mirrored');
    expect(await mirrors()).toBe(steps);

    // The app re-emits the same mirror (a retried transaction): the dedupe key holds.
    await withCompany(P.backend.core.appPool, P.company.id, (c) => P.backend.core.book.emit(c, P.company.id, 'step.mirror', { job_id, seq: 1, kind: 'received', summary: 'again' }, `step:${job_id}:1`));
    expect(await mirrors()).toBe(steps);

    // The platform replays the whole outbox from the start: nothing is applied twice.
    const cursor = (await P.platform.db.query("select cursor from neos.outbox_cursors where app_key = 'ledger'")).rows[0].cursor;
    await P.platform.db.query("update neos.outbox_cursors set cursor = 0 where app_key = 'ledger'");
    await P.waitFor(async () => Number((await P.platform.db.query("select cursor from neos.outbox_cursors where app_key = 'ledger'")).rows[0].cursor) >= Number(cursor), 'replayed');
    expect(await count()).toBe(steps);
    const summaries = (await P.platform.db.query('select summary from neos.activity where job_id = $1 and seq = 1', [job_id])).rows;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).not.toBe('again');
  });
});
