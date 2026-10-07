import {draftOrigins} from '@neop/testkit';
import {hireApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:hireApp});
