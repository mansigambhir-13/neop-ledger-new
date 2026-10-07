import { busQuestionLifecycle } from '@neop/testkit';
import { syncApp } from '../src/index.ts';
busQuestionLifecycle('sync', syncApp);
