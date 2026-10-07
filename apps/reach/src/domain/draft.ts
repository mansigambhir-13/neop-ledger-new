// Legacy business rule port; not an authorization decision or a provider effect.
import { integer, currency, required, nullable, oneOf, limit, uuid } from '@neop/domain-values';
export interface DraftInput { audience_id:string; channel:'email'|'sms'|'whatsapp'; recipients:number; subject:string|null; body:string }
export function prepare(input:DraftInput, recipientLimit:number|null) {
 const count=integer(input.recipients,'recipients',1000000); const ceiling=recipientLimit===null?null:integer(recipientLimit,'recipient limit',1000000);
 return {audience_id:uuid(input.audience_id),channel:oneOf(input.channel,['email','sms','whatsapp'] as const,'channel'),recipients:count,
  subject:nullable(input.subject,'subject',200),body:required(input.body,'body',20000),recipient_limit:ceiling,
  requires_elevated_approval:ceiling!==null&&count>ceiling,status:'draft' as const,external_completed:false as const};
}
