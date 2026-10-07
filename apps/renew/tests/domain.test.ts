import {describe,expect,it} from 'vitest';
import {prepare} from '../src/domain/draft.ts';
const input={"source_id":"SOURCE-1","vendor_id":"a1111111-1111-4111-8111-111111111111","amount_minor":12345,"currency":"INR","term":"monthly","notes":null};
const calculate=(v:any)=>(prepare as (...a:any[])=>any)(v,null);
describe('renew: pinned business-rule port (not full V3 conformance)',()=>{
 it('adds a conservative amount-review flag without removing multi-year review',()=>{expect(prepare(input as any,12345).requires_elevated_approval).toBe(false);expect(prepare(input as any,12344).requires_elevated_approval).toBe(true);expect(prepare({...input,term:'multiyear'} as any,100000).requires_elevated_approval).toBe(true);});
 it('preserves the ordinary source case without asserting an external effect',()=>{expect(calculate(input)).toMatchObject({status:'draft',requires_elevated_approval:false,external_completed:false});});
 it('preserves the elevated-review boundary',()=>{expect(calculate({...input,...{"term":"multiyear"}}).requires_elevated_approval).toBe(true);});
 it('refuses invalid or lossy values',()=>{expect(()=>calculate({...input,...{"amount_minor":1.1}})).toThrow();});
 it('returns identical domain data for identical inputs',()=>{expect(calculate(input)).toEqual(calculate(input));});
 it('does not accept a status or actor supplied by an untrusted document',()=>{const r=calculate({...input,status:'paid',actor:'admin',external_completed:true});expect(r.external_completed).toBe(false);expect(r.status).toBe('draft');expect(r).not.toHaveProperty('actor');});

});
