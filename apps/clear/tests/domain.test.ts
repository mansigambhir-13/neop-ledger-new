import {describe,expect,it} from 'vitest';
import {scoreSignals} from '../src/domain/screening.ts';
const thresholds={case_score:50,sar_score:75};
describe('Clear: scoring evidence only, not KYC certification',()=>{
 it.each([[false,false,false,10,'low',false,false],[true,false,false,60,'medium',true,true],[false,true,true,60,'medium',true,false],[true,true,true,100,'high',true,true]] as const)('preserves legacy score for %s/%s/%s',(sanctions,pep,adverse,score,rating,case_draft,sar_draft)=>{expect(scoreSignals({sanctions,pep,adverse},thresholds)).toEqual({score,rating,case_draft,sar_draft,status:'review_only',external_completed:false});});
 it('missing evidence is unknown, never a clean screening',()=>{expect(scoreSignals({sanctions:null,pep:false,adverse:false},thresholds)).toMatchObject({score:null,rating:null,status:'needs_evidence'});});
 it('refuses malformed signals and thresholds',()=>{expect(()=>scoreSignals({sanctions:'false',pep:false,adverse:false} as any,thresholds)).toThrow();expect(()=>scoreSignals({sanctions:false,pep:false,adverse:false},{case_score:101,sar_score:75})).toThrow();});
});
