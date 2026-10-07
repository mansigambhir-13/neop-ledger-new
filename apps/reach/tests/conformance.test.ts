import {conformance} from '@neop/testkit';
import {reachApp} from '../src/index.ts';
conformance({app:async()=>({def:await reachApp()}),reads:{"reach.settings.get":{},"reach.audiences.list":{},"reach.campaigns.list":{}},gatedWrite:{"key":"reach.settings.update","args":{"recipient_limit":50}}});
