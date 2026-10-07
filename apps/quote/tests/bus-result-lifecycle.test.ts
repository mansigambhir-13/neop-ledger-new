import { busResultLifecycle } from '@neop/testkit';
import { quoteApp } from '../src/index.ts';
busResultLifecycle('quote', quoteApp);
