import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, sqlIdent } from '@neop/pgkit';
import { toolName, type AppDefinition } from '@neop/template';
import { bootPilot, type Pilot } from './pilot.ts';

/** Seeded outgoing task and fixture-only tasks.open declaration; real receiver/book/runner, fake peer/model. */
export function busQuestionLifecycle(app: string, definition: () => Promise<AppDefinition>) {
  const s = sqlIdent(app), room = '!question-fixture:acme.example', otherRoom = '!other-question-fixture:acme.example';
  const peer = '@neop_fixture_acme:acme.example';
  let P: Pilot, admin: ReturnType<typeof createPool>;
  const jobs: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows;
  async function stop() {
    await P.backend.runner.stop();
    await P.waitFor(async () => P.backend.runner.active.size === 0
      && P.backend.core.runnerPool.waitingCount === 0
      && P.backend.core.runnerPool.idleCount === P.backend.core.runnerPool.totalCount, 'quiescent question receiver');
  }
  beforeAll(async () => {
    const def = await definition();
    // Production manifests deliberately do not expose these domain hand-offs. Enable only a synthetic peer
    // in this in-memory test definition so the fresh assistant can exercise the existing a2a.answer tool.
    const fixtureDef = { ...def, manifest: { ...def.manifest,
      uses: [...def.manifest.uses, { app: 'fixture', ability: 'tasks.open', range: '^1' }] } };
    P = await bootPilot({ apps: [{ def: fixtureDef }], presence: 'appservice' });
    admin = createPool(P.adminUrl, 4);
    await query(`update ${s}.installs set bus_room_id=$2,bus_peers=$3 where company_id=$1`,
      [P.company.id, room, JSON.stringify({ [peer]: 'fixture' })]);
    await query(`insert into ${s}.installs(company_id,status,matrix_user,bus_room_id,bus_peers)
      values ($1,'active',$2,$3,$4)`, [randomUUID(), `@neop_${app}_other:acme.example`, otherRoom, JSON.stringify({ [peer]: 'fixture' })]);
    await P.presence!.refreshAppservice();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await stop();
    for (const id of jobs.splice(0)) await P.api('POST', `/api/tasks/${id}/cancel`, { reason: 'Fixture cleanup' });
  });
  afterAll(async () => { try { await admin?.end(); } finally { await P?.close(); } });

  async function start() {
    await stop();
    const ask = `Synthetic question receiver ${randomUUID()}`, thread = randomUUID(), root = `$root-${thread}`;
    const wakes: string[] = [];
    P.setBrain(v => {
      if (v.calls === 0 && v.job.includes(ask)) wakes.push(v.job);
      if (v.job.includes('asks a question')) {
        const context = JSON.parse(/<data source="a2a.answer_context" trust="untrusted">\n([\s\S]*?)\n<\/data>/.exec(v.job)![1]!);
        return { tool: toolName('a2a.answer'), args: { ...context, answers: { cost_centre: 'fixture' } } };
      }
      return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Recorded synthetic peer outcome only.' } };
    });
    const task = await P.ask(ask, undefined, app); jobs.push(task.task_id);
    await P.backend.core.company(P.company.id, async c => {
      await c.query(`update ${s}.jobs set status='RUNNING' where id=$1`, [task.job_id]);
      await c.query(`update ${s}.jobs set status='WAITING' where id=$1`, [task.job_id]);
      const w = await P.backend.core.book.insertWait(c, { company_id: P.company.id, job_id: task.job_id,
        kind: 'a2a_task', ref_id: thread, expires_at_sql: "now()+interval '1 hour'" });
      await c.query(`insert into ${s}.bus_threads
        (id,company_id,direction,kind,room_id,root_event_id,peer,peer_app,job_id,wait_id,task_id,status,answer_protocol)
        values ($1,$2,'out','task',$3,$4,$5,'fixture',$6,$7,$8,'open',1)`,
      [thread, P.company.id, room, root, peer, task.job_id, w.id, thread]);
    });
    const due = (await query("select clock_timestamp()+interval '1 hour' as due"))[0].due.toISOString();
    return { ...task, thread, root, ask, wakes, due, peerWait: randomUUID() };
  }
  type Task = Awaited<ReturnType<typeof start>>;
  const event = (t: Task) => ({ to: app, room_id: room, sender: peer, event_id: `$question-${randomUUID()}`,
    type: 'neos.neop.ask', content: { job_id: 'fixture-peer-job', wait_id: t.peerWait,
      question: { text: 'Which cost centre?', why: 'Synthetic question fixture', fields: [{ key: 'cost_centre', label: 'Cost centre' }] }, due: t.due,
      'm.relates_to': { rel_type: 'm.thread', event_id: t.root } } });
  async function snapshot(t: Task) {
    return {
      thread: (await query(`select status,question,result from ${s}.bus_threads where id=$1`, [t.thread]))[0],
      waits: await query(`select status,outcome,answer from ${s}.waits where job_id=$1 order by created_at,id`, [t.job_id]),
      steps: await query(`select summary from ${s}.steps where job_id=$1 and kind='system' and summary like 'fixture asked a question%'`, [t.job_id]),
      outbox: await query(`select id,event_type,payload from ${s}.outbox where payload->>'job_id'=$1 order by id`, [t.job_id]),
    };
  }
  async function answered(t: Task, restart = true) {
    if (restart) await P.restartBackend(app);
    await P.waitFor(async () => (await query(`select 1 from ${s}.bus_threads where id=$1 and question is null`, [t.thread])).length > 0
      && (await P.jobRow(t.job_id)).status === 'WAITING', 'persisted question answered');
    await stop();
    const got = await snapshot(t);
    expect(got.waits).toHaveLength(2);
    expect(got.waits[0]).toMatchObject({ status: 'consumed', outcome: 'NEEDS_INPUT' });
    expect(got.waits[1]).toMatchObject({ status: 'pending', outcome: null });
    expect(got.steps).toHaveLength(1); expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]).toContain('<data source="fixture.ask" trust="untrusted">');
    expect(P.hs!.typed.filter(e => e.type === 'neos.neop.answer' && e.content.wait_id === t.peerWait)).toHaveLength(1);
    expect(await query(`select 1 from ${s}.proposals where job_id=$1`, [t.job_id])).toEqual([]);
    expect(await query(`select 1 from ${s}.operations where job_id=$1`, [t.job_id])).toEqual([]);
  }

  describe(`${app} atomic cross-NEOP questions`, () => {
    it.each(['step', 'receipt'] as const)('rolls back a failed %s and accepts exact-event redelivery after restart', async point => {
      const t = await start(), ev = event(t), before = await snapshot(t);
      const spy = point === 'step'
        ? vi.spyOn(P.backend.core.book, 'addStep').mockRejectedValueOnce(new Error('synthetic question evidence failure'))
        : vi.spyOn(P.backend.presence!.inbound, 'setIn').mockRejectedValueOnce(new Error('synthetic question receipt failure'));
      const first = await P.hs!.pushTyped(ev); spy.mockRestore();
      const after = await snapshot(t), receipts = await query(`select outcome from ${s}.inbound_events where event_id=$1`, [ev.event_id]);
      expect({ http: first.status, state: after, receipts }).toEqual({ http: 503, state: before, receipts: [] });
      await P.restartBackend(app); await stop();
      expect((await P.hs!.pushTyped(ev)).status).toBe(200);
      const accepted = await snapshot(t);
      expect((await P.hs!.pushTyped(ev)).status).toBe(200); expect(await snapshot(t)).toEqual(accepted);
      await answered(t);
    });

    it('serializes simultaneous deliveries of the same question under different event IDs', async () => {
      const t = await start(), c = await admin.connect(); let sends: Promise<unknown>[] = [];
      try {
        await c.query('begin'); await c.query(`select 1 from ${s}.bus_threads where id=$1 for update`, [t.thread]);
        sends = [P.hs!.pushTyped(event(t)), P.hs!.pushTyped(event(t))];
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database()
          and usename=any($1::text[]) and wait_event_type='Lock'`, [[`${app}_app`, `${app}_runner`]])).length >= 2, 'two blocked question receivers');
        await c.query('commit'); await Promise.all(sends);
      } finally { await c.query('rollback'); c.release(); await Promise.allSettled(sends); }
      const got = await snapshot(t); expect(got.waits).toHaveLength(1); expect(got.steps).toHaveLength(1);
      await answered(t);
    });

    it('does not reopen an answered question when the peer resends its wait ID in a new event', async () => {
      const t = await start(); expect((await P.hs!.pushTyped(event(t))).status).toBe(200); await answered(t);
      const before = await snapshot(t), again = event(t); again.content.question.text = 'Conflicting reuse must not overwrite the recorded question';
      expect((await P.hs!.pushTyped(again)).status).toBe(200); expect(await snapshot(t)).toEqual(before);
    });

    it('does not attach a question or wake a cancelled job', async () => {
      const t = await start(); expect((await P.api('POST', `/api/tasks/${t.task_id}/cancel`, { reason: 'Synthetic question cancellation' })).status).toBe(200);
      const before = await snapshot(t); expect((await P.hs!.pushTyped(event(t))).status).toBe(200);
      expect(await snapshot(t)).toEqual(before); expect(t.wakes).toEqual([]);
    });

    it('rechecks cancellation after the question waits on the job lock', async () => {
      const t = await start(), c = await admin.connect();
      let cancel: ReturnType<Pilot['api']> | undefined, delivery: ReturnType<NonNullable<Pilot['hs']>['pushTyped']> | undefined;
      try {
        await c.query('begin'); await c.query(`select 1 from ${s}.jobs where id=$1 for update`, [t.job_id]);
        const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
        cancel = P.api('POST', `/api/tasks/${t.task_id}/cancel`, { reason: 'Cancellation owns the next job lock' });
        await P.waitFor(async () => (await query('select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))', [pid])).length === 1, 'cancellation queued on job');
        delivery = P.hs!.pushTyped(event(t));
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database() and usename=$1 and wait_event_type='Lock'`, [`${app}_runner`])).length === 1, 'question queued behind cancellation');
        await c.query('commit');
        expect((await cancel).status).toBe(200); expect((await delivery).status).toBe(200);
      } finally { await c.query('rollback'); c.release(); await Promise.allSettled([cancel, delivery]); }
      const got = await snapshot(t);
      expect(got.thread).toEqual({ status: 'open', question: null, result: null }); expect(got.steps).toEqual([]);
      expect(got.waits).toEqual([{ status: 'consumed', outcome: 'CANCELLED', answer: null }]);
      expect((await P.jobRow(t.job_id)).status).toBe('CANCELLED'); expect(t.wakes).toEqual([]);
    });

    it('rejects malformed, missing-root, wrong-peer and wrong-company questions without poisoning a valid one', async () => {
      const t = await start(), before = await snapshot(t);
      const wrongRoot = event(t); wrongRoot.content['m.relates_to'].event_id = '$wrong-root';
      const noRoot = event(t); (noRoot as { content: unknown }).content = { ...noRoot.content, 'm.relates_to': undefined };
      const malformed = event(t); (malformed as { content: unknown }).content = { question: 'invalid' };
      for (const ev of [wrongRoot, noRoot, malformed, { ...event(t), sender: '@unknown:acme.example' }, { ...event(t), room_id: otherRoom }]) {
        expect((await P.hs!.pushTyped(ev)).status).toBe(200); expect(await snapshot(t)).toEqual(before);
      }
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200); await answered(t);
    });

    it('does not acknowledge a duplicate question while its first transaction later rolls back', async () => {
      const t = await start(), ev = event(t);
      let release!: () => void, entered = false;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const spy = vi.spyOn(P.backend.core.book, 'addStep').mockImplementationOnce(async () => {
        entered = true; await blocked; throw new Error('synthetic overlapping question rollback');
      });
      let first: ReturnType<NonNullable<Pilot['hs']>['pushTyped']> | undefined, second: typeof first;
      try {
        first = P.hs!.pushTyped(ev);
        await P.waitFor(async () => entered, 'first question reached rollback boundary');
        second = P.hs!.pushTyped(ev);
        await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database()
          and usename=$1 and wait_event_type='Lock' and query like '%inbound_events%'`, [`${app}_runner`])).length === 1,
        'duplicate waits for the uncommitted question receipt');
        release(); expect((await first).status).toBe(503); expect((await second).status).toBe(200);
      } finally { release(); await Promise.allSettled([first, second]); spy.mockRestore(); }
      expect(await query(`select outcome from ${s}.inbound_events where event_id=$1`, [ev.event_id]))
        .toEqual([{ outcome: 'typed:bus:question' }]);
      await answered(t);
    });

    it('polls a committed question after losing its exact LISTEN connection', async () => {
      const t = await start(); await P.restartBackend(app);
      const listeners = await query('select pid from pg_stat_activity where datname=current_database() and usename=$1 and query=$2',
        [`${app}_runner`, `listen neop_${app}`]);
      expect(listeners).toHaveLength(1);
      expect((await query('select pg_terminate_backend($1) as stopped', [listeners[0].pid]))[0].stopped).toBe(true);
      await P.waitFor(async () => (await query('select 1 from pg_stat_activity where pid=$1', [listeners[0].pid])).length === 0, 'fixture question listener gone');
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200);
      await answered(t, false); // No restart, manual kick, claim or tick after the question.
    });

    it('accepts a distinct subsequent question but never replaces it with an earlier answered wait ID', async () => {
      const t = await start(); expect((await P.hs!.pushTyped(event(t))).status).toBe(200); await answered(t);
      const next = event(t); next.content.wait_id = randomUUID(); next.content.question.text = 'Next distinct synthetic question';
      expect((await P.hs!.pushTyped(next)).status).toBe(200);
      const before = await snapshot(t);
      expect(before.thread.question.wait_id).toBe(next.content.wait_id); expect(before.steps).toHaveLength(2);
      expect(before.waits[1]).toMatchObject({ status: 'ready', outcome: 'NEEDS_INPUT', answer: { question_wait_id: next.content.wait_id } });
      expect((await P.hs!.pushTyped(event(t))).status).toBe(200); expect(await snapshot(t)).toEqual(before);
      await P.restartBackend(app);
      await P.waitFor(async () => (await query(`select 1 from ${s}.bus_threads where id=$1 and question is null`, [t.thread])).length > 0
        && (await P.jobRow(t.job_id)).status === 'WAITING', 'second distinct question answered');
      await stop(); const after = await snapshot(t);
      expect(after.waits.map(w => w.status)).toEqual(['consumed', 'consumed', 'pending']);
      expect(t.wakes).toHaveLength(2);
      expect(P.hs!.typed.filter(e => e.type === 'neos.neop.answer'
        && (e.content.wait_id === t.peerWait || e.content.wait_id === next.content.wait_id))).toHaveLength(2);
    });

    it.each([false, true])('does not attach a question after a terminal result (queued race: %s)', async concurrent => {
      const t = await start(), c = await admin.connect();
      const done = { ...event(t), type: 'neos.neop.done', content: { task_id: t.thread, job_id: 'fixture-peer-job',
        result: { outcome: 'done', summary: 'Synthetic terminal reply', changed: [], sources: [] }, could_not: [],
        'm.relates_to': { rel_type: 'm.thread', event_id: t.root } } };
      let result: ReturnType<NonNullable<Pilot['hs']>['pushTyped']> | undefined, question: typeof result;
      try {
        if (concurrent) {
          await c.query('begin'); await c.query(`select 1 from ${s}.jobs where id=$1 for update`, [t.job_id]);
          const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
          result = P.hs!.pushTyped(done);
          await P.waitFor(async () => (await query('select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))', [pid])).length === 1, 'terminal result queued first');
          question = P.hs!.pushTyped(event(t));
          await P.waitFor(async () => (await query(`select pid from pg_stat_activity where datname=current_database() and usename=$1 and wait_event_type='Lock'`, [`${app}_runner`])).length === 2, 'question queued behind terminal result');
          await c.query('commit');
        } else { result = P.hs!.pushTyped(done); expect((await result).status).toBe(200); question = P.hs!.pushTyped(event(t)); }
        expect((await result).status).toBe(200); expect((await question).status).toBe(200);
      } finally { await c.query('rollback'); c.release(); await Promise.allSettled([result, question]); }
      const got = await snapshot(t);
      expect(got.thread).toMatchObject({ status: 'done', question: null }); expect(got.steps).toEqual([]);
      expect(got.waits).toHaveLength(1); expect(got.waits[0]).toMatchObject({ status: 'ready', outcome: 'COMPLETED' });
      expect(t.wakes).toEqual([]);
    });
  });
}
