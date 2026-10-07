import {approvalLifecycle} from '@neop/testkit';
import {grantApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('grant',grantApp,fixture.master);
