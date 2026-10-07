// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { source_id:string; candidate_id:string; salary_minor:number; currency:string; role:string|null }
export function prepare(input:DraftInput, reviewLimit:number|null) {
 const amount=integer(input.salary_minor,'salary_minor'); const ceiling=limit(reviewLimit);
 return { source_id:required(input.source_id,'source_id',64), candidate_id:uuid(input.candidate_id), salary_minor:amount, currency:currency(input.currency), role:nullable(input.role,'role'),
   review_limit_minor:ceiling, requires_elevated_approval:ceiling!==null && amount>ceiling, status:'draft' as const, external_completed:false as const };
}
