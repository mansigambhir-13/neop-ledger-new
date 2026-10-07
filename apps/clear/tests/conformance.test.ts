import {conformance} from '@neop/testkit';
import {clearApp} from '../src/index.ts';
conformance({app:async()=>({def:await clearApp()}),reads:{"clear.settings.get":{},"clear.subjects.list":{},"clear.assessments.list":{}},gatedWrite:{"key":"clear.settings.update","args":{"case_score":50,"sar_score":75}}});
