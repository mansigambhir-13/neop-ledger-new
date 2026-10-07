import {draftOrigins} from '@neop/testkit';
import {grantApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:grantApp});
