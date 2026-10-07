import {internalAuthority} from '@neop/testkit';
import {guardApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('guard',guardApp,fixture.master);
