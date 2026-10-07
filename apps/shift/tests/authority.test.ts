import {internalAuthority} from '@neop/testkit';
import {shiftApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('shift',shiftApp,fixture.master);
