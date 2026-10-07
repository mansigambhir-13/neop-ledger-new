import { busResultLifecycle } from '@neop/testkit';
import { renewApp } from '../src/index.ts';
busResultLifecycle('renew', renewApp);
