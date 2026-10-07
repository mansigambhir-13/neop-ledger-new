import {draftOrigins} from '@neop/testkit';
import {postApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:postApp});
