import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, sqlIdent } from '@neop/pgkit';
import { toolName, type AppDefinition } from '@neop/template';
import { bootPilot, type Pilot } from './pilot.ts';
import { checksumOf } from '../../neop-template/src/data/book.ts';

/** Receiver recovery only: seeded outgoing threads, fake Matrix peer/model, real PostgreSQL transactions. */
export function busResultLifecycle(app: string, definition: () => Promise<AppDefinition>) {
  const s = sqlIdent(app), room = '!result-fixture:acme.example', peer = '@neop_fixture_acme:acme.example';
  const otherRoom = '!other-result-fixture:acme.example';
  let P: Pilot, admin: ReturnType<typeof createPool>;
  const jobs: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows;
  async function stop() {
    await P.backend.runner.stop();
    await P.waitFor(async () => P.backend.runner.active.size === 0
      && P.backend.core.runnerPool.waitingCount === 0
      && P.backend.core.runnerPool.idleCount === P.backend.core.runnerPool.totalCount, 'quiescent result receiver');
  }
  beforeAll(async () => {
    P = await bootPilot({ apps: [{ def: await definition() }], presence: 'appservice' });
    admin = createPool(P.adminUrl, 4);
    await query(`update ${s}.installs set bus_room_id=$2, bus_peers=$3 where company_id=$1`,
      [P.company.id, room, JSON.stringify({ [peer]: 'fixture' })]);
    // Even a mistakenly shared peer identity must not cross the verified room/company boundary.
    await query(`insert into ${s}.installs(company_id,status,matrix_user,bus_room_id,bus_peers)
      values ($1,'active',$2,$3,$4)`, [randomUUID(), `@neop_${app}_other:acme.example`, otherRoom, JSON.stringify({ [peer]: 'fixture' })]);
    await P.presence!.refreshAppservice();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await stop();
    for (const id of jobs.splice(0)) await P.api('POST', `/api/tasks/${id}/cancel`, { reason: 'Fixture cleanup' });
  });
  afterAll(async () => { try { await admin?.end(); } finally { await P?.close(); } });

  async function start(kind: 'task' | 'call') {
    await stop();
    const ask = `Synthetic bus receiver ${randomUUID()}`, thread = randomUUID(), root = `$root-${thread}`;
    const wakes: string[] = [];
    P.setBrain(v => {
      if (v.calls === 0 && v.job.includes(ask)) wakes.push(v.job);
      return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Recorded fixture reply only; no external effect.' } };
    });
    const task = await P.ask(ask, undefined, app); jobs.push(task.task_id);
    // No real provider or borrowed ability is offered by the app. Seed only the receiver's durable precondition.
    await P.backend.core.company(P.company.id, async c => {
      await c.query(`update ${s}.jobs set status='RUNNING' where id=$1`, [task.job_id]);
      await c.query(`update ${s}.jobs set status='WAITING' where id=$1`, [task.job_id]);
      const w = await P.backend.core.book.insertWait(c, { company_id: P.company.id, job_id: task.job_id,
        kind: 'a2a_task', ref_id: thread, expires_at_sql: "now()+interval '1 hour'" });
      await c.query(`insert into ${s}.bus_threads
        (id,company_id,direction,kind,room_id,root_event_id,peer,peer_app,job_id,wait_id,task_id,ability,args,status)
        values ($1,$2,'out',$3,$4,$5,$6,'fixture',$7,$8,$10,$9,'{}','open')`,
      [thread, P.company.id, kind, room, root, peer, task.job_id, w.id, kind === 'call' ? 'fixture.read' : null, thread]);
    });
    return { ...task, thread, root, kind, wakes, ask };
  }
  type Task = Awaited<ReturnType<typeof start>>;
  const event = (t: Task, summary = 'fixture result') => ({ to: app, room_id: room, sender: peer,
    event_id: `$result-${randomUUID()}`, type: t.kind === 'task' ? 'neos.neop.done' : 'neos.neop.answer',
    content: { ...(t.kind === 'task'
      ? { task_id: t.thread, job_id: 'fixture-peer-job', result: { outcome: 'done', summary, changed: [], sources: [] }, could_not: [] }
      : { wait_id: t.thread, answers: {}, result: { status: 'DONE', output: { summary } } }),
    'm.relates_to': { rel_type: 'm.thread', event_id: t.root } } });
  async function snapshot(t: Task) {
    return {
      thread: (await query(`select status,result from ${s}.bus_threads where id=$1`, [t.thread]))[0],
      waits: await query(`select status,outcome,answer from ${s}.waits where job_id=$1 order by created_at,id`, [t.job_id]),
      ops: await query(`select outcome,result_checksum from ${s}.operations where job_id=$1`, [t.job_id]),
      steps: await query(`select summary from ${s}.steps where job_id=$1 and kind='system' and summary like '%fixture%'`, [t.job_id]),
    };
  }
  async function complete(t: Task, restart = true) {
    if (restart) await P.restartBackend(app);
    await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'persisted result resumed');
    await stop();
    const got = await snapshot(t);
    expect(got.waits).toHaveLength(1);
    expect(got.waits[0]).toMatchObject({ status: 'consumed', outcome: 'COMPLETED' });
    expect(got.ops).toHaveLength(1); expect(got.steps).toHaveLength(1);
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]).toContain('<data source="fixture" trust="untrusted">');
    expect(await query(`select 1 from ${s}.proposals where job_id=$1`, [t.job_id])).toEqual([]);
  }

  describe(`${app} atomic cross-NEOP result recovery`, () => {
    it.each([
      ['task', 'step'], ['call', 'step'], ['task', 'receipt'], ['call', 'receipt'],
    ] as const)('rolls back a failed %s %s, then accepts exact-event redelivery after restart once', async (kind, point) => {
      const t = await start(kind), ev = event(t);
      const outbox = () => query(`select id,event_type,payload from ${s}.outbox where payload->>'job_id'=$1 order by id`, [t.job_id]);
      const beforeOutbox = await outbox();
      const spy = point === 'step'
        ? vi.spyOn(P.backend.core.book, 'addStep').mockRejectedValueOnce(new Error('synthetic result evidence failure'))
        : vi.spyOn(P.backend.presence!.inbound, 'setIn').mockRejectedValueOnce(new Error('synthetic receipt failure'));
      const first = await P.hs!.pushTyped(ev);
      spy.mockRestore();
      const failed = await snapshot(t);
      const receipts = await query(`select outcome from ${s}.inbound_events where event_id=$1`, [ev.event_id]);
      expect({ http: first.status, ...failed, receipts }).toMatchObject({ http: 503,
        thread: { status: 'open', result: null }, waits: [{ status: 'pending', outcome: null, answer: null }], ops: [], steps: [], receipts: [] });
      expect(await outbox()).toEqual(beforeOutbox);
      await P.restartBackend(app); await stop();
      expect((await P.hs!.pushTyped(ev)).status).toBe(200);
      const accepted = await snapshot(t);
      expect((await P.hs!.pushTyped(ev)).status).toBe(200);
      expect((await P.hs!.pushTyped(event(t, 'conflicting duplicate'))).status).toBe(200);
      expect(await snapshot(t)).toEqual(accepted);
      await complete(t);
    });

    it.each(['task', 'call'] as const)('serializes two distinct simultaneous %s results to one outcome', async kind => {
      const t = await start(kind), c = await admin.connect();
      let sends: Promise<unknown>[] = [];
      try {
        await c.query('begin'); await c.query(`select 1 from ${s}.bus_threads where id=$1 for update`, [t.thread]);
        sends = [P.hs!.pushTyped(event(t, 'first')), P.hs!.pushTyped(event(t, 'second'))];
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database()
          and usename=any($1::text[]) and wait_event_type='Lock'`, [[`${app}_app`, `${app}_runner`]])).length >= 2,
        'both result receivers blocked on recorded locks');
        await c.query('commit'); await Promise.all(sends);
      } finally { await c.query('rollback'); c.release(); await Promise.allSettled(sends); }
      const got = await snapshot(t);
      expect(got.thread.status).toBe('done');
      expect(got.waits).toHaveLength(1); expect(got.ops).toHaveLength(1); expect(got.steps).toHaveLength(1);
      expect(got.waits[0].answer.result).toEqual(got.thread.result);
      expect(got.ops[0].result_checksum).toEqual(checksumOf(got.thread.result));
      await complete(t);
    });

    it.each(['task', 'call'] as const)('does not wake or mutate a cancelled job for a late %s result', async kind => {
      const t = await start(kind);
      expect((await P.api('POST', `/api/tasks/${t.task_id}/cancel`, { reason: 'Synthetic cancellation' })).status).toBe(200);
      const before = await snapshot(t);
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200);
      expect(await snapshot(t)).toEqual(before);
      await P.restartBackend(app); await stop();
      expect((await P.jobRow(t.job_id)).status).toBe('CANCELLED');
      expect(t.wakes).toEqual([]);
    });

    it.each(['task', 'call'] as const)('rechecks cancellation after a %s result waits on the job lock', async kind => {
      const t = await start(kind), c = await admin.connect();
      let cancel: ReturnType<Pilot['api']> | undefined, delivery: ReturnType<NonNullable<Pilot['hs']>['pushTyped']> | undefined;
      try {
        await c.query('begin'); await c.query(`select 1 from ${s}.jobs where id=$1 for update`, [t.job_id]);
        const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
        cancel = P.api('POST', `/api/tasks/${t.task_id}/cancel`, { reason: 'Cancellation owns the next job lock' });
        await P.waitFor(async () => (await query("select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))", [pid])).length === 1, 'cancellation queued on job');
        delivery = P.hs!.pushTyped(event(t));
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database() and usename=$1 and wait_event_type='Lock'`, [`${app}_runner`])).length === 1, 'result queued behind cancellation');
        await c.query('commit');
        expect((await cancel).status).toBe(200); expect((await delivery).status).toBe(200);
      } finally { await c.query('rollback'); c.release(); await Promise.allSettled([cancel, delivery]); }
      const got = await snapshot(t);
      expect(got.thread).toEqual({ status: 'open', result: null }); expect(got.ops).toEqual([]); expect(got.steps).toEqual([]);
      expect(got.waits).toEqual([{ status: 'consumed', outcome: 'CANCELLED', answer: null }]);
      expect((await P.jobRow(t.job_id)).status).toBe('CANCELLED');
    });

    it.each(['task', 'call'] as const)('rejects malformed, wrong-peer and mismatched-thread %s events without poisoning a valid result', async kind => {
      const t = await start(kind), before = await snapshot(t);
      const wrongRoot = event(t); wrongRoot.content['m.relates_to'].event_id = '$wrong-root';
      const malformed = event(t); (malformed as { content: unknown }).content = { result: 'invalid' };
      for (const ev of [wrongRoot, malformed, { ...event(t), sender: '@unknown:acme.example' }, { ...event(t), room_id: otherRoom }]) {
        expect((await P.hs!.pushTyped(ev)).status).toBe(200);
        expect(await snapshot(t)).toEqual(before);
      }
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200);
      await complete(t);
    });

    it.each(['task', 'call'] as const)('does not acknowledge a duplicate %s while the original transaction later rolls back', async kind => {
      const t = await start(kind), ev = event(t);
      let release!: () => void, entered = false;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const spy = vi.spyOn(P.backend.core.book, 'addStep').mockImplementationOnce(async () => {
        entered = true; await blocked; throw new Error('synthetic overlapping receipt rollback');
      });
      let first: ReturnType<NonNullable<Pilot['hs']>['pushTyped']> | undefined, second: typeof first;
      try {
        first = P.hs!.pushTyped(ev);
        await P.waitFor(async () => entered, 'first result reached rollback boundary');
        second = P.hs!.pushTyped(ev);
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database()
          and usename=$1 and wait_event_type='Lock' and query like '%inbound_events%'`, [`${app}_runner`])).length === 1,
        'duplicate waits for the uncommitted receipt');
        release();
        expect((await first).status).toBe(503); expect((await second).status).toBe(200);
      } finally { release(); await Promise.allSettled([first, second]); spy.mockRestore(); }
      const got = await snapshot(t);
      expect(got.waits).toHaveLength(1); expect(got.ops).toHaveLength(1); expect(got.steps).toHaveLength(1);
      expect(await query(`select outcome from ${s}.inbound_events where event_id=$1`, [ev.event_id]))
        .toEqual([{ outcome: kind === 'task' ? 'typed:bus:done' : 'typed:bus:answered' }]);
      await complete(t);
    });

    it.each(['task', 'call'] as const)('polls a committed %s result after losing its exact LISTEN connection', async kind => {
      const t = await start(kind); await P.restartBackend(app);
      const listeners = await query('select pid from pg_stat_activity where datname=current_database() and usename=$1 and query=$2',
        [`${app}_runner`, `listen neop_${app}`]);
      expect(listeners).toHaveLength(1);
      expect((await query('select pg_terminate_backend($1) as stopped', [listeners[0].pid]))[0].stopped).toBe(true);
      await P.waitFor(async () => (await query('select 1 from pg_stat_activity where pid=$1', [listeners[0].pid])).length === 0, 'fixture listener gone');
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200);
      await complete(t, false); // No restart, manual kick, claim or tick after the reply.
    });
  });
}
