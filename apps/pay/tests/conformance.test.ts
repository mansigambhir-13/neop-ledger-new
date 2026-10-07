import {conformance} from '@neop/testkit';
import {payApp} from '../src/index.ts';
conformance({app:async()=>({def:await payApp()}),reads:{'pay.settings.get':{},'pay.payees.list':{},'pay.payments.list':{}},gatedWrite:{key:'pay.settings.update',args:{currency:'INR',review_limit_minor:100000}}});
