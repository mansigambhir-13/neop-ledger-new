import {approvalLifecycle} from '@neop/testkit';
import {guardApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('guard',guardApp,fixture.master);
