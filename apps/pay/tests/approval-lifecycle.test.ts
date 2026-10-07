import {approvalLifecycle} from '@neop/testkit';
import {payApp} from '../src/index.ts';
approvalLifecycle('pay',payApp,'payees');
