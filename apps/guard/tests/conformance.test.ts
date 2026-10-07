import {conformance} from '@neop/testkit';
import {guardApp} from '../src/index.ts';
conformance({app:async()=>({def:await guardApp()}),reads:{"guard.assets.list":{},"guard.incidents.list":{}},gatedWrite:{"key":"guard.assets.import","args":{"assets":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
