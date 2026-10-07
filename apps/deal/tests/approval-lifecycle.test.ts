import {approvalLifecycle} from '@neop/testkit';
import {dealApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('deal',dealApp,fixture.master);
