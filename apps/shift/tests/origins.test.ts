import {draftOrigins} from '@neop/testkit';
import {shiftApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:shiftApp});
