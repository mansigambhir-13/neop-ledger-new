// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { employee_id:string; type:'annual'|'sick'|'unpaid'; half_days:number; notes:string|null }
export function prepare(input:DraftInput) {
 const type=oneOf(input.type,['annual','sick','unpaid'] as const,'leave type');
 return {employee_id:uuid(input.employee_id),type,half_days:integer(input.half_days,'half_days',730),notes:nullable(input.notes,'notes'),
   requires_elevated_approval:type==='unpaid',status:'draft' as const,external_completed:false as const};
}
