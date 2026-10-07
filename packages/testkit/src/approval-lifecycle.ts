import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {createPool,sqlIdent} from '@neop/pgkit';
import {ApprovedPath,toolName,type AppDefinition} from '@neop/template';
import {bootPilot,type Pilot} from './pilot.ts';

/** Internal imports only; real database/gate/runner with synthetic Matrix/model transports. */
export function approvalLifecycle(app:string,definition:()=>Promise<AppDefinition>,master:string){
 const s=sqlIdent(app),table=sqlIdent(master),key=`${app}.${master}.import`;
 let P:Pilot,admin:ReturnType<typeof createPool>,stopped=false;
 const query=async(sql:string,values:unknown[]=[]) => (await admin.query(sql,values)).rows;
 beforeAll(async()=>{P=await bootPilot({apps:[{def:await definition()}]});admin=createPool(P.adminUrl,3);});
 afterEach(async()=>{P.backend.core.hooks.beforeExecuteEffect=undefined;if(stopped){await P.restartBackend(app);stopped=false;}P.backend.runner.approved.resume();});
 afterAll(async()=>{try{await admin?.end();}finally{await P?.close();}});
 async function stop(){await P.backend.runner.stop();stopped=true;}
 async function restart(){await P.restartBackend(app);stopped=false;}
 async function start(edit=false){
  const source_id=`LIFE-${randomUUID()}`,args={[master]:[{source_id,name:'Original fixture',category:null}]},wakes:string[]=[];
  let revised=false;
  P.setBrain(v=>{
   if(v.job.includes('WOKEN')&&v.calls===0){
    wakes.push(v.job);
    if(edit&&!revised&&v.job.includes('SUPERSEDED')){revised=true;return{tool:toolName(key),args:{[master]:[{source_id,name:'Revised fixture',category:null}],card:{what:'Revised internal import',why:'Human feedback',changes:'Name only',if_no_answer:'Nothing'}}};}
    return{tool:toolName('job.finish'),args:{outcome:'done',summary:'Recorded internal outcome; no external action.'}};
   }
   return v.calls===0?{tool:toolName(key),args:{...args,card:{what:'Internal import',why:'Synthetic fixture',changes:'Internal record only',if_no_answer:'Nothing'}}}:{text:'waiting'};
  });
  const task=await P.ask('Review lifecycle fixture',undefined,app);
  const card=await P.waitFor(async()=>(await P.desk()).find(c=>c.task_id===task.task_id&&c.status==='PENDING'),'lifecycle card');
  await P.waitFor(async()=>(await P.jobRow(task.job_id)).status==='WAITING','job parked');
  return{...task,card,args,source_id,wakes};
 }
 type Task=Awaited<ReturnType<typeof start>>;
 const answer=(card:any,decision:string,feedback?:string)=>P.api('POST',`/api/desk/${card.id}/answer`,{decision,fingerprint_seen:card.fingerprint,...feedback?{feedback}:{}});
 const proposal=async(t:Task)=>(await query(`select * from ${s}.proposals where id=$1`,[t.card.proposal_id]))[0];
 const records=(t:Task)=>query(`select * from ${s}.${table} where company_id=$1 and source_id=$2`,[P.company.id,t.source_id]);
 async function done(t:Task){await P.waitFor(async()=>['COMPLETED','FAILED'].includes((await P.task(t.task_id)).task.status),'lifecycle resumed');}
 async function noEffect(t:Task){
  expect(await records(t)).toEqual([]);const p=await proposal(t);
  expect(await query(`select 1 from ${s}.write_receipts where reference=$1`,[p.idempotency_key])).toEqual([]);
  expect(await query(`select 1 from ${s}.operations where company_id=$1 and idempotency_key=$2`,[P.company.id,p.idempotency_key])).toEqual([]);
 }
 describe(`${app} approval waiting lifecycle`,()=>{
  it('change supersedes immutable content and requires a fresh human yes for the revised card',async()=>{
   const t=await start(true),before=await proposal(t);
   expect((await answer(t.card,'change','Use the revised fixture name')).status).toBe(200);
   const next=await P.waitFor(async()=>(await P.desk()).find(c=>c.task_id===t.task_id&&c.status==='PENDING'&&c.id!==t.card.id),'fresh revised card');
   expect(next.fingerprint).not.toBe(t.card.fingerprint);expect(next.args[master][0].name).toBe('Revised fixture');
   const old=await proposal(t);expect(old).toMatchObject({status:'SUPERSEDED',args:before.args,fingerprint:before.fingerprint,feedback:'Use the revised fixture name',superseded_by:next.proposal_id});
   await noEffect(t);expect((await answer(t.card,'yes')).status).toBe(409);
   expect((await P.api('POST',`/api/desk/${next.id}/answer`,{decision:'yes',fingerprint_seen:t.card.fingerprint})).status).not.toBe(200);
   expect(await records(t)).toEqual([]);expect((await answer(next,'yes')).status).toBe(200);await done(t);
   expect(await records(t)).toHaveLength(1);expect((await records(t))[0].name).toBe('Revised fixture');
   expect(t.wakes).toHaveLength(2);expect(t.wakes[0]).toContain('Use the revised fixture name');
   expect((await query(`select count(*)::int n from ${s}.write_receipts where company_id=$1`,[P.company.id]))[0].n).toBe(1);
  });
  it.each(['pending','approved'])('withdraws a %s proposal without performing the internal effect',async state=>{
   const t=await start();P.backend.runner.approved.pause();
   if(state==='approved'){
    expect((await answer(t.card,'yes')).status).toBe(200);
    await query(`update ${s}.proposals set expires_at=clock_timestamp()-interval '1 second' where id=$1`,[t.card.proposal_id]);
    // The database replay is idempotent; the existing Desk HTTP contract says the card is closed (409).
    expect((await answer(t.card,'yes')).status).toBe(409);
    expect(await P.platform.boards.answer(app,P.company.id,{proposal_id:t.card.proposal_id,fingerprint_seen:t.card.fingerprint,decision:'yes',by:`user:${P.admin.id}`,roles:['admin']})).toMatchObject({status:'APPROVED',idempotent:true});
    expect((await query(`select count(*)::int n from ${s}.proposal_events where proposal_id=$1 and event='answered:yes'`,[t.card.proposal_id]))[0].n).toBe(1);
   }
   expect((await answer(t.card,'withdraw')).status).toBe(200);P.backend.runner.approved.resume();await done(t);
   expect((await proposal(t)).status).toBe('WITHDRAWN');await noEffect(t);expect(t.wakes).toHaveLength(1);expect(t.wakes[0]).toContain('WITHDRAWN');
   expect((await answer(t.card,'yes')).status).toBe(409);
  });
  it('refuses withdrawal once execution has started and retains exactly one receipt',async()=>{
   const t=await start();let release!:()=>void,inside=false;const held=new Promise<void>(r=>{release=r;});
   P.backend.core.hooks.beforeExecuteEffect=async()=>{inside=true;await held;};
   try{
    expect((await answer(t.card,'yes')).status).toBe(200);await P.waitFor(async()=>inside,'effect started');
    expect((await proposal(t)).status).toBe('EXECUTING');expect((await answer(t.card,'withdraw')).status).toBe(409);
   }finally{release();P.backend.core.hooks.beforeExecuteEffect=undefined;}
   await done(t);expect((await proposal(t)).status).toBe('DONE');expect(await records(t)).toHaveLength(1);
   expect((await query(`select count(*)::int n from ${s}.write_receipts where reference=$1`,[(await proposal(t)).idempotency_key]))[0].n).toBe(1);
  });
  it('expires an unanswered proposal after runner downtime and wakes once without an effect',async()=>{
   const t=await start();await stop();
   await query(`update ${s}.proposals set expires_at=clock_timestamp()-interval '1 second' where id=$1`,[t.card.proposal_id]);
   expect((await answer(t.card,'yes')).status).toBe(409);expect((await proposal(t)).status).toBe('PROPOSED');
   await restart();await done(t);expect((await proposal(t)).status).toBe('EXPIRED');await noEffect(t);
   expect(t.wakes).toHaveLength(1);expect(t.wakes[0]).toContain('EXPIRED');
   await Promise.all([P.backend.runner.expire(),P.backend.runner.expire()]);
   expect((await query(`select count(*)::int n from ${s}.proposal_events where proposal_id=$1 and event='expired'`,[t.card.proposal_id]))[0].n).toBe(1);
  });
  it('serializes withdrawal against two competing executors with one consistent result',async()=>{
   const t=await start();P.backend.runner.approved.pause();expect((await answer(t.card,'yes')).status).toBe(200);
   const [withdrawn]=await Promise.all([answer(t.card,'withdraw'),new ApprovedPath(P.backend.core).tick({wait:true}),new ApprovedPath(P.backend.core).tick({wait:true})]);
   P.backend.runner.approved.resume();await done(t);const p=await proposal(t);expect(['DONE','WITHDRAWN']).toContain(p.status);
   if(p.status==='WITHDRAWN'){expect(withdrawn.status).toBe(200);await noEffect(t);}else{expect(withdrawn.status).toBe(409);expect(await records(t)).toHaveLength(1);}
   expect((await query(`select count(*)::int n from ${s}.write_receipts where reference=$1`,[p.idempotency_key]))[0].n).toBe(p.status==='DONE'?1:0);
   expect(t.wakes).toHaveLength(1);
  });
  it.each(['yes','no','change'].flatMap(decision=>['proposal','job'].map(lock=>({decision,lock}))))('refuses $decision after expiry while blocked on the $lock lock, rolling back answer evidence',async({decision,lock})=>{
   const t=await start();await stop();
   await query(`update ${s}.proposals set expires_at=clock_timestamp()+interval '2 seconds' where id=$1`,[t.card.proposal_id]);
   const c=await admin.connect();let pending:ReturnType<typeof answer>|undefined;
   try{
    await c.query('begin');const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;
    await c.query(`select 1 from ${s}.${lock==='proposal'?'proposals':'jobs'} where id=$1 for update`,[lock==='proposal'?t.card.proposal_id:t.job_id]);
    pending=answer(t.card,decision,decision==='change'?'Revise safely':undefined);
    await P.waitFor(async()=>(await query("select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid)) and query like '%answer_proposal%'",[pid])).length>0,'answer waiting on lock');
    await P.waitFor(async()=>(await query(`select expires_at<=clock_timestamp() expired from ${s}.proposals where id=$1`,[t.card.proposal_id]))[0].expired,'deadline reached');
    await c.query('rollback');const response=await pending;expect(response.status).toBe(409);expect(JSON.stringify(response.body)).toMatch(/expired/i);
    expect((await proposal(t)).status).toBe('PROPOSED');
    expect(await query(`select 1 from ${s}.proposal_events where proposal_id=$1 and event like 'answered:%'`,[t.card.proposal_id])).toEqual([]);
    expect(await query(`select 1 from ${s}.outbox where dedupe_key like $1`,[`resolved:${t.card.proposal_id}:%`])).toEqual([]);
    expect(await query(`select 1 from ${s}.steps where job_id=$1 and summary like 'Answer on proposal %'`,[t.job_id])).toEqual([]);
    expect((await query(`select status from ${s}.waits where ref_id=$1`,[t.card.proposal_id]))[0].status).toBe('pending');await noEffect(t);
   }finally{await c.query('rollback').catch(()=>{});c.release();await pending?.catch(()=>{});await restart();}
   await done(t);expect((await proposal(t)).status).toBe('EXPIRED');expect(t.wakes).toHaveLength(1);
  });
 });
}
