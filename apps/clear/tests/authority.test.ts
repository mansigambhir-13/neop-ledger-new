import {internalAuthority} from '@neop/testkit';
import {clearApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('clear',clearApp,fixture.master);
