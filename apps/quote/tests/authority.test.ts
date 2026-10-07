import {internalAuthority} from '@neop/testkit';
import {quoteApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
internalAuthority('quote',quoteApp,fixture.master);
