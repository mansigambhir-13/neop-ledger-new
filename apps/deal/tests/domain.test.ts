import {describe,expect,it} from 'vitest';
import {prepare} from '../src/domain/draft.ts';
const input={"opportunity_id":"a1111111-1111-4111-8111-111111111111","list_price_minor":101,"currency":"INR","discount_bps":5000};
const calculate=(v:any)=>(prepare as (...a:any[])=>any)(v,5000);
describe('deal: pinned business-rule port (not full V3 conformance)',()=>{
 it('rounds a half minor-unit once and keeps zero/full discounts exact',()=>{
  expect(calculate(input).net_minor).toBe(51);
  expect(calculate({...input,discount_bps:0}).net_minor).toBe(101);
  expect(calculate({...input,discount_bps:10000}).net_minor).toBe(0);
  expect(calculate({...input,list_price_minor:1000000000000,discount_bps:1}).net_minor).toBe(999900000000);
 });
 it('preserves the ordinary source case without asserting an external effect',()=>{expect(calculate(input)).toMatchObject({status:'draft',requires_elevated_approval:false,external_completed:false});});
 it('preserves the elevated-review boundary',()=>{expect(calculate({...input,...{"discount_bps":5001}}).requires_elevated_approval).toBe(true);});
 it('refuses invalid or lossy values',()=>{expect(()=>calculate({...input,...{"discount_bps":10001}})).toThrow();});
 it('returns identical domain data for identical inputs',()=>{expect(calculate(input)).toEqual(calculate(input));});
 it('does not accept a status or actor supplied by an untrusted document',()=>{const r=calculate({...input,status:'paid',actor:'admin',external_completed:true});expect(r.external_completed).toBe(false);expect(r.status).toBe('draft');expect(r).not.toHaveProperty('actor');});

});
