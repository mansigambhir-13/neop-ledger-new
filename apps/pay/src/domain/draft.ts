// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { source_id:string; payee_id:string; amount_minor:number; currency:string; method:'ach' | 'card' | 'wire'; notes:string|null }
export function prepare(input:DraftInput, reviewLimit:number|null=null) {
 const method=oneOf(input.method,["ach","card","wire"] as const,'method');
 const ceiling=limit(reviewLimit);
 return { source_id:required(input.source_id,'source_id',64), payee_id:uuid(input.payee_id), amount_minor:integer(input.amount_minor,'amount_minor'), currency:currency(input.currency),
   method, notes:nullable(input.notes,'notes'), requires_elevated_approval:method==='wire'||(ceiling!==null&&input.amount_minor>ceiling), status:'draft' as const, external_completed:false as const };
}
