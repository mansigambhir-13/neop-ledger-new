// A stored review of supplied signals, not a screening provider or regulatory decision.
import {required,uuid} from '@neop/domain-values';
import {scoreSignals,type ScreeningSignals} from './screening.ts';
export interface DraftInput extends ScreeningSignals {source_id:string;subject_id:string;evidence_reference:string}
export function prepare(input:DraftInput,thresholds:{case_score:number;sar_score:number}) {
 const result=scoreSignals({sanctions:input.sanctions,pep:input.pep,adverse:input.adverse},thresholds);
 return {source_id:required(input.source_id,'source_id',64),subject_id:uuid(input.subject_id),sanctions:input.sanctions,pep:input.pep,adverse:input.adverse,
  evidence_reference:required(input.evidence_reference,'evidence_reference'),score:result.score,rating:result.rating,case_draft:result.case_draft,sar_draft:result.sar_draft,
  assessment_status:result.status,requires_elevated_approval:result.score===null?null:result.rating==='high',status:'draft' as const,external_completed:false as const};
}
