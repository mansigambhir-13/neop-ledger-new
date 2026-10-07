// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; item: string; band: 'standard' | 'premium' | 'executive'; notes: string | null }
export function prepare(input: DraftInput) {
  const band=oneOf(input.band,["standard","premium","executive"] as const,'band');
  return { reference_id:uuid(input.reference_id), item:required(input.item,'item'), band, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: band==='executive', status:'draft' as const, external_completed:false as const };
}
