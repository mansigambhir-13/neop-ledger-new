import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from '@neop/pgkit';
import {canonicalize} from '@neop/contracts';
import {DomainError,distinct} from '@neop/domain-values';
import {prepare,type DraftInput} from '../domain/draft.ts';
export const digest=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
type Settings={case_score:number;sar_score:number};
export async function lock(db:PoolClient,company:string){await db.query("select pg_advisory_xact_lock(hashtext('clear.drafts'),hashtext($1))",[company]);}
export async function read(db:PoolClient,kind:'settings'|'subjects'|'assessments',args:unknown){return (await db.query(`select clear.read_${kind}($1::jsonb) as result`,[JSON.stringify(args)])).rows[0]!.result;}
export async function receipt(db:PoolClient,company:string,key:string){return (await db.query('select request_hash,result from clear.write_receipts where company_id=$1 and reference=$2',[company,key])).rows[0]??null;}
export async function saveReceipt(db:PoolClient,company:string,key:string,request:unknown,result:unknown){await db.query('insert into clear.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,$3,$4,$5)',[randomUUID(),company,key,digest(request),JSON.stringify(result)]);}
export async function configure(db:PoolClient,company:string,a:Settings){
 await db.query('insert into clear.settings(company_id,case_score,sar_score) values($1,$2,$3) on conflict(company_id) do update set case_score=excluded.case_score,sar_score=excluded.sar_score',[company,a.case_score,a.sar_score]);
 return {configured:true,approval_workflow_available:false};
}
export async function importParties(db:PoolClient,company:string,rows:{source_id:string;name:string;category:string|null}[]){
 distinct(rows.map(p=>p.source_id));
 for(const p of rows)await db.query('insert into clear.subjects(id,company_id,source_id,name,category) values($1,$2,$3,$4,$5) on conflict(company_id,source_id) do update set name=excluded.name,category=excluded.category,version=clear.subjects.version+1',[randomUUID(),company,p.source_id,p.name,p.category]);
 return {imported:rows.length};
}
export async function getDraft(db:PoolClient,company:string,id:string){return (await db.query('select id,input_hash,status,source_id,subject_id,sanctions,pep,adverse,evidence_reference,requires_elevated_approval,score,rating,case_draft,sar_draft,assessment_status from clear.assessments where company_id=$1 and id=$2',[company,id])).rows[0]??null;}
export async function prepareDraft(db:PoolClient,company:string,a:DraftInput&{source_id:string},reference:string){
 const raw=(await db.query('select case_score,sar_score from clear.settings where company_id=$1',[company])).rows[0];
 if(!raw)throw new DomainError('configure the draft review settings first');
 const cfg:Settings={case_score:raw.case_score===null?null:Number(raw.case_score),sar_score:raw.sar_score===null?null:Number(raw.sar_score)} as Settings;

 const party=(await db.query('select id,version from clear.subjects where company_id=$1 and id=$2',[company,a.subject_id])).rows[0];
 if(!party)throw new DomainError('unknown subjects record in this company');
 if((await db.query('select id from clear.assessments where company_id=$1 and source_id=$2',[company,a.source_id])).rowCount)throw new DomainError('source_id already has a draft; do not duplicate the business request');
 const draft={...prepare(a,cfg),source_id:a.source_id};
 const snapshot={draft,party_version:party.version,settings:cfg};const input_hash=digest(snapshot);const id=randomUUID();
 await db.query('insert into clear.assessments(id,company_id,source_id,subject_id,sanctions,pep,adverse,evidence_reference,requires_elevated_approval,score,rating,case_draft,sar_draft,assessment_status,input_hash,source_snapshot,reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[id,company,draft.source_id,draft.subject_id,draft.sanctions,draft.pep,draft.adverse,draft.evidence_reference,draft.requires_elevated_approval,draft.score,draft.rating,draft.case_draft,draft.sar_draft,draft.assessment_status,input_hash,JSON.stringify(snapshot),reference]);
 return {id,input_hash,status:'draft',external_completed:false};
}
export async function cancel(db:PoolClient,company:string,a:{id:string;input_hash:string},reference:string){
 const row=await getDraft(db,company,a.id);
 if(!row||row.status!=='draft')throw new DomainError('only an existing draft can be cancelled');
 if(row.input_hash!==a.input_hash)throw new DomainError('draft differs from the approved fingerprint');
 await db.query("update clear.assessments set status='cancelled',cancelled_at=now(),cancel_ref=$3 where company_id=$1 and id=$2",[company,a.id,reference]);
 return {id:a.id,input_hash:a.input_hash,status:'cancelled',external_completed:false};
}
