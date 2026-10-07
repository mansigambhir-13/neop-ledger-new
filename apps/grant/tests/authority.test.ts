import {internalAuthority} from '@neop/testkit';
import {grantApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('grant',grantApp,fixture.master);
