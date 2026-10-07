import {internalAuthority} from '@neop/testkit';
import {postApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('post',postApp,fixture.master);
