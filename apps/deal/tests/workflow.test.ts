import {reviewSlice} from '@neop/testkit';
import {dealApp} from '../src/index.ts';
import * as data from '../src/data/drafts.repo.ts';
import {fixture} from './fixture.ts';
reviewSlice({...fixture,app:dealApp,data});
