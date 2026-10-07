import {draftOrigins} from '@neop/testkit';
import {renewApp} from '../src/index.ts';
draftOrigins({...{"id":"renew","master":"vendors","table":"renewals","noun":"renewal","fk":"vendor_id","sample":{"amount_minor":12345,"currency":"INR","term":"multiyear","notes":null}},app:renewApp});
