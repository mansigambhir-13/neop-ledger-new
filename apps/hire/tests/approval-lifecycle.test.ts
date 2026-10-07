import {approvalLifecycle} from '@neop/testkit';
import {hireApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('hire',hireApp,fixture.master);
