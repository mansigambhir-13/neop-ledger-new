import {draftOrigins} from '@neop/testkit';
import {clearApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:clearApp});
