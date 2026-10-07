// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { source_id:string; account_id:string; amount_minor:number; currency:string; band:'standard' | 'extra' | 'exceptional'; notes:string|null }
export function prepare(input:DraftInput) {
 const band=oneOf(input.band,["standard","extra","exceptional"] as const,'band');
 return { source_id:required(input.source_id,'source_id',64), account_id:uuid(input.account_id), amount_minor:integer(input.amount_minor,'amount_minor'), currency:currency(input.currency),
   band, notes:nullable(input.notes,'notes'), requires_elevated_approval:band==='exceptional', status:'draft' as const, external_completed:false as const };
}
