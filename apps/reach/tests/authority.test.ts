import {internalAuthority} from '@neop/testkit';
import {reachApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('reach',reachApp,fixture.master);
