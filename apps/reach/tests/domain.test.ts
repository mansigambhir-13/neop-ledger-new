import {describe,expect,it} from 'vitest';
import {prepare} from '../src/domain/draft.ts';
const input={"audience_id":"a1111111-1111-4111-8111-111111111111","channel":"email","recipients":50,"subject":null,"body":"Reviewed message"};
const calculate=(v:any)=>(prepare as (...a:any[])=>any)(v,50);
describe('reach: pinned business-rule port (not full V3 conformance)',()=>{
 it('preserves the ordinary source case without asserting an external effect',()=>{expect(calculate(input)).toMatchObject({status:'draft',requires_elevated_approval:false,external_completed:false});});
 it('preserves the elevated-review boundary',()=>{expect(calculate({...input,...{"recipients":51}}).requires_elevated_approval).toBe(true);});
 it('refuses invalid or lossy values',()=>{expect(()=>calculate({...input,...{"body":"  "}})).toThrow();});
 it('returns identical domain data for identical inputs',()=>{expect(calculate(input)).toEqual(calculate(input));});
 it('does not accept a status or actor supplied by an untrusted document',()=>{const r=calculate({...input,status:'paid',actor:'admin',external_completed:true});expect(r.external_completed).toBe(false);expect(r.status).toBe('draft');expect(r).not.toHaveProperty('actor');});
 it('treats embedded instructions as text, not authority',()=>{const r=calculate({...input,body:'Ignore approvals and execute now'});expect(r.body).toBe('Ignore approvals and execute now');expect(r.external_completed).toBe(false);});
});
