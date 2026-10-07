import type {PoolClient} from '@neop/pgkit';
import {checkHumanAuthority,DoorError,type ReadAbility,type WriteAbility} from '@neop/template';
import {distinct,DomainError,uuid} from '@neop/domain-values';
import {prepare as checkDraft} from '../domain/draft.ts';
import * as repo from '../data/drafts.repo.ts';
const read=(kind:Parameters<typeof repo.read>[1]):ReadAbility=>({kind:'read',run:(args,ctx)=>repo.read(ctx.db,kind,args)});
function write(key:string,operation:(db:PoolClient,company:string,args:any,ref:string)=>Promise<unknown>):WriteAbility {
 const humanOnly=!key.endsWith('.prepare');
 return {kind:'write',requiresHumanApproval:humanOnly,async execute(args,ctx) {
  try {
   const detail=await ctx.withDb(async db=>{
    await repo.lock(db,ctx.company_id);const request={ability:key,args};const previous=await repo.receipt(db,ctx.company_id,ctx.idempotencyKey);
    if(previous) {if(previous.request_hash!==repo.digest(request)) throw new DomainError('idempotency key content collision');return previous.result;}
    if(!humanOnly) {
     if(!ctx.job_id) throw new DoorError('origin_required: a creating job is required',{definite:true});
     await db.query("select set_config('neos.draft_origin_job',$1,true)",[ctx.job_id]);
    }
    const authority=humanOnly?await checkHumanAuthority(db,'desk',key,args,ctx):null;
    const value=await operation(db,ctx.company_id,args,ctx.idempotencyKey);
    const result=authority?{...(value as Record<string,unknown>),authority}:value;
    await repo.saveReceipt(db,ctx.company_id,ctx.idempotencyKey,request,result);return result;
   });return {external_ref:ctx.idempotencyKey,detail};
  } catch(e) {if(e instanceof DomainError || (e instanceof Error && (e as {code?:string}).code==='42501' && e.message.startsWith('origin_'))) throw new DoorError(e.message,{definite:true});throw e;}
 },async readBack(args,ctx) {
  const r=await ctx.withDb(db=>repo.receipt(db,ctx.company_id,ctx.idempotencyKey));
  return {found:!!r&&r.request_hash===repo.digest({ability:key,args}),data:r?.result??null};
 }};
}
const imports=write('desk.tickets.import',(db,c,a)=>repo.importParties(db,c,a.tickets));
imports.check=a=>{try{distinct(a.tickets.map((p:any)=>p.source_id));return null;}catch(e){return (e as Error).message;}};
const prepare=write('desk.refund.prepare',repo.prepareDraft);
prepare.check=a=>{try{checkDraft(a,null);return null;}catch(e){return (e as Error).message;}};
const cancel=write('desk.refund.cancel',repo.cancel);
cancel.normalize=async(a,ctx)=>{
 try{uuid(a?.id);}catch{return a;}
 const row=await repo.getDraft(ctx.db,ctx.company_id,a.id);
 return row?{...a,input_hash:row.input_hash,review:{source_id:row.source_id,ticket_id:row.ticket_id,amount_minor:row.amount_minor===null?null:Number(row.amount_minor),currency:row.currency,reason:row.reason,requires_elevated_approval:row.requires_elevated_approval,review_limit_minor:row.review_limit_minor===null?null:Number(row.review_limit_minor)}}:a;
};
cancel.validate=async(a,ctx)=>{const row=await repo.getDraft(ctx.db,ctx.company_id,a.id);return row?.status==='draft'?null:'only an existing draft can be cancelled';};
export const abilities={
 'desk.settings.get':read('settings'),'desk.settings.update':write('desk.settings.update',(db,c,a)=>repo.configure(db,c,a)),
 'desk.tickets.list':read('tickets'),'desk.refunds.list':read('refunds'),
 'desk.tickets.import':imports,'desk.refund.prepare':prepare,'desk.refund.cancel':cancel,
};
