import {approvalLifecycle} from '@neop/testkit';
import {postApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('post',postApp,fixture.master);
