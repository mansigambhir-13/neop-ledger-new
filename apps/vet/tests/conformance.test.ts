import {conformance} from '@neop/testkit';
import {vetApp} from '../src/index.ts';
conformance({app:async()=>({def:await vetApp()}),reads:{"vet.suppliers.list":{},"vet.onboardings.list":{}},gatedWrite:{"key":"vet.suppliers.import","args":{"suppliers":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
