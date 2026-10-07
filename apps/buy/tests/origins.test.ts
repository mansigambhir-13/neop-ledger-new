import {draftOrigins} from '@neop/testkit';
import {buyApp} from '../src/index.ts';
draftOrigins({...{"id":"buy","master":"vendors","table":"orders","noun":"po","fk":"vendor_id","sample":{"amount_minor":12345,"currency":"INR","description":null}},app:buyApp});
