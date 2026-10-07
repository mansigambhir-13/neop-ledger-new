import { timerLifecycle } from '@neop/testkit';
import { syncApp } from '../src/index.ts';
timerLifecycle('sync', syncApp);
