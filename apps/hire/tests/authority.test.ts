import {internalAuthority} from '@neop/testkit';
import {hireApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('hire',hireApp,fixture.master);
