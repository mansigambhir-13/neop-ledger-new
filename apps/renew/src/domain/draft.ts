// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { source_id:string; vendor_id:string; amount_minor:number; currency:string; term:'monthly' | 'annual' | 'multiyear'; notes:string|null }
export function prepare(input:DraftInput, reviewLimit:number|null=null) {
 const term=oneOf(input.term,["monthly","annual","multiyear"] as const,'term');
 const ceiling=limit(reviewLimit);
 return { source_id:required(input.source_id,'source_id',64), vendor_id:uuid(input.vendor_id), amount_minor:integer(input.amount_minor,'amount_minor'), currency:currency(input.currency),
   term, notes:nullable(input.notes,'notes'), requires_elevated_approval:term==='multiyear'||(ceiling!==null&&input.amount_minor>ceiling), status:'draft' as const, external_completed:false as const };
}
