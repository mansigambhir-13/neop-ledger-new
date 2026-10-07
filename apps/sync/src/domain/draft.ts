// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; destination: string; sensitivity: 'public' | 'internal' | 'pii'; notes: string | null }
export function prepare(input: DraftInput) {
  const sensitivity=oneOf(input.sensitivity,["public","internal","pii"] as const,'sensitivity');
  return { reference_id:uuid(input.reference_id), destination:required(input.destination,'destination'), sensitivity, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: sensitivity==='pii', status:'draft' as const, external_completed:false as const };
}
