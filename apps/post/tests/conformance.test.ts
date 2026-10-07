import {conformance} from '@neop/testkit';
import {postApp} from '../src/index.ts';
conformance({app:async()=>({def:await postApp()}),reads:{"post.channels.list":{},"post.posts.list":{}},gatedWrite:{"key":"post.channels.import","args":{"channels":[{"source_id":"CONFORMANCE","name":"Reviewed source record","category":null}]}}});
