import {conformance} from '@neop/testkit';
import {rosterApp} from '../src/index.ts';
conformance({app:async()=>({def:await rosterApp()}),reads:{"roster.employees.list":{},"roster.requests.list":{}},gatedWrite:{"key":"roster.employees.import","args":{"employees":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
