import {conformance} from '@neop/testkit';
import {quoteApp} from '../src/index.ts';
conformance({app:async()=>({def:await quoteApp()}),reads:{"quote.settings.get":{},"quote.accounts.list":{},"quote.quotes.list":{}},gatedWrite:{"key":"quote.settings.update","args":{"currency":"INR"}}});
