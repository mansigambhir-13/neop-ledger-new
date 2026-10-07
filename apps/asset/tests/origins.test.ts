import {draftOrigins} from '@neop/testkit';
import {assetApp} from '../src/index.ts';
import {fixture} from './fixture.ts';
draftOrigins({...fixture,app:assetApp});
