// runtime-gate.test · the gate and the approved path hold what the plan says
// they hold, on real calls: the version a yes was given to (gate step 2), the
// setting at effect time, superseded_by, the tool-call cap with a report still
// possible, company rules through the real ruleUsage SQL, the switchboard cache
// (sb_version, 30 s TTL) and step.mirror dedup on replay.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@neop/pgkit';
import { ruleUsage, zonedParts } from '@neop/template';
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

/** Record a person's yes in the app without the platform's worker executing it. */
async function yesWithoutExecuting(card: any) {
  await P.platform.db.query(
    "update neos.approvals set status = 'RESOLVED', decision = 'yes', fingerprint_seen = fingerprint, decided_by = $2, next_attempt_at = now() + interval '1 hour' where id = $1",
    [card.id, P.admin.id],
  );
  const r = await P.platform.gateway.call({
    caller: 'platform',
    app: 'ledger',
    endpoint: 'proposals.resolve',
    company_id: P.company.id,
    idem_key: `yes:${card.id}`,
    body: { proposal_id: card.proposal_id, decision: 'yes', fingerprint_seen: card.fingerprint, decided_by: `user:${P.admin.id}` },
  });
  expect(r.status).toBe(200);
}

/** A new switchboard version written straight to the platform's table: no switchboard.changed reaches the app. */
async function silentSwitchboard(settings: Record<string, string>) {
  await P.platform.db.query(
    `insert into neos.switchboards (company_id, app_key, version, settings, rules, budget, approvals)
     select company_id, app_key, version + 1, settings || $3::jsonb, rules, budget, approvals from neos.switchboards
      where company_id = $1 and app_key = $2 order by version desc limit 1`,
    [P.company.id, 'ledger', JSON.stringify(settings)],
  );
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

  it('an execution token naming another ability version is refused the same way (token claim ability_version)', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('not run', 'blocked') : v.calls === 0 ? post(111_200, 'token version probe') : { text: 'waiting' }));
    const { job_id } = await P.ask('Accrue the token probe');
    const card = await pendingCard(job_id);
    await yesWithoutExecuting(card);
    const token = await P.platform.gateway.mint({
      aud: 'ledger',
      sub: 'platform',
      company_id: P.company.id,
      ability: 'proposals.execute',
      idem_key: `tv:${card.id}`,
      exec: true,
      proposal_id: card.proposal_id,
      fingerprint: card.fingerprint,
      ability_version: '0.9.0',
    });
    const res = await fetch(`http://127.0.0.1:${P.backend.ports.l3}/l3/proposals.execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'contract-version': '1' },
      body: JSON.stringify({ proposal_id: card.proposal_id }),
    });
    expect(res.status).toBe(200);
    const proof = await res.json();
    expect(proof.outcome).toBe('FAILED');
    expect(proof.error).toMatch(/^version_changed: .*\(approved as 0\.9\.0\)/);
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
    const r = await P.platform.gateway.call({
      caller: 'platform',
      app: 'ledger',
      endpoint: 'proposals.execute',
      company_id: P.company.id,
      body: { proposal_id: card.proposal_id },
      idem_key: `off:${card.id}`,
      exec: { proposal_id: card.proposal_id, fingerprint: card.fingerprint },
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('FAILED');
    expect(r.body.error).toMatch(/^switched_off/);
    await taskDone(task_id);
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
    // Switched off (silently, no switchboard.changed) after the gate decided and the grant was
    // issued, before the effect: exactly the window a cached setting would miss.
    const platform = P.backend.core.platform;
    const real = platform.grantExecutionToken.bind(platform);
    const spy = vi.spyOn(platform, 'grantExecutionToken').mockImplementation(async (req) => {
      const t = await real(req);
      await silentSwitchboard({ 'ledger.journal.post': 'off' });
      return t;
    });
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
      spy.mockRestore();
      await P.platform.db.query("update neos.grants set status = 'REVOKED' where company_id = $1 and ability_key = 'ledger.journal.post'", [P.company.id]);
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
  it('a gateway token with a newer sb_version forces a refetch; otherwise the cache lives 30 s', async () => {
    const core = P.backend.core;
    const fetches = vi.spyOn(core.board.client, 'switchboard');
    try {
      const pnl = core.ability('ledger.report.pnl')!;
      core.board.invalidate(P.company.id);
      const v0 = await core.board.get(P.company.id);
      expect(v0.setting(pnl)).toBe('on');
      await core.board.get(P.company.id);
      expect(fetches).toHaveBeenCalledTimes(1); // cached

      // Switched off on the platform with no switchboard.changed: the next gateway call carries the new version.
      await silentSwitchboard({ 'ledger.report.pnl': 'off' });
      expect((await core.board.get(P.company.id)).setting(pnl)).toBe('on'); // still the cached board
      const r = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'ledger.report.pnl', company_id: P.company.id, body: { from: '2026-08-01', to: '2026-08-31' }, idem_key: `sbv:${Date.now()}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('switched_off');
      expect((await core.board.get(P.company.id)).version).toBe(v0.version + 1);

      // Back on, silently: nothing refetches until the cache is 30 s old.
      await silentSwitchboard({ 'ledger.report.pnl': 'on' });
      const n = fetches.mock.calls.length;
      expect((await core.board.get(P.company.id)).setting(pnl)).toBe('off');
      expect(fetches.mock.calls.length).toBe(n);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
      try {
        expect((await core.board.get(P.company.id)).setting(pnl)).toBe('on');
      } finally {
        clock.mockRestore();
      }
      expect(fetches.mock.calls.length).toBe(n + 1);
    } finally {
      fetches.mockRestore();
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
