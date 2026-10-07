import { timerLifecycle } from '@neop/testkit';
import { guardApp } from '../src/index.ts';
timerLifecycle('guard', guardApp);
