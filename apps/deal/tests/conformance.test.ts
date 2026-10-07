import {conformance} from '@neop/testkit';
import {dealApp} from '../src/index.ts';
conformance({app:async()=>({def:await dealApp()}),reads:{"deal.settings.get":{},"deal.opportunities.list":{},"deal.quotes.list":{}},gatedWrite:{"key":"deal.settings.update","args":{"currency":"INR","discount_limit_bps":5000}}});
