import {internalAuthority} from '@neop/testkit';
import {dealApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('deal',dealApp,fixture.master);
