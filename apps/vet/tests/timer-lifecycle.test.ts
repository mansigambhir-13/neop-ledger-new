import { timerLifecycle } from '@neop/testkit';
import { vetApp } from '../src/index.ts';
timerLifecycle('vet', vetApp);
