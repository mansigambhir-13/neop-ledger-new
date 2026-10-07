// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { source_id:string; ticket_id:string; amount_minor:number; currency:string; reason:string|null }
export function prepare(input:DraftInput, reviewLimit:number|null) {
 const amount=integer(input.amount_minor,'amount_minor'); const ceiling=limit(reviewLimit);
 return { source_id:required(input.source_id,'source_id',64), ticket_id:uuid(input.ticket_id), amount_minor:amount, currency:currency(input.currency), reason:nullable(input.reason,'reason'),
   review_limit_minor:ceiling, requires_elevated_approval:ceiling!==null && amount>ceiling, status:'draft' as const, external_completed:false as const };
}
