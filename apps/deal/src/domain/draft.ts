// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { opportunity_id:string; list_price_minor:number; currency:string; discount_bps:number }
export function prepare(input:DraftInput, discountLimitBps:number|null) {
 const price=integer(input.list_price_minor,'list_price_minor'); const bps=integer(input.discount_bps,'discount_bps',10000);
 const ceiling=discountLimitBps===null?null:integer(discountLimitBps,'discount limit',10000);
 // Half-up once in integer units. Never binary floating point or repeated per-line rounding.
 const net=Number((BigInt(price)*BigInt(10000-bps)+5000n)/10000n);
 return {opportunity_id:uuid(input.opportunity_id),list_price_minor:price,currency:currency(input.currency),discount_bps:bps,net_minor:net,
  discount_limit_bps:ceiling,requires_elevated_approval:ceiling!==null&&bps>ceiling,status:'draft' as const,external_completed:false as const};
}
