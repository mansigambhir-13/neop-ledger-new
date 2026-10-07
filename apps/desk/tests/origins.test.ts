import {draftOrigins} from '@neop/testkit';
import {deskApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:deskApp});
