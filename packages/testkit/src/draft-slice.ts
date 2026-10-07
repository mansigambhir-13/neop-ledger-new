import {sqlIdent} from '@neop/pgkit';
// Shared test machinery only. Each app supplies its own domain inputs and real V3 definition.
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {migrateApp,type AppDefinition,type ExecCtx,type WriteAbility} from '@neop/template';
import {bootPilot,type Pilot} from './pilot.ts';
import {toolName} from '@neop/template';
interface Fixture { app:()=>Promise<AppDefinition>; id:string; master:string; table:string; noun:string; fk:string; sample:Record<string,unknown>; data:{importParties:(db:any,company:string,rows:any[])=>Promise<unknown>;cancel:(db:any,company:string,args:any,reference:string)=>Promise<unknown>} }
export function draftSlice(f:Fixture) {
 let P:Pilot;
 const CARD={what:'Internal record change',why:'company team requested review',changes:'draft records only',if_no_answer:'nothing changes'};
 beforeAll(async()=>{P=await bootPilot({apps:[{def:await f.app()}]});});
 afterAll(async()=>{await P?.close();});
 async function read(suffix:string,args={}) {const r=await P.read(f.id+'.'+suffix,args,{app:f.id});expect(r.status,JSON.stringify(r.body)).toBe(200);return r.body.result;}
 async function start(suffix:string,args:any) {
  P.setBrain(v=>{
   if(v.job.includes('WOKEN'))return {tool:toolName('job.finish'),args:{outcome:'done',summary:'Internal receipt verified; external execution is unavailable.'}};
   if(v.calls===0)return {tool:toolName(f.id+'.'+suffix),args:{...args,...suffix.endsWith('.prepare')?{}:{card:CARD}}};
   const result=v.results[0]?.text??'';
   return result.includes('Proposal ')?{text:'waiting'}:{tool:toolName('job.finish'),args:{outcome:'done',summary:result||'No effect'}};
  });
  const task=await P.ask(f.id+' '+suffix,undefined,f.id);
  const state=await P.waitFor(async()=>{
   const card=(await P.desk()).find(c=>c.task_id===task.task_id&&c.status==='PENDING');
   if(card)return {card};const t=await P.task(task.task_id);return ['COMPLETED','FAILED'].includes(t.task.status)?{card:null}:null;
  },suffix);
  return {...task,...state};
 }
 async function approve(t:Awaited<ReturnType<typeof start>>) {
  expect(t.card).toBeTruthy();
  expect((await P.api('POST','/api/desk/'+t.card.id+'/answer',{decision:'yes',fingerprint_seen:t.card.fingerprint})).status).toBe(200);
  await P.waitFor(async()=>['COMPLETED','FAILED'].includes((await P.task(t.task_id)).task.status),'resumed');
  return (await P.backend.core.runnerPool.query('select status,proof from '+f.id+'.proposals where id=$1',[t.card.proposal_id])).rows[0];
 }
 async function run(suffix:string,args:any){const t=await start(suffix,args);if(t.card)expect((await approve(t)).status).toBe('DONE');return t;}
 const context=(key:string):ExecCtx=>({company_id:P.company.id,company_name:'Test',caller:'test:runner',job_id:null,now:new Date(),idempotencyKey:key,doors:{} as ExecCtx['doors'],withDb:fn=>P.backend.core.company(P.company.id,fn)});
 describe(f.id+' V3 internal-draft workflow',()=>{
  it('starts blank and makes no settings change until a fingerprint-bound human answer',async()=>{
   expect((await read('settings.get')).rows).toEqual([]);expect((await read(f.table+'.list')).empty).toBe(true);
   const t=await start('settings.update',{currency:'INR',review_limit_minor:10000});
   expect((await read('settings.get')).empty).toBe(true);expect((await approve(t)).status).toBe('DONE');
   await run(f.master+'.import',{[f.master]:[{source_id:'PARTY-1',name:'Reviewed company',category:null},{source_id:'PARTY-2',name:'Other company',category:'services'}]});
   const rows=(await read(f.master+'.list')).rows;expect(rows).toHaveLength(2);expect(rows.find((r:any)=>r.source_id==='PARTY-1').category).toBeNull();
  });
  it('refuses missing parties and mismatched currencies without creating a draft',async()=>{
   await run(f.noun+'.prepare',{...f.sample,source_id:'BAD-PARTY',[f.fk]:randomUUID()});
   const party=(await read(f.master+'.list')).rows[0];
   await run(f.noun+'.prepare',{...f.sample,source_id:'BAD-CURRENCY',[f.fk]:party.id,currency:'USD'});
   expect((await read(f.table+'.list')).rows).toEqual([]);
  });
  it('persists exact integer money and source evidence; duplicate business requests do not overwrite',async()=>{
   const party=(await read(f.master+'.list')).rows[0];const args={...f.sample,source_id:'REQUEST-1',[f.fk]:party.id};
   await run(f.noun+'.prepare',args);const rows=(await read(f.table+'.list')).rows;
   expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({amount_minor:12345,currency:'INR',status:'draft',external_completed:false,requires_elevated_approval:true,cancelled_at:null});
   expect(rows[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
   await run(f.noun+'.prepare',{...args,amount_minor:999});expect((await read(f.table+'.list')).rows).toEqual(rows);
   const desk=await P.api('POST','/api/apps/'+f.id+'/read/'+f.id+'.'+f.table+'.list',{});expect(desk.status).toBe(200);expect(desk.body.result.rows).toEqual(rows);
  });
  it('replayed and concurrent writes share one atomic receipt, and content collisions fail',async()=>{
   const party=(await read(f.master+'.list')).rows[0];const args={...f.sample,source_id:'CONCURRENT',[f.fk]:party.id};
   const handler=P.backend.core.app.abilities[f.id+'.'+f.noun+'.prepare'] as WriteAbility, original=handler.execute;
   let ctx!:ExecCtx, results!:Awaited<ReturnType<WriteAbility['execute']>>[];
   // Use a real creating job, then race its six identical backend executions.
   handler.execute=async(a,c)=>{ctx=c;results=await Promise.all(Array.from({length:6},()=>original(a,c)));return results[0]!;};
   try {await run(f.noun+'.prepare',args);} finally {handler.execute=original;}
   // jsonb reorders object keys; compare data, not incidental JSON serialization order.
   for(const result of results)expect(result.detail).toEqual(results[0]!.detail);
   const receipts=await P.backend.core.company(P.company.id,db=>db.query('select count(*)::int as n from '+f.id+'.write_receipts where company_id=$1 and reference=$2',[P.company.id,ctx.idempotencyKey]));
   expect(receipts.rows[0].n).toBe(1);
   const origins=await P.backend.core.company(P.company.id,db=>db.query('select job_id,proposer_user_id from '+f.id+'.draft_origins where company_id=$1 and draft_id=$2',[P.company.id,(results[0]!.detail as {id:string}).id]));
   expect(origins.rows).toEqual([{job_id:ctx.job_id,proposer_user_id:P.admin.id}]);
   expect((await handler.readBack(args,ctx,ctx.idempotencyKey)).found).toBe(true);
   expect((await handler.readBack({...args,amount_minor:1},ctx,ctx.idempotencyKey)).found).toBe(false);
   await expect(handler.execute({...args,amount_minor:1},ctx)).rejects.toThrow('content collision');
   expect((await read(f.table+'.list')).rows.filter((r:any)=>r.source_id==='CONCURRENT')).toHaveLength(1);
  });
  it('rejects duplicate import ids and rolls back a malformed database batch atomically',async()=>{
   const before=(await read(f.master+'.list')).rows;
   const duplicate={source_id:'DUP',name:'Dup',category:null};const t=await start(f.master+'.import',{[f.master]:[duplicate,duplicate]});expect(t.card).toBeNull();
   // Repository-level rollback: the production handler now independently requires a recorded human approval.
   await expect(P.backend.core.company(P.company.id,db=>f.data.importParties(db,P.company.id,[{source_id:'ROLLBACK',name:'Transient',category:null},{source_id:'INVALID',name:'',category:null}]))).rejects.toThrow();
   expect((await read(f.master+'.list')).rows).toEqual(before);
  });
  it('rejects stale yes, survives a waiting restart and cancels exactly once',async()=>{
   const row=(await read(f.table+'.list')).rows.find((r:any)=>r.source_id==='REQUEST-1');const t=await start(f.noun+'.cancel',{id:row.id});
   expect(t.card.args.input_hash).toBe(row.input_hash);
   expect(t.card.args).toMatchObject({source_id:row.source_id,amount_minor:row.amount_minor,currency:row.currency,[f.fk]:row[f.fk]});
   expect((await P.api('POST','/api/desk/'+t.card.id+'/answer',{decision:'yes',fingerprint_seen:'stale'})).status).not.toBe(200);
   expect((await read(f.table+'.list')).rows.find((r:any)=>r.id===row.id).status).toBe('draft');
   await P.restartBackend(f.id);const proof=await approve(t);expect(proof.status).toBe('DONE');expect(proof.proof.read_back).toMatchObject({id:row.id,status:'cancelled',external_completed:false});
   const again=await P.api('POST','/api/desk/'+t.card.id+'/answer',{decision:'yes',fingerprint_seen:t.card.fingerprint});expect([200,409]).toContain(again.status);
   expect((await start(f.noun+'.cancel',{id:row.id})).card).toBeNull();
  });
  it('enforces immutable drafts and receipts, including terminal-state and deletion checks',async()=>{
   await expect(P.backend.core.company(P.company.id,db=>db.query('update '+f.id+'.'+f.table+' set amount_minor=1'))).rejects.toThrow(/immutable/);
   await expect(P.backend.core.company(P.company.id,db=>db.query('delete from '+f.id+'.'+f.table))).rejects.toThrow(/cannot be deleted/);
   await expect(P.backend.core.company(P.company.id,db=>db.query('update '+f.id+'.write_receipts set result=$1',['{}']))).rejects.toThrow(/immutable/);
  });
  it('isolates company reads and cross-company foreign keys, and denies the platform schema',async()=>{
   const B=await P.platform.createCompany('Isolated '+f.id);await P.platform.installApp(B.id,f.id);
   expect((await P.read(f.id+'.'+f.table+'.list',{}, {app:f.id,company:B.id})).body.result.empty).toBe(true);
   const other=randomUUID();await P.backend.core.company(B.id,db=>db.query('insert into '+f.id+'.'+f.master+'(id,company_id,source_id,name) values($1,$2,$3,$4)',[other,B.id,'B-ONLY','Other tenant']));
   await run(f.noun+'.prepare',{...f.sample,source_id:'CROSS-TENANT',[f.fk]:other});
   expect((await read(f.table+'.list')).rows.some((r:any)=>r.source_id==='CROSS-TENANT')).toBe(false);
   const existing=(await P.backend.core.company(P.company.id,db=>db.query('select * from '+f.id+'.'+f.table+" where company_id=$1 and status='draft' limit 1",[P.company.id]))).rows[0];
   const forged={...existing,id:randomUUID(),source_id:'CROSS-FK',reference:'cross-fk:'+randomUUID(),[f.fk]:other};
   await expect(P.backend.core.company(P.company.id,db=>db.query('insert into '+f.id+'.'+f.table+' select * from jsonb_populate_record(null::'+f.id+'.'+f.table+',$1::jsonb)',[JSON.stringify(forged)]))).rejects.toThrow(/foreign key/);
   await expect(P.backend.core.company(P.company.id,db=>db.query('select * from neos.users'))).rejects.toThrow(/permission denied/);
   expect((await P.backend.core.appPool.query('select * from '+f.id+'.'+f.table)).rows).toEqual([]);
  });
  it('paginates honest reads and rechecks switches for the SQL block path',async()=>{
   const page=await read(f.master+'.list',{limit:1});expect(page.rows).toHaveLength(1);expect(page.next_offset).toBe(1);
   const next=await read(f.master+'.list',{limit:1,offset:page.next_offset});expect(next.rows).toHaveLength(1);expect(next.next_offset).toBeNull();expect(next.rows[0].id).not.toBe(page.rows[0].id);
   const key=f.id+'.'+f.table+'.list';await P.api('PUT','/api/switchboards/'+f.id,{settings:{[key]:'off'}});
   expect((await P.read(key,{}, {app:f.id})).status).toBe(403);
   expect((await P.api('POST','/api/apps/'+f.id+'/read/'+key,{})).status).not.toBe(200);
   await P.api('PUT','/api/switchboards/'+f.id,{settings:{[key]:'on'}});
  });
  it('does not accept document-supplied authority or terminal-state claims',async()=>{
   const party=(await read(f.master+'.list')).rows[0];const before=(await read(f.table+'.list')).rows;
   const t=await start(f.noun+'.prepare',{...f.sample,source_id:'FORGED-AUTHORITY',[f.fk]:party.id,status:'approved',actor:'admin',external_completed:true});
   expect(t.card).toBeNull();expect((await read(f.table+'.list')).rows).toEqual(before);
  });
  it('a human no resumes without changing or cancelling the draft',async()=>{
   const row=(await read(f.table+'.list')).rows.find((r:any)=>r.source_id==='CONCURRENT');
   const t=await start(f.noun+'.cancel',{id:row.id});expect(t.card).toBeTruthy();
   const answer=await P.api('POST','/api/desk/'+t.card.id+'/answer',{decision:'no',fingerprint_seen:t.card.fingerprint});expect(answer.status).toBe(200);
   await P.waitFor(async()=>['COMPLETED','FAILED'].includes((await P.task(t.task_id)).task.status),'rejection resumed');
   expect((await read(f.table+'.list')).rows.find((r:any)=>r.id===row.id)).toEqual(row);
   const p=(await P.backend.core.runnerPool.query('select status from '+sqlIdent(f.id)+'.proposals where id=$1',[t.card.proposal_id])).rows[0];expect(p.status).toBe('REJECTED');
  });
  it('refuses a stale draft hash at execution and leaves no success receipt',async()=>{
   const row=(await read(f.table+'.list')).rows.find((r:any)=>r.source_id==='CONCURRENT');
   const handler=P.backend.core.app.abilities[f.id+'.'+f.noun+'.cancel'] as WriteAbility;
   const ctx=context('test:stale:'+randomUUID());const args={id:row.id,input_hash:'0'.repeat(64)};
   // Keep the stale-domain-hash check distinct from the new outer authority check.
   await expect(ctx.withDb(db=>f.data.cancel(db,P.company.id,args,ctx.idempotencyKey))).rejects.toThrow('approved fingerprint');
   expect((await handler.readBack(args,ctx,ctx.idempotencyKey)).found).toBe(false);
   expect((await read(f.table+'.list')).rows.find((r:any)=>r.id===row.id)).toEqual(row);
  });
  it('reapplies the migration set on populated records without altering them',async()=>{
   const before=(await read(f.table+'.list')).rows;await migrateApp(P.adminUrl,await f.app());expect((await read(f.table+'.list')).rows).toEqual(before);
  });
  it('exposes no business-approval, arbitrary finalize or external-effect handler',async()=>{
   const app=await f.app();expect(app.manifest.doors).toEqual([]);expect(app.manifest.abilities.every(a=>!a.effects?.external)).toBe(true);
   for(const key of Object.keys(app.abilities))expect(key).not.toMatch(/\.(decide|approve|execute|place|disburse)$/);
   expect(Object.keys(app.abilities).sort()).toEqual(app.manifest.abilities.map(a=>a.key).sort());
  });
 });
}
