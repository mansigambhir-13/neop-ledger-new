import { busResultLifecycle } from '@neop/testkit';
import { payApp } from '../src/index.ts';
busResultLifecycle('pay', payApp);
