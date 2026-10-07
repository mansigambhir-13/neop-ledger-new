import {approvalLifecycle} from '@neop/testkit';
import {rosterApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('roster',rosterApp,fixture.master);
