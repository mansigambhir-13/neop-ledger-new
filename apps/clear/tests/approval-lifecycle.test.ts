import {approvalLifecycle} from '@neop/testkit';
import {clearApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('clear',clearApp,fixture.master);
