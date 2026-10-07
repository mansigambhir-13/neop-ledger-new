import {internalAuthority} from '@neop/testkit';
import {deskApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('desk',deskApp,fixture.master);
