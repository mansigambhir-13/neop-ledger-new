// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; engagement: string; tier: 'low' | 'medium' | 'high'; notes: string | null }
export function prepare(input: DraftInput) {
  const tier=oneOf(input.tier,["low","medium","high"] as const,'tier');
  return { reference_id:uuid(input.reference_id), engagement:required(input.engagement,'engagement'), tier, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: tier==='high', status:'draft' as const, external_completed:false as const };
}
