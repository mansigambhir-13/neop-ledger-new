import { busResultLifecycle } from '@neop/testkit';
import { syncApp } from '../src/index.ts';
busResultLifecycle('sync', syncApp);
