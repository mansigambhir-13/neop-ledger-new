import {conformance} from '@neop/testkit';
import {shiftApp} from '../src/index.ts';
conformance({app:async()=>({def:await shiftApp()}),reads:{"shift.services.list":{},"shift.changes.list":{}},gatedWrite:{"key":"shift.services.import","args":{"services":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
