import {approvalLifecycle} from '@neop/testkit';
import {reachApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('reach',reachApp,fixture.master);
