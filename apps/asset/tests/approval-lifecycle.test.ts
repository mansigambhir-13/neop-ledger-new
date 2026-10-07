import {approvalLifecycle} from '@neop/testkit';
import {assetApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
approvalLifecycle('asset',assetApp,fixture.master);
