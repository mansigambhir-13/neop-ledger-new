import {conformance} from '@neop/testkit';
import {grantApp} from '../src/index.ts';
conformance({app:async()=>({def:await grantApp()}),reads:{"grant.requestors.list":{},"grant.requests.list":{}},gatedWrite:{"key":"grant.requestors.import","args":{"requestors":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
