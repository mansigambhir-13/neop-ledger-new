import {approvalLifecycle} from '@neop/testkit';
import {signApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('sign',signApp,fixture.master);
