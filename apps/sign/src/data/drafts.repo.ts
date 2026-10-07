import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from '@neop/pgkit';
import {canonicalize} from '@neop/contracts';
import {DomainError,distinct} from '@neop/domain-values';
import {prepare,type DraftInput} from '../domain/draft.ts';
export const digest=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
type Settings=null;
export async function lock(db:PoolClient,company:string){await db.query("select pg_advisory_xact_lock(hashtext('sign.drafts'),hashtext($1))",[company]);}
export async function read(db:PoolClient,kind:'counterparties'|'contracts',args:unknown){return (await db.query(`select sign.read_${kind}($1::jsonb) as result`,[JSON.stringify(args)])).rows[0]!.result;}
export async function receipt(db:PoolClient,company:string,key:string){return (await db.query('select request_hash,result from sign.write_receipts where company_id=$1 and reference=$2',[company,key])).rows[0]??null;}
export async function saveReceipt(db:PoolClient,company:string,key:string,request:unknown,result:unknown){await db.query('insert into sign.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,$3,$4,$5)',[randomUUID(),company,key,digest(request),JSON.stringify(result)]);}

export async function importParties(db:PoolClient,company:string,rows:{source_id:string;name:string;category:string|null}[]){
 distinct(rows.map(p=>p.source_id));
 for(const p of rows)await db.query('insert into sign.counterparties(id,company_id,source_id,name,category) values($1,$2,$3,$4,$5) on conflict(company_id,source_id) do update set name=excluded.name,category=excluded.category,version=sign.counterparties.version+1',[randomUUID(),company,p.source_id,p.name,p.category]);
 return {imported:rows.length};
}
export async function getDraft(db:PoolClient,company:string,id:string){return (await db.query('select id,input_hash,status,source_id,reference_id,title,risk,notes,requires_elevated_approval from sign.contracts where company_id=$1 and id=$2',[company,id])).rows[0]??null;}
export async function prepareDraft(db:PoolClient,company:string,a:DraftInput&{source_id:string},reference:string){
 const cfg:Settings=null;
 const party=(await db.query('select id,version from sign.counterparties where company_id=$1 and id=$2',[company,a.reference_id])).rows[0];
 if(!party)throw new DomainError('unknown counterparties record in this company');
 if((await db.query('select id from sign.contracts where company_id=$1 and source_id=$2',[company,a.source_id])).rowCount)throw new DomainError('source_id already has a draft; do not duplicate the business request');
 const draft={...prepare(a),source_id:a.source_id};
 const snapshot={draft,party_version:party.version,settings:cfg};const input_hash=digest(snapshot);const id=randomUUID();
 await db.query('insert into sign.contracts(id,company_id,source_id,reference_id,title,risk,notes,requires_elevated_approval,input_hash,source_snapshot,reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,company,draft.source_id,draft.reference_id,draft.title,draft.risk,draft.notes,draft.requires_elevated_approval,input_hash,JSON.stringify(snapshot),reference]);
 return {id,input_hash,status:'draft',external_completed:false};
}
export async function cancel(db:PoolClient,company:string,a:{id:string;input_hash:string},reference:string){
 const row=await getDraft(db,company,a.id);
 if(!row||row.status!=='draft')throw new DomainError('only an existing draft can be cancelled');
 if(row.input_hash!==a.input_hash)throw new DomainError('draft differs from the approved fingerprint');
 await db.query("update sign.contracts set status='cancelled',cancelled_at=now(),cancel_ref=$3 where company_id=$1 and id=$2",[company,a.id,reference]);
 return {id:a.id,input_hash:a.input_hash,status:'cancelled',external_completed:false};
}
