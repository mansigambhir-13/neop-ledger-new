import { timerLifecycle } from '@neop/testkit';
import { postApp } from '../src/index.ts';
timerLifecycle('post', postApp);
