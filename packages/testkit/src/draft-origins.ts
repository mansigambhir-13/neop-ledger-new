import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, sqlIdent } from '@neop/pgkit';
import { toolName, type AppDefinition, type ExecCtx, type WriteAbility } from '@neop/template';
import { bootPilot, type Pilot } from './pilot.ts';

interface Fixture { app:()=>Promise<AppDefinition>; id:string; master:string; table:string; noun:string; fk:string; sample:Record<string,unknown>; settings?:Record<string,unknown>|null }
export function draftOrigins(f:Fixture) {
 const s=sqlIdent(f.id), key=`${f.id}.${f.noun}.prepare`;
 let P:Pilot, admin:ReturnType<typeof createPool>, party:string, people:any[], represented:any[];
 const query=async(sql:string,values:unknown[]=[]) => (await admin.query(sql,values)).rows;
 async function run(suffix:string,args:Record<string,unknown>,token?:string) {
  P.setBrain(v=>v.job.includes('WOKEN')||v.calls>0
   ? {tool:toolName('job.finish'),args:{outcome:'done',summary:'Internal fixture result only.'}}
   : {tool:toolName(`${f.id}.${suffix}`),args:{...args,...suffix.endsWith('.prepare')?{}:{card:{what:'Fixture',why:'Test',changes:'Internal only',if_no_answer:'Nothing'}}}});
  const task=await P.ask('Origin fixture',token,f.id);
  const state=await P.waitFor(async()=>{
   const card=(await P.desk()).find(c=>c.task_id===task.task_id&&c.status==='PENDING');
   if(card)return {card}; return ['COMPLETED','FAILED'].includes((await P.task(task.task_id)).task.status)?{card:null}:null;
  },'origin task');
  if(state.card){expect((await P.api('POST',`/api/desk/${state.card.id}/answer`,{decision:'yes',fingerprint_seen:state.card.fingerprint})).status).toBe(200);
   await P.waitFor(async()=>['COMPLETED','FAILED'].includes((await P.task(task.task_id)).task.status),'origin resumed');}
  return task;
 }
 async function prepare(o:{token?:string;extra?:Record<string,unknown>;before?:(ctx:ExecCtx)=>Promise<void>;context?:(ctx:ExecCtx)=>ExecCtx}={}) {
  const args={...f.sample,source_id:`ORIGIN-${randomUUID()}`,[f.fk]:party,...o.extra};
  const h=P.backend.core.app.abilities[key] as WriteAbility, original=h.execute;
  let ctx:ExecCtx|undefined, error:string|undefined, result:Awaited<ReturnType<WriteAbility['execute']>>|undefined;
  h.execute=async(a,c)=>{ctx=c;await o.before?.(c);try {return result=await original(a,o.context?.(c)??c);}catch(e){error=(e as Error).message;throw e;}};
  try {
   const task=await run(`${f.noun}.prepare`,args,o.token);
   const row=(await query(`select * from ${s}.${f.table} where company_id=$1 and source_id=$2`,[P.company.id,args.source_id]))[0];
   const origin=row?(await query(`select * from ${s}.draft_origins where draft_id=$1`,[row.id]))[0]:undefined;
   return {task,args,ctx,error,result,row,origin};
  } finally {h.execute=original;}
 }
 beforeAll(async()=>{
  P=await bootPilot({apps:[{def:await f.app()}]});admin=createPool(P.adminUrl,3);
  people=await query(`select * from ${s}.people where company_id=$1`,[P.company.id]);
  represented=await query(`select * from ${s}.acted_for where company_id=$1`,[P.company.id]);
  const settings=f.settings===undefined?{currency:'INR',review_limit_minor:10000}:f.settings;
  if(settings)await run('settings.update',settings);
  await run(`${f.master}.import`,{[f.master]:[{source_id:'ORIGIN-PARTY',name:'Fixture party',category:null}]});
  party=(await query(`select id from ${s}.${f.master} where company_id=$1`,[P.company.id]))[0].id;
 });
 beforeEach(async()=>{
  for(const [table,rows]of [['people',people],['acted_for',represented]] as const){
   await query(`delete from ${s}.${table} where company_id=$1`,[P.company.id]);
   for(const row of rows)await query(`insert into ${s}.${table} select * from jsonb_populate_record(null::${s}.${table},$1::jsonb)`,[JSON.stringify(row)]);
  }
 });
 afterAll(async()=>{try{await admin?.end();}finally{await P?.close();}});
 describe(`${f.id} immutable creating-job origin`,()=>{
  it('captures the linked human and exact draft hash through the real job path',async()=>{
   const t=await prepare({token:P.member.token});expect(t.error).toBeUndefined();
   expect(t.origin).toMatchObject({company_id:P.company.id,draft_id:t.row.id,job_id:t.task.job_id,proposer_user_id:P.member.id,basis:'linked_human',input_hash:t.row.input_hash});
   expect(t.origin.recorded_at).toBeInstanceOf(Date);expect(t.result?.detail).not.toHaveProperty('proposer_user_id');
  });
  it('uses the represented-person mirror only when no Matrix link exists',async()=>{
   const t=await prepare({before:async()=>{
    await query(`delete from ${s}.people where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);
    await query(`insert into ${s}.acted_for(company_id,user_id,role) values($1,$2,'admin') on conflict(company_id,user_id) do update set role='admin'`,[P.company.id,P.admin.id]);
   }});expect(t.error).toBeUndefined();expect(t.origin).toMatchObject({proposer_user_id:P.admin.id,basis:'represented_human'});
  });
  it('records synthetic machine-only job metadata without inventing a human',async()=>{
   const t=await prepare({before:async c=>{await query(`update ${s}.jobs set requester='agent:fixture',on_behalf_of=null where id=$1`,[c.job_id]);}});
   expect(t.error).toBeUndefined();expect(t.origin).toMatchObject({job_id:t.task.job_id,proposer_user_id:null,basis:'nonhuman'});
  });
  it.each(['revoked','missing','conflicting','malformed'])('refuses %s identity without a draft or receipt',async kind=>{
   const t=await prepare({before:async c=>{
    if(kind==='revoked')await query(`update ${s}.people set role=null where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);
    if(kind==='missing'){await query(`delete from ${s}.people where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);await query(`delete from ${s}.acted_for where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);}
    if(kind==='conflicting')await query(`insert into ${s}.people(company_id,matrix_id,user_id,role) values($1,'@conflicting:fixture.test',$2,'member')`,[P.company.id,P.admin.id]);
    if(kind==='malformed')await query(`update ${s}.jobs set on_behalf_of='user:not-a-uuid' where id=$1`,[c.job_id]);
   }});expect(t.error).toMatch(/origin_identity/);expect(t.row).toBeUndefined();
   expect(await query(`select 1 from ${s}.write_receipts where reference=$1`,[t.ctx!.idempotencyKey])).toEqual([]);
  });
  it.each(['missing','foreign','inactive'])('refuses a %s creating-job context',async kind=>{
   let job:string|null=null;
   if(kind!=='missing'){job=randomUUID();await query(`insert into ${s}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Negative context fixture',$4)`,[job,kind==='foreign'?randomUUID():P.company.id,`user:${P.admin.id}`,kind==='inactive'?'DONE':'RUNNING']);}
   const t=await prepare({context:c=>({...c,job_id:job,caller:`user:${P.admin.id}`})});expect(t.row).toBeUndefined();expect(t.error).toMatch(/origin_(required|job)/);
  });
  it('does not accept a model-supplied proposer, job reference or origin basis',async()=>{
   const t=await prepare({extra:{proposer_user_id:P.admin.id,origin_job_id:randomUUID(),basis:'linked_human'}});
   expect(t.ctx).toBeUndefined();expect(t.row).toBeUndefined();
  });
  it('does not rewrite the original human when job attribution or identity links later change',async()=>{
   const t=await prepare();await query(`update ${s}.jobs set on_behalf_of=$2 where id=$1`,[t.task.job_id,`user:${P.member.id}`]);
   await query(`delete from ${s}.people where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id]);
   expect((await query(`select * from ${s}.draft_origins where draft_id=$1`,[t.row.id]))[0]).toEqual(t.origin);
   const h=P.backend.core.app.abilities[key] as WriteAbility;
   expect((await h.execute(t.args,{...t.ctx!,job_id:randomUUID(),caller:'forged:caller'})).detail).toEqual(t.result!.detail);
   expect(await query(`select count(*)::int n from ${s}.draft_origins where draft_id=$1`,[t.row.id])).toEqual([{n:1}]);
  });
  it('denies direct app origin insert/update/delete and tenant reads; owner updates remain immutable',async()=>{
   const t=await prepare();
   for(const sql of [`insert into ${s}.draft_origins select * from ${s}.draft_origins`,`update ${s}.draft_origins set proposer_user_id=null`,`delete from ${s}.draft_origins`])await expect(P.backend.core.company(P.company.id,db=>db.query(sql))).rejects.toThrow(/permission denied/);
   await expect(query(`update ${s}.draft_origins set proposer_user_id=$2 where draft_id=$1`,[t.row.id,P.member.id])).rejects.toThrow(/immutable/);
   await expect(query(`delete from ${s}.draft_origins where draft_id=$1`,[t.row.id])).rejects.toThrow(/immutable/);
   expect((await P.backend.core.company(randomUUID(),db=>db.query(`select * from ${s}.draft_origins`))).rows).toEqual([]);
  });
  it('preserves provenance through cancellation rather than replacing it with the canceller',async()=>{
   const t=await prepare({token:P.member.token});await run(`${f.noun}.cancel`,{id:t.row.id});
   expect((await query(`select status from ${s}.${f.table} where id=$1`,[t.row.id]))[0].status).toBe('cancelled');
   expect((await query(`select * from ${s}.draft_origins where draft_id=$1`,[t.row.id]))[0]).toEqual(t.origin);
  });
  it('requires job context even for a raw app-role draft insert and clears transaction-local context',async()=>{
   const t=await prepare(), forged={...t.row,id:randomUUID(),source_id:`RAW-${randomUUID()}`,reference:`raw-${randomUUID()}`};
   await expect(P.backend.core.company(P.company.id,db=>db.query(`insert into ${s}.${f.table} select * from jsonb_populate_record(null::${s}.${f.table},$1::jsonb)`,[JSON.stringify(forged)]))).rejects.toThrow(/origin_required/);
   expect(await query(`select 1 from ${s}.${f.table} where id=$1`,[forged.id])).toEqual([]);
   expect((await P.backend.core.company(P.company.id,db=>db.query("select nullif(current_setting('neos.draft_origin_job',true),'') job"))).rows[0].job).toBeNull();
  });
  it('rolls back draft, origin and receipt together when the transaction fails before commit',async()=>{
   const t=await prepare({context:c=>({...c,withDb:fn=>c.withDb(async db=>{const result=await fn(db);await db.query('select 1/0');return result;})})});
   expect(t.error).toMatch(/division by zero/);expect(t.row).toBeUndefined();
   expect(await query(`select 1 from ${s}.draft_origins where job_id=$1`,[t.task.job_id])).toEqual([]);
   expect(await query(`select 1 from ${s}.write_receipts where reference=$1`,[t.ctx!.idempotencyKey])).toEqual([]);
  });
  it.each(['job','person'])('holds the %s attribution lock through the draft transaction commit',async kind=>{
   const h=P.backend.core.app.abilities[key] as WriteAbility, original=h.execute;
   let inside=false, release!:()=>void, ctx!:ExecCtx;const held=new Promise<void>(r=>{release=r;});
   h.execute=(a,c)=>{ctx=c;return original(a,{...c,withDb:fn=>c.withDb(async db=>{const value=await fn(db);inside=true;await held;return value;})});};
   const args={...f.sample,source_id:`LOCK-${randomUUID()}`,[f.fk]:party};
   const pending=run(`${f.noun}.prepare`,args), client=await admin.connect();
   try{
    await P.waitFor(async()=>inside,'origin transaction reached commit');await client.query('begin');await client.query("set local lock_timeout='150ms'");
    await expect(kind==='job'?client.query(`update ${s}.jobs set on_behalf_of=$2 where id=$1`,[ctx.job_id,`user:${P.member.id}`]):client.query(`update ${s}.people set role=null where company_id=$1 and user_id=$2`,[P.company.id,P.admin.id])).rejects.toMatchObject({code:'55P03'});
    await client.query('rollback');release();await pending;
   }finally{release();await client.query('rollback').catch(()=>{});client.release();h.execute=original;await pending.catch(()=>{});}
  });
  it('declares origin personal-data linkage without pretending erasure is implemented',async()=>{
   const app=await f.app();expect(app.manifest.personal_data).toContainEqual({table:'draft_origins',columns:['draft_id','job_id','input_hash'],subject_key:'proposer_user_id'});
  });
 });
}
