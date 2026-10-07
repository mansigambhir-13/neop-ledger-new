import { timerLifecycle } from '@neop/testkit';
import { buyApp } from '../src/index.ts';
timerLifecycle('buy', buyApp);
