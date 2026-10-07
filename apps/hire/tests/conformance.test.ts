import {conformance} from '@neop/testkit';
import {hireApp} from '../src/index.ts';
conformance({app:async()=>({def:await hireApp()}),reads:{"hire.settings.get":{},"hire.candidates.list":{},"hire.offers.list":{}},gatedWrite:{"key":"hire.settings.update","args":{"currency":"INR","review_limit_minor":10000}}});
