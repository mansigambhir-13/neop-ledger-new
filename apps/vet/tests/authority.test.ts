import {internalAuthority} from '@neop/testkit';
import {vetApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('vet',vetApp,fixture.master);
