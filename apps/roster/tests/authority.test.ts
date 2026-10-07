import {internalAuthority} from '@neop/testkit';
import {rosterApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('roster',rosterApp,fixture.master);
