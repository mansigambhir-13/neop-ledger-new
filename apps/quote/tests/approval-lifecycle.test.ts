import {approvalLifecycle} from '@neop/testkit';
import {quoteApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('quote',quoteApp,fixture.master);
