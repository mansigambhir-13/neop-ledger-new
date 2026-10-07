import {reviewSlice} from '@neop/testkit';
import {assetApp} from '../src/index.ts';
import * as data from '../src/data/drafts.repo.ts';
import {fixture} from './fixture.ts';
reviewSlice({...fixture,app:assetApp,data});
