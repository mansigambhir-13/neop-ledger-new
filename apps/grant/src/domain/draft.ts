// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; system: string; level: 'read' | 'write' | 'admin'; notes: string | null }
export function prepare(input: DraftInput) {
  const level=oneOf(input.level,["read","write","admin"] as const,'level');
  return { reference_id:uuid(input.reference_id), system:required(input.system,'system'), level, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: level==='admin', status:'draft' as const, external_completed:false as const };
}
