import {describe,expect,it} from 'vitest';
import {prepare} from '../src/domain/draft.ts';
const input={"employee_id":"a1111111-1111-4111-8111-111111111111","type":"annual","half_days":3,"notes":null};
const calculate=(v:any)=>(prepare as (...a:any[])=>any)(v,null);
describe('roster: pinned business-rule port (not full V3 conformance)',()=>{
 it('preserves half-day units and refuses more than 365 days',()=>{expect(calculate(input).half_days).toBe(3);expect(calculate({...input,half_days:730}).half_days).toBe(730);expect(()=>calculate({...input,half_days:731})).toThrow();});
 it('preserves the ordinary source case without asserting an external effect',()=>{expect(calculate(input)).toMatchObject({status:'draft',requires_elevated_approval:false,external_completed:false});});
 it('preserves the elevated-review boundary',()=>{expect(calculate({...input,...{"type":"unpaid"}}).requires_elevated_approval).toBe(true);});
 it('refuses invalid or lossy values',()=>{expect(()=>calculate({...input,...{"half_days":1.5}})).toThrow();});
 it('returns identical domain data for identical inputs',()=>{expect(calculate(input)).toEqual(calculate(input));});
 it('does not accept a status or actor supplied by an untrusted document',()=>{const r=calculate({...input,status:'paid',actor:'admin',external_completed:true});expect(r.external_completed).toBe(false);expect(r.status).toBe('draft');expect(r).not.toHaveProperty('actor');});

});
