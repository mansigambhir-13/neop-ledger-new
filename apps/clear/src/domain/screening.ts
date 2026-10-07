// Port of the pinned source's deterministic scoring only. Not a watchlist, matcher, KYC decision or SAR submission.
import { integer, DomainError } from '@neop/domain-values';
export interface ScreeningSignals { sanctions:boolean|null; pep:boolean|null; adverse:boolean|null }
export function scoreSignals(signals:ScreeningSignals, thresholds:{case_score:number;sar_score:number}) {
 const c=integer(thresholds.case_score,'case_score',100); const s=integer(thresholds.sar_score,'sar_score',100);
 for(const value of Object.values(signals)) if(value!==null && typeof value!=='boolean') throw new DomainError('screening signals must be boolean or null');
 if(['sanctions','pep','adverse'].some(k=>signals[k as keyof ScreeningSignals]===undefined)) throw new DomainError('all screening signals are required');
 if(Object.values(signals).some(v=>v===null)) return {score:null,rating:null,case_draft:null,sar_draft:null,status:'needs_evidence' as const,external_completed:false as const};
 const score=Math.min(100,10+(signals.sanctions?50:0)+(signals.pep?30:0)+(signals.adverse?20:0));
 return {score,rating:score>=75?'high':score>=40?'medium':'low',case_draft:score>=c,sar_draft:score>=c&&(signals.sanctions||score>=s),status:'review_only' as const,external_completed:false as const};
}
