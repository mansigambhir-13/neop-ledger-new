import {draftSlice} from '@neop/testkit';
import {buyApp} from '../src/index.ts';
import * as data from '../src/data/drafts.repo.ts';
draftSlice({...{"id":"buy","master":"vendors","table":"orders","noun":"po","fk":"vendor_id","sample":{"amount_minor":12345,"currency":"INR","description":null}},app:buyApp,data});
