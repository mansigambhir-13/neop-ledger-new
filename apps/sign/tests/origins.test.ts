import {draftOrigins} from '@neop/testkit';
import {signApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:signApp});
