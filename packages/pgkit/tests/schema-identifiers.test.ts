import {describe,expect,it} from 'vitest';
import {render,sqlIdent} from '../src/index.ts';
describe('schema identifiers and raw app identities',()=>{
 it('quotes reserved schema names without quoting role suffixes, channels or storage prefixes',()=>{
  const sql=render("grant usage on schema {{schema}} to {{schema}}_app; select * from {{schema}}.jobs; select pg_notify('neop_{{schema}}','x'); select '{{schema}}/'; select format('%I', '{{schema}}');",'grant');
  expect(sql).toBe('grant usage on schema "grant" to grant_app; select * from "grant".jobs; select pg_notify(\'neop_grant\',\'x\'); select \'grant/\'; select format(\'%I\', \'grant\');');
 });
 it('quotes search paths without changing the raw schema inside format arguments',()=>{
  expect(render('set search_path = {{schema}},pg_catalog; set search_path to {{schema}};', 'grant')).toBe('set search_path = "grant",pg_catalog; set search_path to "grant";');
 });
 it.each(['grant','ledger','clear'])('uses one valid SQL identifier for %s',name=>expect(sqlIdent(name)).toBe('"'+name+'"'));
 it.each(['grant;drop schema neos','a.b','a"b','../grant',''])('refuses an unsafe identifier %j',name=>{
  expect(()=>sqlIdent(name)).toThrow('invalid identifier');expect(()=>render('select {{schema}}.jobs',name)).toThrow();
 });
});
