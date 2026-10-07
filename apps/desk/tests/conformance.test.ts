import {conformance} from '@neop/testkit';
import {deskApp} from '../src/index.ts';
conformance({app:async()=>({def:await deskApp()}),reads:{"desk.settings.get":{},"desk.tickets.list":{},"desk.refunds.list":{}},gatedWrite:{"key":"desk.settings.update","args":{"currency":"INR","review_limit_minor":10000}}});
