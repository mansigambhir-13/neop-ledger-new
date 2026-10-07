// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; title: string; audience: 'internal' | 'public' | 'regulated'; notes: string | null }
export function prepare(input: DraftInput) {
  const audience=oneOf(input.audience,["internal","public","regulated"] as const,'audience');
  return { reference_id:uuid(input.reference_id), title:required(input.title,'title'), audience, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: audience==='regulated', status:'draft' as const, external_completed:false as const };
}
