import {describe,expect,it} from 'vitest';
import {prepare} from '../src/domain/draft.ts';
const input={"source_id":"SOURCE-1","candidate_id":"a1111111-1111-4111-8111-111111111111","salary_minor":1000,"currency":"INR","role":null};
const calculate=(v:any)=>(prepare as (...a:any[])=>any)(v,1000);
describe('hire: pinned business-rule port (not full V3 conformance)',()=>{
 it('preserves the ordinary source case without asserting an external effect',()=>{expect(calculate(input)).toMatchObject({status:'draft',requires_elevated_approval:false,external_completed:false});});
 it('preserves the elevated-review boundary',()=>{expect(calculate({...input,...{"salary_minor":1001}}).requires_elevated_approval).toBe(true);});
 it('refuses invalid or lossy values',()=>{expect(()=>calculate({...input,...{"salary_minor":-1}})).toThrow();});
 it('returns identical domain data for identical inputs',()=>{expect(calculate(input)).toEqual(calculate(input));});
 it('does not accept a status or actor supplied by an untrusted document',()=>{const r=calculate({...input,status:'paid',actor:'admin',external_completed:true});expect(r.external_completed).toBe(false);expect(r.status).toBe('draft');expect(r).not.toHaveProperty('actor');});

});
