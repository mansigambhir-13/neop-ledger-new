import {draftOrigins} from '@neop/testkit';
import {quoteApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:quoteApp});
