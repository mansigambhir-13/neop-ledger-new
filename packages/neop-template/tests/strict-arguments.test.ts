import {describe,expect,it} from 'vitest';
import {strictToolArguments} from '../src/agent/arguments.ts';
const prepare=strictToolArguments({type:'object',additionalProperties:false,properties:{signal:{type:['boolean','null']},amount:{type:'integer',minimum:0},notes:{type:['string','null']}},required:['signal','amount','notes']});
describe('original model argument boundary',()=>{
 it.each(['false','true',0,1,'',undefined])('does not reinterpret %j as boolean evidence',signal=>{
  expect(()=>prepare({signal,amount:0,notes:null})).toThrow('Invalid tool arguments');
 });
 it.each(['123','',null,1.5])('does not reinterpret %j as integer units',amount=>{
  expect(()=>prepare({signal:null,amount,notes:null})).toThrow('Invalid tool arguments');
 });
 it('preserves false, zero and unknown as distinct values and does not mutate the original',()=>{
  const original={signal:null,amount:0,notes:null};const copy=prepare(original) as typeof original;
  expect(copy).toEqual(original);expect(copy).not.toBe(original);copy.signal=false as any;
  expect(original.signal).toBeNull();expect(prepare({signal:false,amount:0,notes:null})).toEqual({signal:false,amount:0,notes:null});
 });
 it('refuses undeclared authority or status',()=>{
  expect(()=>prepare({signal:false,amount:0,notes:null,actor:'admin',status:'approved'})).toThrow();
 });
 it('reuses only identical contracts and preserves validation after bounded-cache eviction',()=>{
  const schema={type:'object',additionalProperties:false,properties:{x:{type:'integer'}},required:['x']};
  const first=strictToolArguments(schema);expect(strictToolArguments(structuredClone(schema))).toBe(first);
  for(let n=0;n<270;n++)strictToolArguments({type:'integer',minimum:n});
  const after=strictToolArguments(schema);expect(()=>after({x:'1'})).toThrow();expect(after({x:1})).toEqual({x:1});
  expect(()=>first({x:'1'})).toThrow();
 });
});
