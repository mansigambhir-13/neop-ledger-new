import {draftOrigins} from '@neop/testkit';
import {syncApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:syncApp});
