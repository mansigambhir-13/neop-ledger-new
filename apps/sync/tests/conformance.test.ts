import {conformance} from '@neop/testkit';
import {syncApp} from '../src/index.ts';
conformance({app:async()=>({def:await syncApp()}),reads:{"sync.datasets.list":{},"sync.exports.list":{}},gatedWrite:{"key":"sync.datasets.import","args":{"datasets":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
