import {approvalLifecycle} from '@neop/testkit';
import {syncApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('sync',syncApp,fixture.master);
