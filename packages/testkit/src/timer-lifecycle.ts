import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, sqlIdent } from '@neop/pgkit';
import { Runner, toolName, type AppDefinition } from '@neop/template';
import { bootPilot, type Pilot } from './pilot.ts';

/** Persisted timer recovery only. Synthetic Matrix/model transport; no business or provider effect. */
export function timerLifecycle(app: string, definition: () => Promise<AppDefinition>) {
  const s = sqlIdent(app);
  let P: Pilot, admin: ReturnType<typeof createPool>, stopped = false;
  const query = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows;
  const finish = () => ({ tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Recorded timer outcome; no business action.' } });
  beforeAll(async () => {
    P = await bootPilot({ apps: [{ def: await definition() }] });
    admin = createPool(P.adminUrl, 3);
  });
  afterEach(async () => { if (stopped) await restart(); });
  afterAll(async () => { try { await admin?.end(); } finally { await P?.close(); } });

  async function quiescent() {
    await P.waitFor(async () => P.backend.runner.active.size === 0
      && P.backend.core.runnerPool.waitingCount === 0
      && P.backend.core.runnerPool.idleCount === P.backend.core.runnerPool.totalCount,
    'quiescent timer fixture');
  }
  async function stop() { await P.backend.runner.stop(); stopped = true; await quiescent(); }
  async function restart() { await P.restartBackend(app); stopped = false; }
  async function start() {
    const ask = `Timer fixture ${randomUUID()}`, reason = `Recheck synthetic evidence for ${ask}`;
    // Far enough ahead that normal setup is not a timing assertion. Tests move only their own deadline in SQL.
    const at = (await query("select clock_timestamp() + interval '1 hour' as at"))[0].at.toISOString();
    const wakes: string[] = [];
    P.setBrain(v => {
      if (v.job.includes('WOKEN')) {
        if (v.calls === 0 && v.job.includes(`\n"${ask}"\n`)) wakes.push(v.job);
        return finish();
      }
      if (v.calls === 0) return { tool: toolName('book.note'), args: { text: `Persisted before parking: ${ask}` } };
      if (v.calls === 1) return { tool: toolName('job.wait_until'), args: { at, reason } };
      return { text: 'waiting' };
    });
    const task = await P.ask(ask, undefined, app);
    await P.waitFor(async () => (await P.jobRow(task.job_id)).status === 'WAITING', 'timer parked');
    await quiescent();
    const waits = await query(`select * from ${s}.waits where job_id=$1`, [task.job_id]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ kind: 'timer', status: 'pending', answer: { at, reason } });
    return { ...task, waitId: waits[0].id as string, ask, at, reason, wakes };
  }
  type Task = Awaited<ReturnType<typeof start>>;
  const wait = async (t: Task) => (await query(`select * from ${s}.waits where id=$1`, [t.waitId]))[0];
  const due = (t: Task) => query(`update ${s}.waits set expires_at=clock_timestamp()-interval '1 second' where id=$1`, [t.waitId]);
  async function noEffect(t: { job_id: string }) {
    expect(await query(`select 1 from ${s}.proposals where job_id=$1`, [t.job_id])).toEqual([]);
    expect(await query(`select 1 from ${s}.operations where job_id=$1`, [t.job_id])).toEqual([]);
  }
  async function done(t: Task) {
    await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'timer completed');
    await quiescent();
    expect(await wait(t)).toMatchObject({ status: 'consumed', outcome: 'TIMER', answer: { at: t.at, reason: t.reason, timer: true } });
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]).toContain('The time you chose to wait until has come');
    expect(t.wakes[0]).toContain(t.reason);
    expect(t.wakes[0]).toContain(`Persisted before parking: ${t.ask}`);
    expect(await query(`select 1 from ${s}.steps where job_id=$1 and kind='resume'`, [t.job_id])).toHaveLength(1);
    expect(await query(`select 1 from ${s}.outbox where dedupe_key=$1`, [`finish:${t.job_id}`])).toHaveLength(1);
    await noEffect(t);
  }

  describe(`${app} persisted timer lifecycle`, () => {
    it('refuses invalid, past, over-limit or reasonless timers without recording a wait', async () => {
      const tooFar = (await query("select clock_timestamp() + interval '32 days' as at"))[0].at.toISOString();
      const args = [
        { at: 'not-a-date', reason: 'fixture' },
        { at: '2000-01-01T00:00:00Z', reason: 'fixture' },
        { at: tooFar, reason: 'fixture' },
        { at: tooFar, reason: '  ' },
      ];
      let results: string[] = [];
      P.setBrain(v => {
        if (v.calls < args.length) return { tool: toolName('job.wait_until'), args: args[v.calls]! };
        results = v.results.map(r => r.text);
        return finish();
      });
      const task = await P.ask(`Invalid timer fixture ${randomUUID()}`, undefined, app);
      await P.waitFor(async () => (await P.task(task.task_id)).task.status === 'COMPLETED', 'invalid timers refused');
      await quiescent();
      expect(results).toHaveLength(args.length);
      for (const result of results) expect(result).toContain('invalid_args');
      expect(await query(`select 1 from ${s}.waits where job_id=$1`, [task.job_id])).toEqual([]);
      await noEffect(task);
    });

    it('keeps a future timer parked through restart, then rebuilds one assistant from the persisted book', async () => {
      const t = await start(); await stop(); await restart(); await stop();
      expect(await P.backend.runner.expire()).toBe(0);
      expect(await P.backend.runner.claim(1)).toEqual([]);
      expect(await wait(t)).toMatchObject({ status: 'pending', outcome: null });
      expect(t.wakes).toEqual([]);
      await due(t); expect(await P.backend.runner.expire()).toBe(1);
      await restart(); await done(t);
    });

    it('expires and claims once across competing runners, then recovers an abandoned claim without losing the wait', async () => {
      const t = await start(); await stop(); await due(t);
      const runners = [new Runner(P.backend.core), new Runner(P.backend.core)];
      const counts = await Promise.all(runners.map(r => r.expire()));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      const claims = (await Promise.all(runners.map(r => r.claim(1)))).flat();
      expect(claims).toHaveLength(1);
      const old = claims[0]!;
      expect(old.id).toBe(t.job_id);
      expect(await wait(t)).toMatchObject({ status: 'ready', claimed_by: old.claimed_by });
      expect(await runners[1]!.claim(1)).toEqual([]);
      // Synthetic crash after claiming but before model dispatch. No heartbeat can extend this abandoned lease.
      await query(`update ${s}.jobs set claimed_until=clock_timestamp()-interval '1 second' where id=$1`, [t.job_id]);
      await restart(); await done(t);
      expect((await P.jobRow(t.job_id)).attempts).toBe(1);
      await expect(P.backend.gate.call({ sub: t.job_id, sid: old.claimed_by!, company_id: P.company.id, app, abilities: [] },
        'book.note', { text: 'stale claimant must not write' })).rejects.toThrow('no longer holds the job');
      expect(await query(`select 1 from ${s}.steps where job_id=$1 and summary='stale claimant must not write'`, [t.job_id])).toEqual([]);
    });

    it.each(['pending', 'ready'])('cancels a %s timer durably without a resumed assistant', async state => {
      const t = await start(); await stop();
      if (state === 'ready') { await due(t); expect(await P.backend.runner.expire()).toBe(1); }
      expect((await P.api('POST', `/api/tasks/${t.task_id}/cancel`, { reason: 'Synthetic timer cancellation' })).status).toBe(200);
      expect((await P.jobRow(t.job_id)).status).toBe('CANCELLED');
      expect(await wait(t)).toMatchObject({ status: 'consumed', outcome: state === 'ready' ? 'TIMER' : 'CANCELLED' });
      await due(t); expect(await P.backend.runner.expire()).toBe(0);
      await restart(); await quiescent();
      expect(await P.backend.runner.claim(1)).toEqual([]);
      expect(t.wakes).toEqual([]);
      expect(await query(`select 1 from ${s}.steps where job_id=$1 and kind='resume'`, [t.job_id])).toEqual([]);
      await noEffect(t);
    });

    it('recovers a due timer through polling when its LISTEN connection is lost', async () => {
      const t = await start();
      // Kill only the exact LISTEN session in this test's database. Do not mock kick(), NOTIFY or expiry.
      const listeners = await query('select pid from pg_stat_activity where datname=current_database() and usename=$1 and query=$2',
        [`${app}_runner`, `listen neop_${app}`]);
      expect(listeners).toHaveLength(1);
      expect((await query('select pg_terminate_backend($1) as stopped', [listeners[0].pid]))[0].stopped).toBe(true);
      await P.waitFor(async () => (await query('select 1 from pg_stat_activity where pid=$1', [listeners[0].pid])).length === 0, 'listener disconnected');
      await due(t);
      await done(t); // No manual kick, tick, expiry or restart: scheduled expiry and polling must find persisted work.
      expect(await query('select 1 from pg_stat_activity where datname=current_database() and usename=$1 and query=$2',
        [`${app}_runner`, `listen neop_${app}`])).toEqual([]);
    });
  });
}
