import {draftOrigins} from '@neop/testkit';
import {guardApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:guardApp});
