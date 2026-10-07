import {approvalLifecycle} from '@neop/testkit';
import {renewApp} from '../src/index.ts';
approvalLifecycle('renew',renewApp,'vendors');
