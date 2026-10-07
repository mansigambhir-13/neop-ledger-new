import {draftOrigins} from '@neop/testkit';
import {reachApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:reachApp});
