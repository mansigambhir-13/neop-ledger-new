import {approvalLifecycle} from '@neop/testkit';
import {shiftApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('shift',shiftApp,fixture.master);
