import {internalAuthority} from '@neop/testkit';
import {syncApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('sync',syncApp,fixture.master);
