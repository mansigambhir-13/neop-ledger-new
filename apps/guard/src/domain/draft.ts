// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { reference_id: string; summary: string; severity: 'low' | 'medium' | 'critical'; notes: string | null }
export function prepare(input: DraftInput) {
  const severity=oneOf(input.severity,["low","medium","critical"] as const,'severity');
  return { reference_id:uuid(input.reference_id), summary:required(input.summary,'summary'), severity, notes:nullable(input.notes,'notes'),
    requires_elevated_approval: severity==='critical', status:'draft' as const, external_completed:false as const };
}
