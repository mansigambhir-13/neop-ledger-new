import {conformance} from '@neop/testkit';
import {renewApp} from '../src/index.ts';
conformance({app:async()=>({def:await renewApp()}),reads:{'renew.settings.get':{},'renew.vendors.list':{},'renew.renewals.list':{}},gatedWrite:{key:'renew.settings.update',args:{currency:'INR',review_limit_minor:100000}}});
