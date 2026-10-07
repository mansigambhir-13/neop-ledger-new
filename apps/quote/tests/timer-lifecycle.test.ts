import { timerLifecycle } from '@neop/testkit';
import { quoteApp } from '../src/index.ts';
timerLifecycle('quote', quoteApp);
