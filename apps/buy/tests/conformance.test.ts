import {conformance} from '@neop/testkit';
import {buyApp} from '../src/index.ts';
conformance({app:async()=>({def:await buyApp()}),reads:{'buy.settings.get':{},'buy.vendors.list':{},'buy.orders.list':{}},gatedWrite:{key:'buy.settings.update',args:{currency:'INR',review_limit_minor:100000}}});
