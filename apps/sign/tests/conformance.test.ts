import {conformance} from '@neop/testkit';
import {signApp} from '../src/index.ts';
conformance({app:async()=>({def:await signApp()}),reads:{"sign.counterparties.list":{},"sign.contracts.list":{}},gatedWrite:{"key":"sign.counterparties.import","args":{"counterparties":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
