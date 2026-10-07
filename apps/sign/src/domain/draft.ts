// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; title: string; risk: 'standard' | 'elevated' | 'high'; notes: string | null }
export function prepare(input: DraftInput) {
  const risk=oneOf(input.risk,["standard","elevated","high"] as const,'risk');
  return { reference_id:uuid(input.reference_id), title:required(input.title,'title'), risk, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: risk==='high', status:'draft' as const, external_completed:false as const };
}
