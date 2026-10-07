import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, sqlIdent } from '@neop/pgkit';
import { toolName, type AppDefinition, type ExecCtx, type WriteAbility } from '@neop/template';
import { bootPilot, type Pilot } from './pilot.ts';

/** Real Matrix/Desk -> book -> runner -> app transaction; providers remain absent. */
export function internalAuthority(app: string, definition: () => Promise<AppDefinition>, master?: string) {
  const schema = sqlIdent(app), key = master ? `${app}.${master}.import` : `${app}.settings.update`;
  const argsFor = (n:number):Record<string,any> => master
    ? {[master]:[{source_id:`AUTH-${n}`,name:'Authority fixture',category:null}]}
    : {currency:'INR',review_limit_minor:n};
  let P: Pilot, admin: ReturnType<typeof createPool>, people: any[];
  let count = 0;
  const query = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows;
  const policy = async (p: Record<string, unknown>) => {
    expect((await P.api('PUT', `/api/switchboards/${app}`, { approvals: { [key]: p }, settings: { [key]: 'ask_first' } })).status).toBe(200);
  };
  beforeAll(async () => {
    P = await bootPilot({ apps: [{ def: await definition() }] });
    admin = createPool(P.adminUrl, 2);
    people = await query(`select * from ${schema}.people where company_id=$1`, [P.company.id]);
  });
  afterAll(async () => { try { await admin?.end(); } finally { await P?.close(); } });
  beforeEach(async () => {
    P.backend.runner.approved.pause();
    P.backend.core.hooks.beforeExecuteEffect = undefined;
    await query(`delete from ${schema}.people where company_id=$1`, [P.company.id]);
    for (const person of people) await query(`insert into ${schema}.people select * from jsonb_populate_record(null::${schema}.people,$1::jsonb)`, [JSON.stringify(person)]);
    await policy({});
  });
  afterEach(() => { P.backend.core.hooks.beforeExecuteEffect = undefined; P.backend.runner.approved.resume(); });
  async function start(token?: string) {
    const args = argsFor(++count);
    P.setBrain(v => v.job.includes('WOKEN')
      ? { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Internal outcome read; no external action.' } }
      : v.calls === 0 ? { tool: toolName(key), args: { ...args, card: { what: 'Internal record', why: 'Fixture', changes: 'Internal fixture only', if_no_answer: 'Nothing' } } } : { text: 'waiting' });
    const task = await P.ask('Review internal fixture', token, app);
    const card = await P.waitFor(async () => (await P.desk()).find(c => c.task_id === task.task_id && c.status === 'PENDING'), 'authority card');
    return { ...task, card, args };
  }
  const answer = (t: Awaited<ReturnType<typeof start>>, token?: string) => P.api('POST', `/api/desk/${t.card.id}/answer`, { decision: 'yes', fingerprint_seen: t.card.fingerprint }, token);
  async function finish(t: Awaited<ReturnType<typeof start>>) {
    P.backend.runner.approved.resume();
    const proposal = await P.waitFor(async () => {
      const p = (await query(`select * from ${schema}.proposals where id=$1`, [t.card.proposal_id]))[0];
      return ['DONE','FAILED','UNKNOWN'].includes(p.status) && p;
    }, 'authority effect');
    await P.waitFor(async () => ['COMPLETED','FAILED'].includes((await P.task(t.task_id)).task.status), 'authority resume');
    return proposal;
  }
  async function refused(t: Awaited<ReturnType<typeof start>>, reason: RegExp) {
    const p = await finish(t);
    expect(p.status).toBe('FAILED'); expect(p.proof.error).toMatch(reason);
    expect(await query(`select 1 from ${schema}.write_receipts where reference=$1`, [p.idempotency_key])).toEqual([]);
    if(master)expect(await query(`select 1 from ${schema}.${sqlIdent(master)} where company_id=$1 and source_id=$2`,[P.company.id,t.args[master][0].source_id])).toEqual([]);
    else expect((await query(`select review_limit_minor from ${schema}.settings where company_id=$1`, [P.company.id]))[0]?.review_limit_minor).not.toBe(String(t.args.review_limit_minor));
  }
  describe(`${app} transaction-time human authority`, () => {
    it('records current human identity and policy with the atomic internal receipt', async () => {
      const t = await start(); expect((await answer(t)).status).toBe(200);
      const p = await finish(t); expect(p.status).toBe('DONE');
      expect(p.proof.read_back.authority).toMatchObject({ proposal_id:p.id, approver_role:'admin', policy:{} });
      expect(p.decided_by).toBe(`user:${P.admin.id}`);
      expect(p.proof.read_back.authority).not.toHaveProperty('approved_by');
      expect(p.proof.read_back.authority).not.toHaveProperty('requested_by');
      expect(p.proof.read_back.authority.board_version).toBeTypeOf('number');
    });
    it('enforces configured four-eyes at answer time and accepts a distinct eligible person', async () => {
      await policy({roles:['admin'],four_eyes:true});
      const t = await start(P.member.token);
      expect((await answer(t,P.member.token)).status).not.toBe(200);
      expect((await answer(t)).status).toBe(200);
      const p=await finish(t); expect(p.status).toBe('DONE'); expect(p.decided_by).toBe(`user:${P.admin.id}`);
      const job=(await query(`select requester,on_behalf_of from ${schema}.jobs where id=$1`,[t.job_id]))[0];
      expect(job.on_behalf_of??job.requester).toBe(`user:${P.member.id}`);
    });
    it('rechecks the approver role after the answer and before the write', async () => {
      await policy({roles:['admin']}); const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      await query(`update ${schema}.people set role='member' where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);
      await refused(t,/authority_role/);
    });
    it('refuses an approver whose identity link was removed after answering', async () => {
      const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      await query(`delete from ${schema}.people where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);
      await refused(t,/authority_identity/);
    });
    it('refuses a requester whose current human role is unknown', async () => {
      const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      await query(`update ${schema}.people set role=null where company_id=$1 and user_id=$2`,[P.company.id,P.member.id]);
      await refused(t,/authority_identity/);
    });
    it('rechecks a tightened role policy after the person already said yes', async () => {
      const t=await start(); expect((await answer(t)).status).toBe(200); await policy({roles:['member']});
      await refused(t,/authority_role/);
    });
    it('refuses self-approval when four-eyes was enabled after the answer', async () => {
      const t=await start(); expect((await answer(t)).status).toBe(200); await policy({four_eyes:true});
      await refused(t,/authority_four_eyes/);
    });
    it('rechecks switch-off even after the runner performed its earlier checks', async () => {
      const t=await start(); expect((await answer(t)).status).toBe(200);
      P.backend.core.hooks.beforeExecuteEffect=async()=>{expect((await P.api('PUT',`/api/switchboards/${app}`,{settings:{[key]:'off'}})).status).toBe(200);};
      await refused(t,/authority_switched_off/);
    });
    it('refuses approval that expires while waiting for the human identity lock', async () => {
      const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      const client=await admin.connect();
      try {
        await client.query('begin');
        const blocker=(await client.query('select pg_backend_pid() pid')).rows[0].pid;
        await client.query(`select 1 from ${schema}.people where company_id=$1 and user_id=$2 for update`,[P.company.id,P.admin.id]);
        P.backend.core.hooks.beforeExecuteEffect=async()=>{
          await query(`update ${schema}.proposals set expires_at=clock_timestamp()+interval '2 seconds' where id=$1`,[t.card.proposal_id]);
        };
        P.backend.runner.approved.resume();
        await P.waitFor(async()=>(await query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[blocker])).length>0,'guard waiting for identity');
        await P.waitFor(async()=>(await query(`select expires_at<=clock_timestamp() expired from ${schema}.proposals where id=$1`,[t.card.proposal_id]))[0].expired,'approval expires while blocked');
        await client.query('rollback');
        await refused(t,/authority_expired/);
      } finally { await client.query('rollback').catch(()=>{});client.release(); }
    });
    it('rejects malformed database policy instead of silently allowing a write', async () => {
      const t=await start(); expect((await answer(t)).status).toBe(200);
      await query(`update ${schema}.switchboard set approvers='{"roles":"admin"}' where company_id=$1 and line=$2`,[P.company.id,key]);
      await refused(t,/authority_policy/);
    });
    it('ignores standing grants for writes that require a person', async () => {
      const g=await P.api('POST','/api/grants',{app_key:app,ability_key:key,limits:{},expires_at:new Date(Date.now()+864e5).toISOString()}); expect(g.status).toBe(200);
      try { const t=await start(); expect((await query(`select status,approved_via from ${schema}.proposals where id=$1`,[t.card.proposal_id]))[0]).toMatchObject({status:'PROPOSED',approved_via:null});
        expect((await answer(t)).status).toBe(200); expect((await finish(t)).status).toBe('DONE');
        expect(await query(`select 1 from ${schema}.grant_uses where grant_id=$1`,[g.body.id])).toEqual([]);
      } finally { await P.api('DELETE',`/api/grants/${g.body.id}`); }
    });
    it('rejects a direct handler call with a forged caller and no approved job', async () => {
      const ctx:ExecCtx={company_id:P.company.id,company_name:'Fixture',caller:`user:${P.admin.id}`,job_id:null,now:new Date(),idempotencyKey:randomUUID(),doors:{} as ExecCtx['doors'],withDb:fn=>P.backend.core.company(P.company.id,fn)};
      await expect((P.backend.core.app.abilities[key] as WriteAbility).execute(argsFor(++count),ctx)).rejects.toThrow(/authority_required/);
      expect(await query(`select 1 from ${schema}.write_receipts where reference=$1`,[ctx.idempotencyKey])).toEqual([]);
    });
    it('requires the handler arguments to equal the content that was approved', async () => {
      const handler=P.backend.core.app.abilities[key] as WriteAbility, original=handler.execute;
      const t=await start(); expect((await answer(t)).status).toBe(200);
      handler.execute=(args,ctx)=>original(master?{...args,[master]:[{...args[master][0],name:'Unapproved mutation'}]}:{...args,currency:'USD'},ctx);
      try { await refused(t,/authority_required/); } finally { handler.execute=original; }
    });
    it('read-back and replay preserve an already committed receipt after revocation', async () => {
      const t=await start(); expect((await answer(t)).status).toBe(200); const p=await finish(t); expect(p.status).toBe('DONE');
      await query(`delete from ${schema}.people where company_id=$1`,[P.company.id]);
      const ctx:ExecCtx={company_id:P.company.id,company_name:'Fixture',caller:'runner:fixture',job_id:t.job_id,now:new Date(),idempotencyKey:p.idempotency_key,doors:{} as ExecCtx['doors'],withDb:fn=>P.backend.core.company(P.company.id,fn)};
      const h=P.backend.core.app.abilities[key] as WriteAbility;
      expect((await h.readBack(t.args,ctx,p.idempotency_key)).data).toEqual(p.proof.read_back);
      expect((await h.execute(t.args,ctx)).detail).toEqual(p.proof.read_back);
      expect(await query(`select count(*)::int n from ${schema}.write_receipts where reference=$1`,[p.idempotency_key])).toEqual([{n:1}]);
    });
    it.each(['identity','policy'])('holds the %s guard until the internal write commits', async kind => {
      const h=P.backend.core.app.abilities[key] as WriteAbility, original=h.execute;
      let inside=false, release!:()=>void;
      const held=new Promise<void>(r=>{release=r;});
      h.execute=(args,ctx)=>original(args,{...ctx,withDb:fn=>ctx.withDb(async db=>{const result=await fn(db);inside=true;await held;return result;})});
      const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      const client=await admin.connect();
      try {
        P.backend.runner.approved.resume();
        await P.waitFor(async()=>inside,'write transaction reached the guard');
        await client.query('begin'); await client.query("set local lock_timeout='150ms'");
        const mutation=kind==='identity'
          ? client.query(`update ${schema}.people set role=null where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id])
          : client.query(`update ${schema}.switchboard set approvers='{"four_eyes":true}' where company_id=$1 and line=$2`,[P.company.id,key]);
        await expect(mutation).rejects.toMatchObject({code:'55P03'});
        await client.query('rollback'); release(); expect((await finish(t)).status).toBe('DONE');
      } finally { release(); await client.query('rollback').catch(()=>{});client.release();h.execute=original; }
    });
    it('binds the stored yes actor, not just an approval-shaped row', async () => {
      const t=await start(P.member.token); expect((await answer(t)).status).toBe(200);
      await query(`update ${schema}.proposal_events set actor=$2 where proposal_id=$1 and event='answered:yes'`,[t.card.proposal_id,`user:${P.member.id}`]);
      await refused(t,/authority_evidence/);
    });
    it('rejects a forged company/job/reference even when the caller claims to be a runner', async () => {
      const ctx:ExecCtx={company_id:randomUUID(),company_name:'Other',caller:'runner:fixture',job_id:randomUUID(),now:new Date(),idempotencyKey:randomUUID(),doors:{} as ExecCtx['doors'],withDb:fn=>P.backend.core.company(P.company.id,fn)};
      await expect((P.backend.core.app.abilities[key] as WriteAbility).execute(argsFor(++count),ctx)).rejects.toThrow(/authority_required/);
    });
  });
}

// Existing finance fixtures keep their settings-specific assertions.
export const financeAuthority=internalAuthority;
