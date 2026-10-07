import {draftSlice} from '@neop/testkit';
import {payApp} from '../src/index.ts';
import * as data from '../src/data/drafts.repo.ts';
draftSlice({...{"id":"pay","master":"payees","table":"payments","noun":"payment","fk":"payee_id","sample":{"amount_minor":12345,"currency":"INR","method":"wire","notes":null}},app:payApp,data});
