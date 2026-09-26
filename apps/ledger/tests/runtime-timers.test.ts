// runtime-timers.test · WP §7 "a scheduled time arriving → the job starts":
// schedules open one timer job per slot (idempotent across ticks and restarts),
// a timer job that missed its window is EXPIRED rather than run stale, and
// job.wait_until parks a job until a time. Also: the rolling summary written to
// steps (plan), facts tied to the job first, the LISTEN hint, the session limit,
// and t004 applied forward on a populated book.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const q = async (sql: string, params: unknown[] = []) => (await P.backend.core.runnerPool.query(sql, params)).rows;

async function l3(method: 'GET' | 'POST', p: string, ability: string, body?: unknown, sub = 'platform') {
  const token = await P.platform.gateway.mint({ aud: 'ledger', sub, company_id: P.company.id, ability, idem_key: crypto.randomUUID() });
  const res = await fetch(`http://127.0.0.1:${P.backend.ports.l3}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'contract-version': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('schedules (L3, platform only)', () => {
  it('only the platform sets and lists schedules; rules are validated', async () => {
    const ok = await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'Daily cash position', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '09:00' } });
    expect(ok.status).toBe(200);
    expect(ok.body.schedule).toMatchObject({ ask: 'Daily cash position', time_zone: 'Asia/Kolkata', enabled: true });
    expect(new Date(ok.body.schedule.next_run_at).getTime()).toBeGreaterThan(Date.now());
    // 09:00 in Kolkata is 03:30 UTC.
    expect(new Date(ok.body.schedule.next_run_at).toISOString()).toMatch(/T03:30:00\.000Z$/);
    expect((await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'x', requester: `user:${P.admin.id}`, rule: { every: 'week', at: '09:00' } })).status).toBe(400);
    expect((await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'x', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '25:00' } })).status).toBe(400);
    expect((await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'x', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '09:00' } }, 'app:marketing')).status).toBe(403);
    const off = await l3('POST', '/l3/schedules.set', 'schedules.set', { id: ok.body.schedule.id, ask: 'Daily cash position', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '09:00' }, enabled: false });
    expect(off.body.schedule).toMatchObject({ enabled: false, next_run_at: null });
    const list = await l3('GET', '/l3/schedules', 'schedules.list');
    expect(list.status).toBe(200);
    expect(list.body.schedules.map((s: any) => s.id)).toContain(ok.body.schedule.id);
  });

  it('a due schedule opens one timer job per slot, across ticks, concurrent runners and a restart', async () => {
    const asks: string[] = [];
    P.setBrain((v) => {
      if (v.job.includes('Weekly receivables check')) asks.push(v.job);
      return finish('Checked receivables.');
    });
    const s = (await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'Weekly receivables check', requester: `user:${P.admin.id}`, rule: { every: 'week', at: '10:00', weekday: 1 } })).body.schedule;
    // Make it due now (database time): the slot is one minute ago.
    const [{ slot }] = await q(`update ledger.schedules set next_run_at = date_trunc('second', now()) - interval '1 minute' where id = $1 returning next_run_at as slot`, [s.id]);
    const runner = P.backend.runner;
    await Promise.all([runner.fireSchedules(), runner.fireSchedules(), runner.fireSchedules()]);
    await runner.fireSchedules();
    const jobsFor = () => q(`select * from ledger.jobs where source = 'timer' and ask = 'Weekly receivables check'`);
    const jobs = await jobsFor();
    expect(jobs).toHaveLength(1);
    const [{ tid }] = await q(`select md5($1::text || ':' || extract(epoch from $2::timestamptz)::bigint::text)::uuid::text as tid`, [s.id, slot]);
    expect(jobs[0].task_id).toBe(tid); // deterministic: (schedule, slot)
    expect(jobs[0].requester).toBe(`user:${P.admin.id}`);
    const after = (await q('select next_run_at, last_run_at, now() as now from ledger.schedules where id = $1', [s.id]))[0];
    expect(after.last_run_at.getTime()).toBe(slot.getTime());
    expect(after.next_run_at.getTime()).toBeGreaterThan(after.now.getTime());
    await P.waitFor(async () => (await jobsFor())[0].status === 'DONE', 'timer job ran');

    // The same slot comes round again (a restored book, a second runner that saw it due): after a restart, still one job.
    await q('update ledger.schedules set next_run_at = $2 where id = $1', [s.id, slot]);
    await P.restartBackend();
    await P.waitFor(async () => (await q('select next_run_at > now() as moved from ledger.schedules where id = $1', [s.id]))[0].moved, 'restarted runner advanced it');
    expect(await jobsFor()).toHaveLength(1);
    expect(asks).toHaveLength(1);
    await l3('POST', '/l3/schedules.set', 'schedules.set', { id: s.id, ask: 'Weekly receivables check', requester: `user:${P.admin.id}`, rule: { every: 'week', at: '10:00', weekday: 1 }, enabled: false });
  });

  it('a slot missed by more than its window (an outage) is EXPIRED, never run late', async () => {
    let ran = false;
    P.setBrain((v) => {
      if (v.job.includes('Stale morning report')) ran = true;
      return finish('ok');
    });
    const s = (await l3('POST', '/l3/schedules.set', 'schedules.set', { ask: 'Stale morning report', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '08:00' } })).body.schedule;
    await q(`update ledger.schedules set next_run_at = now() - interval '2 hours' where id = $1`, [s.id]);
    const job = await P.waitFor(async () => {
      const j = (await q(`select * from ledger.jobs where source = 'timer' and ask = 'Stale morning report'`))[0];
      return j?.status === 'EXPIRED' && j;
    }, 'expired');
    expect(ran).toBe(false);
    expect(job.attempts).toBe(0);
    expect(job.result.summary).toMatch(/^Skipped: this scheduled run was due by .* and did not start in time/);
    const steps = await q('select kind, summary from ledger.steps where job_id = $1 order by seq', [job.id]);
    expect(steps.map((x: any) => x.kind)).toEqual(['received', 'failed']);
    const ev = await q("select payload from ledger.outbox where event_type = 'task.failed' and payload->>'job_id' = $1", [job.id]);
    expect(ev[0].payload.expired).toBe(true);
    expect((await q('select next_run_at > now() as future from ledger.schedules where id = $1', [s.id]))[0].future).toBe(true);
    await l3('POST', '/l3/schedules.set', 'schedules.set', { id: s.id, ask: 'Stale morning report', requester: `user:${P.admin.id}`, rule: { every: 'day', at: '08:00' }, enabled: false });
  });
});

describe('job.wait_until', () => {
  it('parks the job until the time, then the runner wakes it with its reason', async () => {
    const at = new Date(Date.now() + 1_500).toISOString();
    let woke = '';
    let refused = '';
    P.setBrain((v) => {
      if (v.job.includes('The time you chose to wait until has come')) {
        woke = v.job;
        return finish('Checked again after the due date.');
      }
      if (v.calls === 0) return call('job.wait_until', { at: '2020-01-01T00:00:00Z', reason: 'the past' });
      if (v.calls === 1) {
        refused = v.results[0]!.text;
        return call('job.wait_until', { at, reason: 'the customer promised to pay by then' });
      }
      return { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Check whether the customer paid, after the promised date');
    await P.waitFor(async () => (await P.jobRow(job_id)).status === 'WAITING', 'waiting');
    expect(refused).toMatch(/in the future/);
    const w = (await q("select status, expires_at, answer from ledger.waits where job_id = $1 and kind = 'timer'", [job_id]))[0];
    expect(w.status).toBe('pending');
    expect(w.expires_at.toISOString()).toBe(at);
    await P.waitFor(async () => (await P.task(task_id)).task.status === 'COMPLETED', 'woken and finished', 10_000);
    expect(woke).toContain('the customer promised to pay by then');
    const resume = (await q("select created_at from ledger.steps where job_id = $1 and kind = 'resume'", [job_id]))[0];
    expect(resume.created_at.getTime()).toBeGreaterThanOrEqual(new Date(at).getTime());
  });
});

describe('the rolling summary and facts', () => {
  it('steps past the last 20 are folded into a summary step, extended across resumes; facts tied to the job come first', async () => {
    const note = (i: number, facts?: unknown[]) => call('book.note', { text: `Checked item ${i}`, ...(facts ? { facts } : {}) });
    const post = (memo: string) =>
      call('ledger.journal.post', {
        date: '2026-08-31',
        memo,
        currency: 'INR',
        lines: [
          { account_code: '6300', debit_minor: 5_000, credit_minor: 0 },
          { account_code: '2000', debit_minor: 0, credit_minor: 5_000 },
        ],
        card: { what: memo, why: 'test', changes: 'One entry', if_no_answer: 'Nothing' },
      });
    const wakes: string[] = [];
    P.setBrain((v) => {
      if (v.job.includes('Bulk company fact')) return v.calls === 0 ? call('book.note', { text: 'many facts', facts: Array.from({ length: 25 }, (_, i) => ({ subject: `unrelated ${i}`, value: i, source: 'bulk import' })) }) : finish('ok');
      if (!v.job.includes('WOKEN')) {
        if (v.calls === 0) return note(0, [{ subject: 'audit fee quote', value: 'INR 50,000', source: 'auditor email' }]);
        return v.calls < 25 ? note(v.calls) : v.calls === 25 ? post('first accrual') : { text: 'waiting' };
      }
      if (v.calls === 0) wakes.push(v.job);
      if (wakes.length === 1) return v.calls < 10 ? note(100 + v.calls) : v.calls === 10 ? post('second accrual') : { text: 'waiting' };
      return finish('Done with the long job.');
    });
    const { task_id, job_id } = await P.ask('Work through the audit accrual checklist');
    const card1 = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING'), 'first card');
    // Another job writes 25 newer company facts before the wake.
    const other = await P.ask('Bulk company fact import');
    await P.waitFor(async () => (await P.task(other.task_id)).task.status === 'COMPLETED', 'bulk facts');
    await P.api('POST', `/api/desk/${card1.id}/answer`, { decision: 'no', fingerprint_seen: card1.fingerprint });
    const card2 = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING' && c.id !== card1.id), 'second card');
    await P.api('POST', `/api/desk/${card2.id}/answer`, { decision: 'no', fingerprint_seen: card2.fingerprint });
    await P.waitFor(async () => (await P.task(task_id)).task.status === 'COMPLETED', 'finished');

    const summaries = await q("select seq, summary, output_ref from ledger.steps where job_id = $1 and kind = 'summary' order by seq", [job_id]);
    expect(summaries).toHaveLength(2); // one per resume that had steps roll out of the window
    const [a, b] = summaries;
    expect(b.output_ref.through_seq).toBeGreaterThan(a.output_ref.through_seq);
    // Each summary covers exactly the (non-summary) steps up to its mark: nothing lost, nothing counted twice.
    for (const x of [a, b]) {
      const n = (await q("select count(*)::int as n from ledger.steps where job_id = $1 and kind <> 'summary' and seq <= $2", [job_id, x.output_ref.through_seq]))[0].n;
      expect(x.output_ref.covers).toBe(n);
    }
    expect(b.output_ref.body.startsWith(a.output_ref.body)).toBe(true); // extended, not rebuilt
    expect(a.summary).toContain('Checked item 0');

    // Each wake saw at most 20 steps in full plus the summary.
    for (const [i, w] of wakes.entries()) {
      expect(w).toContain(`Earlier: ${summaries[i].summary}`);
      const listed = w.split('\n').filter((l) => /^ {2}\d+\. \[/.test(l));
      expect(listed.length).toBeLessThanOrEqual(20);
      expect(listed.some((l) => l.includes('[summary]'))).toBe(false);
    }
    // The fact this job wrote outranks 25 newer unrelated ones.
    expect(wakes[0]).toContain('audit fee quote');
    // Summaries are memory for the assistant, not steps mirrored to people.
    const mirrored = await P.platform.db.query("select count(*)::int as n from neos.activity where job_id = $1 and kind = 'summary'", [job_id]);
    expect(mirrored.rows[0].n).toBe(0);
  });
});

describe('runner timing', () => {
  let Q: Pilot;
  beforeAll(async () => {
    // The poll is a minute away: only the LISTEN hint can start a job quickly. Sessions end at 1.5 s.
    Q = await bootPilot({ timings: { pollMs: 60_000, sessionMaxMs: 1_500 } });
  });
  afterAll(async () => Q?.close());

  it('a new job starts on the LISTEN hint, not the poll', async () => {
    Q.setBrain(() => finish('quick'));
    const t0 = Date.now();
    const { task_id } = await Q.ask('Quick one');
    await Q.waitFor(async () => (await Q.task(task_id)).task.status === 'COMPLETED', 'done on the hint', 10_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a session past its time limit is stopped and the job ends with a clear failure', async () => {
    Q.setBrain(() => ({ hang: true }));
    const { task_id, job_id } = await Q.ask('This will hang');
    const t = await Q.waitFor(async () => {
      const t = await Q.task(task_id);
      return t.task.status === 'FAILED' && t;
    }, 'timed out', 15_000);
    expect(t.task.result.summary).toBe('The assistant stopped without reporting (timeout). Nothing further was done.');
    expect((await Q.jobRow(job_id)).attempts).toBe(0);
  });
});

describe('t004 on a populated book', () => {
  it('t004 applies forward on a populated book: history kept, summaries and schedules work', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-t004-'));
    try {
      // The template as it was before t004.
      await cp(TEMPLATE_MIGRATIONS, dir, { recursive: true });
      await rm(path.join(dir, 't004_timers_and_summary.sql'));
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      led.migrations = led.migrations.filter((m: any) => m.file !== 't004_timers_and_summary.sql');
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (tdir: string) =>
        migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: path.join(LEDGER_ROOT, 'migrations'), prepend: await templateFiles(tdir) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(dir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      await seedLedger(pool, CO);
      const jobId = await withCompany(pool, CO, async (c) => {
        const j = await c.query<{ id: string }>("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'task', 'user:x', gen_random_uuid(), 'old job', 'DONE') returning id", [CO]);
        for (let i = 1; i <= 30; i++) await c.query("insert into ledger.steps (company_id, job_id, seq, kind, summary) values ($1, $2, $3, 'note', $4)", [CO, j.rows[0]!.id, i, `old step ${i}`]);
        return j.rows[0]!.id;
      });
      const applied = await run(TEMPLATE_MIGRATIONS);
      expect(applied.map((m) => m.name)).toEqual(['t004_timers_and_summary.sql']);
      await withCompany(pool, CO, async (c) => {
        expect((await c.query('select count(*)::int as n from ledger.steps where job_id = $1', [jobId])).rows[0].n).toBe(30);
        expect((await c.query('select count(*)::int as n from ledger.journal_entries')).rows[0].n).toBeGreaterThan(20);
        expect((await c.query('select run_by from ledger.jobs where id = $1', [jobId])).rows[0].run_by).toBeNull();
        await c.query("insert into ledger.steps (company_id, job_id, seq, kind, summary) values ($1, $2, 31, 'summary', 'rolled')", [CO, jobId]);
        await expect(c.query("insert into ledger.steps (company_id, job_id, seq, kind, summary) values ($1, $2, 32, 'bogus', 'x')", [CO, jobId])).rejects.toThrow(/steps_kind_check/);
      });
      await withCompany(pool, CO, async (c) => {
        const next = async (rule: unknown, after: string) => (await c.query('select ledger.next_run($1, $2, $3) as t', [JSON.stringify(rule), 'Asia/Kolkata', after])).rows[0].t.toISOString();
        expect(await next({ every: 'day', at: '09:00' }, '2026-09-26T10:00:00+05:30')).toBe('2026-09-27T03:30:00.000Z');
        expect(await next({ every: 'day', at: '09:00' }, '2026-09-26T08:00:00+05:30')).toBe('2026-09-26T03:30:00.000Z');
        expect(await next({ every: 'week', at: '09:00', weekday: 1 }, '2026-09-26T10:00:00+05:30')).toBe('2026-09-28T03:30:00.000Z'); // Sat → Mon
        expect(await next({ every: 'month', at: '09:00', day: 31 }, '2026-02-01T00:00:00+05:30')).toBe('2026-02-28T03:30:00.000Z'); // clamped
        // Schedules are tenant rows like any other.
        await c.query("insert into ledger.schedules (company_id, ask, requester, rule, time_zone) values ($1, 'x', 'user:x', '{\"every\":\"day\",\"at\":\"09:00\"}', 'Asia/Kolkata')", [CO]);
        await expect(c.query("insert into ledger.schedules (company_id, ask, requester, rule, time_zone) values ($1, 'x', 'user:x', '{\"every\":\"hour\",\"at\":\"09:00\"}', 'Asia/Kolkata')", [CO])).rejects.toThrow(/check/);
      });
      await withCompany(pool, '99999999-2222-3333-4444-555555555555', async (c) => {
        expect((await c.query('select count(*)::int as n from ledger.schedules')).rows[0].n).toBe(0);
      });
      await pool.end();
    } finally {
      await db.drop();
    }
  });
});
