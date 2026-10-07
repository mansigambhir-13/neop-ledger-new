import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {bootPilot,type Pilot} from '@neop/testkit';
import {payApp} from '@neop/pay';
import {buyApp} from '@neop/buy';
import {renewApp} from '@neop/renew';
let P:Pilot;
const apps=['pay','buy','renew'] as const;
beforeAll(async()=>{P=await bootPilot({apps:await Promise.all([payApp,buyApp,renewApp].map(async load=>({def:await load()})))});});
afterAll(async()=>{await P?.close();});
describe('three finance NEOPs in one PostgreSQL',()=>{
 it('gives each real app role access only to its own schema',async()=>{
  for(const app of apps){
   const core=P.backends[app]!.core;
   await expect(core.company(P.company.id,db=>db.query(`select * from ${app}.settings`))).resolves.toBeDefined();
   for(const other of apps.filter(a=>a!==app))await expect(core.company(P.company.id,db=>db.query(`select * from ${other}.settings`))).rejects.toThrow(/permission denied/);
  }
 });
 it('keeps each schema and declared read distinct for the same company',async()=>{
  const currencies={pay:'INR',buy:'USD',renew:'EUR'};
  for(const app of apps)await P.backends[app]!.core.company(P.company.id,db=>db.query(`insert into ${app}.settings(company_id,currency) values($1,$2)`,[P.company.id,currencies[app]]));
  for(const app of apps){const r=await P.read(`${app}.settings.get`,{},{app});expect(r.status).toBe(200);expect(r.body.result.rows).toEqual([{currency:currencies[app],review_limit_minor:null}]);}
 });
});
