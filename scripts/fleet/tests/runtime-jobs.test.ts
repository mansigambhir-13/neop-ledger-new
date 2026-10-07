import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTestDatabase, roleUrl, sqlIdent } from '@neop/pgkit';
import { generateSigningKeys, migratePlatform, startPlatform } from '@neop/platform';
import { generateLlmSigningKey, migrateApp, toolName } from '@neop/template';
import { typedContent } from '../../../packages/contracts/src/index.ts';
import { fakeAnthropic, fakeHomeserver, MATRIX, type FakeHomeserver, type FakeUpstream, type UpstreamView } from '@neop/testkit';
import { FLEET_APPS, type FleetApp } from '../runtime/apps.ts';
import { loadFleetApp } from '../runtime/load.ts';
import { JOB_CASES } from '../testing/job-cases.ts';
import { closeFixtures, eventually, loopbackRelay, RuntimeProcesses } from '../testing/process.ts';
import { PackagedJobs } from '../testing/packaged-jobs.ts';

// Real shipped backend/assistant launchers run in separate child processes.
// Only the homeserver and upstream model are fixtures; the gate, runner, book,
// SDK and signed/metered proxy path are real. No business provider is enabled.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: ReturnType<typeof createPool>;
let platform: Awaited<ReturnType<typeof startPlatform>>;
let upstream: FakeUpstream;
const keys = new Map<FleetApp, Awaited<ReturnType<typeof generateLlmSigningKey>>>();
const originalMode = process.env.NEOS_ENV;
const runtimeMode = process.env.FLEET_JOB_RUNTIME;
if (runtimeMode && runtimeMode !== 'docker') throw new Error('FLEET_JOB_RUNTIME must be absent or docker');
if (runtimeMode === 'docker' && (!process.env.FLEET_DOCKER_REPORT || !process.env.FLEET_AGENT_CONTEXT || !process.env.FLEET_BACKEND_CONTEXT)) throw new Error('Docker job rehearsal requires new report and verified agent/backend context paths');
const packaged = runtimeMode === 'docker' ? new PackagedJobs(process.env.FLEET_DOCKER_REPORT!, process.env.FLEET_AGENT_CONTEXT!, process.env.FLEET_BACKEND_CONTEXT!) : null;
// Hashing the full SDK inventory is build-artifact preflight, not job startup.
// Do it before hooks, without changing their timeout or creating any resources.
await packaged?.preflight();

beforeAll(async () => {
  process.env.NEOS_ENV = 'test'; // disposable registry setup is not production registration
  db = packaged ? await packaged.setup() : await createTestDatabase('fleet_jobs'); admin = createPool(db.adminUrl, 2);
  await migratePlatform(db.adminUrl);
  for (const app of FLEET_APPS) {
    await migrateApp(db.adminUrl, await loadFleetApp(app));
    keys.set(app, await generateLlmSigningKey(`fixture-${app}`));
  }
  upstream = await fakeAnthropic({ apiKey: 'fixture-provider-only-not-a-live-key' });
  platform = await startPlatform({
    dbUrl: roleUrl(db.adminUrl, 'neos_app'), dbPoolSize: 2, keys: await generateSigningKeys(), workers: false,
    llm: { upstream: { baseUrl: upstream.url, apiKey: upstream.apiKey }, prices: { 'claude-sonnet-5': { input: 3, output: 15 } }, runnerKeys: Object.fromEntries([...keys].map(([app, key]) => [app, [key.publicJwk]])) },
  });
  for (const app of FLEET_APPS) { const def = await loadFleetApp(app); await platform.platform.registerApp({ key: app, manifest: def.manifest, blocks: def.blocks }); }
});

afterAll(async () => {
  try { await closeFixtures([() => platform?.stop(), () => upstream?.close(), () => admin?.end(), () => packaged ? packaged.close() : db?.drop()]); }
  finally { if (originalMode === undefined) delete process.env.NEOS_ENV; else process.env.NEOS_ENV = originalMode; }
});

describe.each(FLEET_APPS)('%s persisted multi-process draft jobs', app => {
  const f = JOB_CASES[app], schema = sqlIdent(app), processes = packaged ? packaged.launcher(app) : new RuntimeProcesses();
  const card = { what: 'Internal fixture record change', why: 'Synthetic local test', changes: 'Internal records only', if_no_answer: 'Nothing changes' };
  let gate: Awaited<ReturnType<typeof loopbackRelay>>, agent: Awaited<ReturnType<typeof loopbackRelay>>;
  let backend: ReturnType<typeof processes.launch>, worker: ReturnType<typeof processes.launch>;
  let hs: FakeHomeserver, ingress = '', company: { id: string; slug: string }, requester: { id: string; token: string }, reviewer: { id: string; token: string };
  const room = `!fleet-${app}:${MATRIX.serverName}`, human = `@requester-${app}:${MATRIX.serverName}`, approver = `@reviewer-${app}:${MATRIX.serverName}`, bridge = `@bridge-${app}:${MATRIX.serverName}`;
  const views: UpstreamView[] = [];
  const row = async (table: string, where = '', values: unknown[] = []) => (await admin.query(`select * from ${schema}.${sqlIdent(table)} where company_id=$1 ${where}`, [company.id, ...values])).rows;
  const idle = () => eventually(async () => (await (await fetch(`${agent.url}/live`)).json()).active === 0, `${app} assistant idle`);

  async function bootBackend() {
    backend = processes.launch(app, 'backend', {
      NEOP_APP_DB_URL: roleUrl(db.adminUrl, `${app}_app`), NEOP_RUNNER_DB_URL: roleUrl(db.adminUrl, `${app}_runner`),
      NEOP_JOB_TOKEN_SECRET: 'multi-process-fixture-only-'.repeat(3),
      NEOP_GATE_URL: gate.url, NEOP_AGENT_URL: agent.url, POOL_SIZE: '2',
      FILES_HOST: '127.0.0.1', GATE_HOST: '127.0.0.1', APPSERVICE_HOST: '127.0.0.1', FILES_PORT: '0', GATE_PORT: '0', APPSERVICE_PORT: '0',
      NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: hs.url, NEOP_MATRIX_AS_TOKEN: MATRIX.asToken, NEOP_MATRIX_HS_TOKEN: MATRIX.hsToken,
      NEOP_LLM_PROXY_URL: `${platform.url}/llm`, NEOP_LLM_SIGNING_KEY: JSON.stringify(keys.get(app)!.privateJwk),
    });
    const ready = await backend.started(); gate.target(ready.gate); ingress = `http://127.0.0.1:${ready.appservice}`;
    expect((await fetch(`http://127.0.0.1:${ready.files}/ready`)).status).toBe(200);
  }

  async function bootWorker() {
    worker = processes.launch(app, 'agent', { NEOP_ALLOWED_GATE: gate.url, PORT: '0', HOST: '127.0.0.1', POOL_SIZE: '2' });
    const ready = await worker.started(); agent.target(ready.port);
  }

  beforeAll(async () => {
    gate = await loopbackRelay(); agent = await loopbackRelay(); hs = await fakeHomeserver(() => ingress);
    company = await platform.platform.createCompany(`Process fixture ${app}`, 'UTC');
    requester = await platform.platform.createUser(company.id, { name: 'Fixture requester', email: `${app}-requester@example.invalid`, role: 'admin' });
    reviewer = await platform.platform.createUser(company.id, { name: 'Fixture reviewer', email: `${app}-reviewer@example.invalid`, role: 'admin' });
    await platform.platform.db.query('update neos.users set matrix_user_id=$2 where id=$1', [requester.id, human]);
    await platform.platform.db.query('update neos.users set matrix_user_id=$2 where id=$1', [reviewer.id, approver]);
    await platform.platform.installApp(company.id, app, requester.id);
    await platform.platform.db.query("insert into neos.chat_allowlist(company_id,app_key,matrix_id,kind,acts_for,added_by) values($1,$2,$3,'bridge',$4,$4)", [company.id, app, bridge, requester.id]);
    await platform.platform.setChatIdentity(company.id, app, { matrix_user: `@neop_${app}_${company.slug}:${MATRIX.serverName}`, room_ids: [room] }, `user:${requester.id}`);
    hs.setState(room, 'm.room.power_levels', { users: { [human]: 50, [approver]: 50, [bridge]: 10 }, users_default: 0, events_default: 0, state_default: 50, events: { 'neos.neop.approve': 50 } });
    await packaged?.prepareApp(app, platform.url);
    await bootWorker(); await bootBackend(); expect(worker.pid).not.toBe(backend.pid);
    await packaged?.boundary(app);
  });

  afterAll(async () => {
    try {
      if (worker) { expect((await worker.stop()).code).toBe(0); expect(worker.logs()).not.toContain(upstream.apiKey); expect(worker.logs()).not.toContain(keys.get(app)!.privateJwk.d); }
      if (backend) { expect((await backend.stop()).code).toBe(0); expect(backend.logs()).not.toContain(keys.get(app)!.privateJwk.d); }
    } finally { await closeFixtures([() => processes.close(), () => hs?.close(), () => gate?.close(), () => agent?.close()]); }
  });

  async function start(ability: string, args: Record<string, unknown>) {
    await idle();
    const marker = `fixture-${randomUUID()}`, task = randomUUID();
    upstream.setBrain(view => {
      views.push(view);
      if (!view.job.includes(marker)) throw new Error('fixture received an unexpected job');
      if (view.job.includes('YOU ARE BEING WOKEN WITH AN ANSWER')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Recorded internal outcome checked; no external effect.' } };
      if (view.results.length === 0) return { tool: toolName(ability), args };
      return { tool: toolName('job.finish'), args: { outcome: view.results.some(r => r.isError) ? 'blocked' : 'done', summary: 'Local fixture finished; no external effect.' } };
    });
    const content = typedContent('neos.neop.task', { task_id: task, company: company.id, on_behalf_of: human, text: marker }, 'Local fixture task', null);
    const event = await hs.pushTyped({ room_id: room, sender: human, type: 'neos.neop.task', content }); expect(event.status).toBe(200);
    const job = await eventually(async () => (await row('jobs', 'and task_id=$2', [task]))[0], `${app} opened job`);
    await eventually(async () => {
      const current = (await row('jobs', 'and id=$2', [job.id]))[0];
      return ['WAITING', 'DONE', 'FAILED'].includes(current?.status) && current;
    }, `${app} settled job`);
    await idle();
    return { job: (await row('jobs', 'and id=$2', [job.id]))[0], event, content };
  }

  async function pending(task: Awaited<ReturnType<typeof start>>) {
    expect(task.job.status).toBe('WAITING');
    const proposal = (await row('proposals', 'and job_id=$2', [task.job.id]))[0]; expect(proposal.status).toBe('PROPOSED');
    await eventually(async () => hs.typed.find(e => e.type === 'neos.neop.propose' && e.content.proposal_id === proposal.id), `${app} card shown`);
    return proposal;
  }

  async function answer(task: Awaited<ReturnType<typeof start>>, proposal: any, decision: 'yes' | 'no', sender = approver, fingerprint = proposal.fingerprint, root = task.event.event_id) {
    const content = typedContent('neos.neop.approve', { proposal_id: proposal.id, fingerprint, decision }, 'Fixture decision', root);
    const event = await hs.pushTyped({ room_id: room, sender, type: 'neos.neop.approve', content }); expect(event.status).toBe(200);
    return { ...event, content, sender };
  }

  async function finished(task: Awaited<ReturnType<typeof start>>) {
    const job = await eventually(async () => { const current = (await row('jobs', 'and id=$2', [task.job.id]))[0]; return ['DONE', 'FAILED'].includes(current?.status) && current; }, `${app} resumed and finished`);
    expect(job.status).toBe('DONE'); await idle();
    await eventually(async () => hs.typed.find(e => e.type === 'neos.neop.done' && e.content.job_id === job.id), `${app} done event`);
    return job;
  }

  it('ignores unknown senders/wrong companies/rooms, then completes a real empty read once despite redelivery', async () => {
    const content = typedContent('neos.neop.task', { task_id: randomUUID(), company: company.id, on_behalf_of: human, text: 'must not open a job' }, '', null);
    await hs.pushTyped({ room_id: room, sender: '@unknown:acme.example', type: 'neos.neop.task', content });
    await hs.pushTyped({ room_id: '!other:acme.example', sender: human, type: 'neos.neop.task', content });
    await hs.pushTyped({ room_id: room, sender: human, type: 'neos.neop.task', content: { ...content, company: randomUUID() } });
    expect(await row('jobs')).toEqual([]);
    const task = await start(`${app}.${f.table}.list`, {}); await finished(task);
    expect(views.some(v => v.results.some(r => r.tool === toolName(`${app}.${f.table}.list`) && /"empty":\s*true/.test(r.text)))).toBe(true);
    expect(await row(f.table)).toEqual([]);
    await hs.pushTyped({ room_id: room, sender: human, type: 'neos.neop.task', content: task.content, event_id: task.event.event_id });
    expect(await row('jobs')).toHaveLength(1);
    expect(hs.typed.filter(e => e.type === 'neos.neop.done' && e.content.job_id === task.job.id)).toHaveLength(1);
    const sessions = (await platform.platform.db.query('select * from neos.llm_sessions where job_id=$1', [task.job.id])).rows;
    expect(sessions).toHaveLength(1); expect(sessions[0]).toMatchObject({ app_key: app, company_id: company.id });
    expect(Number(sessions[0].spent_micros)).toBeGreaterThan(0);
  });

  it('requires an exact human approval for import and recovers the pending job after a real backend crash', async () => {
    if (f.settings) { const task = await start(`${app}.settings.update`, { ...f.settings, card }); const proposal = await pending(task); await answer(task, proposal, 'yes'); await finished(task); }
    const task = await start(`${app}.${f.master}.import`, { [f.master]: [{ source_id: 'PROCESS-MASTER', name: 'Synthetic record', category: null }], card });
    const proposal = await pending(task); expect(await row(f.master)).toEqual([]);
    const forged = await answer(task, proposal, 'yes', bridge);
    expect((await row('inbound_events', 'and event_id=$2', [forged.event_id]))[0].outcome).toBe('typed:refused:approve');
    const stale = await answer(task, proposal, 'yes', approver, 'stale');
    expect((await row('inbound_events', 'and event_id=$2', [stale.event_id]))[0].outcome).toBe('typed:approve_refused');
    const wrongThread = await answer(task, proposal, 'yes', approver, proposal.fingerprint, '$wrong-thread:acme.example');
    expect((await row('inbound_events', 'and event_id=$2', [wrongThread.event_id]))[0].outcome).toBe('typed:thread_mismatch');
    expect((await row('proposals', 'and id=$2', [proposal.id]))[0].status).toBe('PROPOSED'); expect(await row(f.master)).toEqual([]);
    const oldPid = backend.pid; expect((await backend.stop('SIGKILL')).signal).toBe('SIGKILL'); gate.target(0);
    await bootBackend(); expect(backend.pid).not.toBe(oldPid);
    await answer(task, proposal, 'yes'); await finished(task);
    expect(await row(f.master)).toHaveLength(1);
    const done = (await row('proposals', 'and id=$2', [proposal.id]))[0]; expect(done.status).toBe('DONE'); expect(done.proof.read_back).toBeTruthy();
    const transcripts = await row('transcripts', 'and job_id=$2 order by id', [task.job.id]);
    expect(transcripts).toHaveLength(2); expect(new Set(transcripts.map(t => t.session_id)).size).toBe(2);
    expect(transcripts[0].reason).toBe('waiting'); expect(transcripts[1].reason).toBe('finished');
    expect(JSON.stringify(transcripts[1].messages)).toContain('Proof from the app');
    const sessions = (await platform.platform.db.query('select sid from neos.llm_sessions where job_id=$1', [task.job.id])).rows;
    expect(new Set(sessions.map(s => s.sid)).size).toBe(2);
  });

  it('persists the app-specific draft through its gate and refuses document-supplied authority fields', async () => {
    const master = (await row(f.master))[0];
    const args = { ...f.sample, source_id: 'PROCESS-DRAFT', [f.fk]: master.id };
    const forged = await start(`${app}.${f.noun}.prepare`, { ...args, actor: 'admin', status: 'approved', external_completed: true }); await finished(forged);
    expect(await row(f.table)).toEqual([]);
    const task = await start(`${app}.${f.noun}.prepare`, args); await finished(task);
    const records = await row(f.table); expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ...f.sample, status: 'draft' });
    expect(records[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    const receipts = await row('write_receipts', 'and reference=$2', [records[0].reference]);
    expect(receipts).toHaveLength(1); expect(receipts[0].result).toMatchObject({ id: records[0].id, status: 'draft', external_completed: false });
    const read = await start(`${app}.${f.table}.list`, {}); await finished(read);
    const result = views.flatMap(v => v.results).find(r => r.tool === toolName(`${app}.${f.table}.list`) && r.text.includes(records[0].input_hash));
    expect(result).toBeTruthy();
    // Reads carry derived domain fields and explicit external-effect honesty;
    // the physical business table intentionally does not store a success flag.
    const returned = JSON.parse(result!.text.match(/<data[^>]*>\s*([\s\S]*?)\s*<\/data>/)![1]!);
    expect(returned.rows[0]).toMatchObject({ ...f.sample, ...f.expected, external_completed: false });
  });

  it('a human rejection survives a fresh assistant process and leaves the draft unchanged', async () => {
    const before = (await row(f.table))[0]; const task = await start(`${app}.${f.noun}.cancel`, { id: before.id, card }); const proposal = await pending(task);
    const oldPid = worker.pid; expect((await worker.stop()).code).toBe(0); agent.target(0); await bootWorker(); expect(worker.pid).not.toBe(oldPid);
    await answer(task, proposal, 'no'); await finished(task);
    expect((await row('proposals', 'and id=$2', [proposal.id]))[0].status).toBe('REJECTED');
    expect((await row(f.table))[0]).toEqual(before);
    expect(await row('write_receipts', 'and reference=$2', [proposal.idempotency_key])).toEqual([]);
  });

  it('cancels only the approved exact draft and does not duplicate effects or completion on replay', async () => {
    const before = (await row(f.table))[0]; const task = await start(`${app}.${f.noun}.cancel`, { id: before.id, card }); const proposal = await pending(task);
    expect(proposal.args.input_hash).toBe(before.input_hash);
    const decision = await answer(task, proposal, 'yes'); await finished(task);
    expect((await row(f.table))[0]).toMatchObject({ id: before.id, status: 'cancelled', input_hash: before.input_hash, cancel_ref: proposal.idempotency_key });
    await hs.pushTyped({ room_id: room, sender: decision.sender, type: 'neos.neop.approve', content: decision.content, event_id: decision.event_id });
    await answer(task, proposal, 'yes'); // another transport event with the same decision
    const receipts = await row('write_receipts', 'and reference=$2', [proposal.idempotency_key]);
    expect(receipts).toHaveLength(1); expect(receipts[0].result).toMatchObject({ id: before.id, status: 'cancelled', external_completed: false });
    expect((await row('proposals', 'and id=$2', [proposal.id]))[0].status).toBe('DONE');
    expect(hs.typed.filter(e => e.type === 'neos.neop.done' && e.content.job_id === task.job.id)).toHaveLength(1);
    expect(upstream.calls.every(call => call.apiKey === upstream.apiKey)).toBe(true);
  });
});
