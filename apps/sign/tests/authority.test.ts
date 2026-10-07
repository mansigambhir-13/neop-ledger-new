import {internalAuthority} from '@neop/testkit';
import {signApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('sign',signApp,fixture.master);
