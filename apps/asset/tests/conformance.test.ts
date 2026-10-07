import {conformance} from '@neop/testkit';
import {assetApp} from '../src/index.ts';
conformance({app:async()=>({def:await assetApp()}),reads:{"asset.assignees.list":{},"asset.requests.list":{}},gatedWrite:{"key":"asset.assignees.import","args":{"assignees":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
