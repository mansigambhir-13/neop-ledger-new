import {internalAuthority} from '@neop/testkit';
import {assetApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('asset',assetApp,fixture.master);
