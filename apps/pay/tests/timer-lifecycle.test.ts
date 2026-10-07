import { timerLifecycle } from '@neop/testkit';
import { payApp } from '../src/index.ts';
timerLifecycle('pay', payApp);
