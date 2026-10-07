import {draftOrigins} from '@neop/testkit';
import {dealApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:dealApp});
