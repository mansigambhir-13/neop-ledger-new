import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from '@neop/pgkit';
import {canonicalize} from '@neop/contracts';
import {DomainError} from '@neop/domain-values';
import {prepare,type DraftInput} from '../domain/draft.ts';
export const digest=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
export async function lock(db:PoolClient,company:string) { await db.query("select pg_advisory_xact_lock(hashtext('pay.drafts'),hashtext($1))",[company]); }
export async function read(db:PoolClient,kind:'settings'|'payees'|'payments',args:unknown) {
 return (await db.query(`select pay.read_${kind}($1::jsonb) as result`,[JSON.stringify(args)])).rows[0]!.result;
}
export async function receipt(db:PoolClient,company:string,key:string) { return (await db.query('select request_hash,result from pay.write_receipts where company_id=$1 and reference=$2',[company,key])).rows[0]??null; }
export async function saveReceipt(db:PoolClient,company:string,key:string,request:unknown,result:unknown) {
 await db.query('insert into pay.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,$3,$4,$5)',[randomUUID(),company,key,digest(request),JSON.stringify(result)]);
}
export async function configure(db:PoolClient,company:string,a:{currency:string;review_limit_minor:number|null}) {
 await db.query('insert into pay.settings(company_id,currency,review_limit_minor) values($1,$2,$3) on conflict(company_id) do update set currency=excluded.currency,review_limit_minor=excluded.review_limit_minor',[company,a.currency,a.review_limit_minor]);
 return {configured:true,approval_workflow_available:false};
}
export async function importParties(db:PoolClient,company:string,rows:{source_id:string;name:string;category:string|null}[]) {
 for(const p of rows) await db.query('insert into pay.payees(id,company_id,source_id,name,category) values($1,$2,$3,$4,$5) on conflict(company_id,source_id) do update set name=excluded.name,category=excluded.category,version=pay.payees.version+1',[randomUUID(),company,p.source_id,p.name,p.category]);
 return {imported:rows.length};
}
export async function getDraft(db:PoolClient,company:string,id:string) { return (await db.query('select id,input_hash,status,source_id,amount_minor,currency,payee_id from pay.payments where company_id=$1 and id=$2',[company,id])).rows[0]??null; }
export async function prepareDraft(db:PoolClient,company:string,a:DraftInput,reference:string) {
 const cfg=(await db.query('select currency,review_limit_minor from pay.settings where company_id=$1',[company])).rows[0];
 if(!cfg) throw new DomainError('configure the draft review settings first');
 if(cfg.currency!==a.currency) throw new DomainError('currency differs from the reviewed settings');
 const party=(await db.query('select id,version from pay.payees where company_id=$1 and id=$2',[company,a.payee_id])).rows[0];
 if(!party) throw new DomainError('unknown payee in this company');
 if((await db.query('select id from pay.payments where company_id=$1 and source_id=$2',[company,a.source_id])).rowCount) throw new DomainError('source_id already has a draft; do not duplicate the business request');
 const draft=prepare(a,cfg.review_limit_minor===null?null:Number(cfg.review_limit_minor));
 const snapshot={draft,party_version:party.version,settings:{currency:cfg.currency,review_limit_minor:cfg.review_limit_minor===null?null:Number(cfg.review_limit_minor)}};
 const input_hash=digest(snapshot);const id=randomUUID();
 await db.query('insert into pay.payments(id,company_id,source_id,payee_id,amount_minor,currency,method,notes,requires_elevated_approval,input_hash,source_snapshot,reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
 [id,company,draft.source_id,draft.payee_id,draft.amount_minor,draft.currency,draft.method,draft.notes,draft.requires_elevated_approval,input_hash,JSON.stringify(snapshot),reference]);
 return {id,input_hash,status:'draft',external_completed:false};
}
export async function cancel(db:PoolClient,company:string,a:{id:string;input_hash:string},reference:string) {
 const row=await getDraft(db,company,a.id);
 if(!row||row.status!=='draft') throw new DomainError('only an existing draft can be cancelled');
 if(row.input_hash!==a.input_hash) throw new DomainError('draft differs from the approved fingerprint');
 await db.query("update pay.payments set status='cancelled',cancelled_at=now(),cancel_ref=$3 where company_id=$1 and id=$2",[company,a.id,reference]);
 return {id:a.id,input_hash:a.input_hash,status:'cancelled',external_completed:false};
}
