import { timerLifecycle } from '@neop/testkit';
import { signApp } from '../src/index.ts';
timerLifecycle('sign', signApp);
