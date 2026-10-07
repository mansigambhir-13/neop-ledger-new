import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {bootPilot,type Pilot} from '@neop/testkit';
import {sqlIdent} from '@neop/pgkit';
import {assetApp} from '@neop/asset';
import {buyApp} from '@neop/buy';
import {clearApp} from '@neop/clear';
import {dealApp} from '@neop/deal';
import {deskApp} from '@neop/desk';
import {grantApp} from '@neop/grant';
import {guardApp} from '@neop/guard';
import {hireApp} from '@neop/hire';
import {payApp} from '@neop/pay';
import {postApp} from '@neop/post';
import {quoteApp} from '@neop/quote';
import {reachApp} from '@neop/reach';
import {renewApp} from '@neop/renew';
import {rosterApp} from '@neop/roster';
import {shiftApp} from '@neop/shift';
import {signApp} from '@neop/sign';
import {syncApp} from '@neop/sync';
import {vetApp} from '@neop/vet';
const loaders=[assetApp,buyApp,clearApp,dealApp,deskApp,grantApp,guardApp,hireApp,payApp,postApp,quoteApp,reachApp,renewApp,rosterApp,shiftApp,signApp,syncApp,vetApp];
let P:Pilot;
beforeAll(async()=>{P=await bootPilot({apps:await Promise.all(loaders.map(async load=>({def:await load()})))});});
afterAll(async()=>{await P?.close();});
describe('eighteen rebuilt NEOPs on one PostgreSQL',()=>{
 it('enforces every directed app-to-app schema denial (306 pairs)',async()=>{
  const apps=Object.keys(P.backends);expect(apps).toHaveLength(18);let denied=0;
  for(const app of apps){
   const core=P.backends[app]!.core;
   const home=await core.appPool.query('select current_schema() as schema');expect(home.rows[0].schema).toBe(app);
   await expect(core.appPool.query('select * from write_receipts')).resolves.toBeDefined();
   await expect(core.company(P.company.id,db=>db.query(`select * from ${sqlIdent(app)}.write_receipts`))).resolves.toBeDefined();
   for(const other of apps.filter(x=>x!==app)){
    await expect(core.company(P.company.id,db=>db.query(`select * from ${sqlIdent(other)}.write_receipts`))).rejects.toThrow(/permission denied/);denied++;
   }
   await expect(core.company(P.company.id,db=>db.query(`create table ${sqlIdent(app)}.unauthorized_ddl(id uuid)`))).rejects.toThrow(/permission denied/);
   await expect(core.company(P.company.id,db=>db.query('set local role neos_desk'))).rejects.toThrow(/permission denied/);
  }
  expect(denied).toBe(306);
 });
 it('keeps app identities unquoted while every registered read stays honest and company-scoped',async()=>{
  for(const [app,backend] of Object.entries(P.backends)){
   expect(backend.core.key).toBe(app);
   expect(backend.core.manifest.doors).toEqual([]);
   for(const ability of backend.core.manifest.abilities.filter(a=>a.kind==='read')){
    const r=await P.read(ability.key,{}, {app});expect(r.status,JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({empty:true,rows:[],next_offset:null});
    expect(backend.core.validators.checkOutput(ability.key,r.body.result)).toBeNull();
    const ui=await P.api('POST',`/api/apps/${app}/read/${ability.key}`,{});
    expect(ui.status,JSON.stringify(ui.body)).toBe(200);expect(ui.body.result.rows).toEqual([]);
   }
  }
 });
});
