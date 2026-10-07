import { timerLifecycle } from '@neop/testkit';
import { renewApp } from '../src/index.ts';
timerLifecycle('renew', renewApp);
