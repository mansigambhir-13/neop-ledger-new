import {describe,expect,it} from 'vitest';
import {integer,currency,nullable,uuid,oneOf,distinct,MAX_MINOR} from '../src/index.ts';
describe('V3 domain value boundaries',()=>{
 it.each([-1,0.1,NaN,Infinity,MAX_MINOR+1,Number.MAX_SAFE_INTEGER])('rejects non-integer or unsafe amount %s',value=>expect(()=>integer(value,'amount')).toThrow());
 it.each([0,1,MAX_MINOR])('keeps an exact bounded integer %s',value=>expect(integer(value,'amount')).toBe(value));
 it('does not coerce numeric strings or unknown amounts',()=>{expect(()=>integer('1' as any,'amount')).toThrow();expect(()=>integer(null as any,'amount')).toThrow();});
 it.each(['inr','', 'N/A','IN','INRR'])('refuses malformed currency %s',value=>expect(()=>currency(value)).toThrow());
 it('keeps explicit nulls and rejects fake unknowns',()=>{expect(nullable(null,'notes')).toBeNull();expect(()=>nullable('','notes')).toThrow();expect(()=>nullable(undefined as any,'notes')).toThrow();});
 it('bounds identifiers, enum states and duplicate batches',()=>{expect(()=>uuid('legacy-id')).toThrow();expect(()=>oneOf('paid',['draft','cancelled'],'state')).toThrow();expect(()=>distinct(['same','same'])).toThrow();});
});
