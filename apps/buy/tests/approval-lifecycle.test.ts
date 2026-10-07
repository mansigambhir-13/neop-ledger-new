import {approvalLifecycle} from '@neop/testkit';
import {buyApp} from '../src/index.ts';
approvalLifecycle('buy',buyApp,'vendors');
