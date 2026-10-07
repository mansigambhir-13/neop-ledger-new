import {draftOrigins} from '@neop/testkit';
import {rosterApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:rosterApp});
