import {approvalLifecycle} from '@neop/testkit';
import {deskApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('desk',deskApp,fixture.master);
