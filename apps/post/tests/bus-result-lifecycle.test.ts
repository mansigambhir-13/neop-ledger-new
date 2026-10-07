import { busResultLifecycle } from '@neop/testkit';
import { postApp } from '../src/index.ts';
busResultLifecycle('post', postApp);
