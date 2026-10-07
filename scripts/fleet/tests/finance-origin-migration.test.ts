import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { migrateApp, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { loadFleetApp } from '../runtime/load.ts';

it.each(['pay','buy','renew'] as const)('%s: forward origin upgrade preserves legacy drafts and does not invent an original human',async app=>{
 const database=await createTestDatabase('origin_upgrade'),temp=await mkdtemp(path.join(os.tmpdir(),'neop-origin-upgrade-'));
 const admin=createPool(database.adminUrl,2),company=randomUUID(),job=randomUUID(),party=randomUUID(),draft=randomUUID();
 const table=app==='pay'?'payments':app==='buy'?'orders':'renewals',master=app==='pay'?'payees':'vendors',fk=app==='pay'?'payee_id':'vendor_id';
 let appPool:ReturnType<typeof createPool>|undefined;
 try{
  await migratePlatform(database.adminUrl);await bootstrapFamily(database.adminUrl,app);const def=await loadFleetApp(app);
  for(const [source,destination,excluded]of [[TEMPLATE_MIGRATIONS,'template','t021_draft_origin.sql'],[def.migrationsDir,'app','004_draft_origins.sql']] as const){
   const dir=path.join(temp,destination);await cp(source,dir,{recursive:true});
   const ledger=JSON.parse(await readFile(path.join(dir,'migrate.json'),'utf8'));ledger.migrations=ledger.migrations.filter((m:{file:string})=>m.file!==excluded);
   await rm(path.join(dir,excluded));await writeFile(path.join(dir,'migrate.json'),JSON.stringify(ledger));
  }
  await migrate({adminUrl:database.adminUrl,schema:app,sources:{dir:path.join(temp,'app'),prepend:await templateFiles(path.join(temp,'template'))},lintExempt:TEMPLATE_INFRA_TABLES});
  await admin.query(`insert into ${app}.settings(company_id,currency,review_limit_minor) values($1,'INR',10000)`,[company]);
  await admin.query(`insert into ${app}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Retained historical job','RUNNING')`,[job,company,`user:${randomUUID()}`]);
  await admin.query(`insert into ${app}.${master}(id,company_id,source_id,name) values($1,$2,'OLD-PARTY','Historical fixture')`,[party,company]);
  const domain=app==='pay'?",method":app==='renew'?",term":"",value=app==='pay'?",'wire'":app==='renew'?",'annual'":"";
  await admin.query(`insert into ${app}.${table}(id,company_id,source_id,${fk},amount_minor,currency,requires_elevated_approval,input_hash,source_snapshot,reference${domain}) values($1,$2,'OLD-DRAFT',$3,12345,'INR',true,$4,'{"legacy":true}','old-draft'${value})`,[draft,company,party,'a'.repeat(64)]);
  await admin.query(`insert into ${app}.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,'old-receipt',$3,'{"legacy":true}')`,[randomUUID(),company,'b'.repeat(64)]);
  const snapshot=()=>Promise.all(['settings','jobs',master,table,'write_receipts'].map(async t=>(await admin.query(`select to_jsonb(r) as row from ${app}.${t} r where company_id=$1`,[company])).rows));
  const before=await snapshot();expect((await admin.query('select to_regclass($1) t',[`${app}.draft_origins`])).rows[0].t).toBeNull();
  expect((await migrateApp(database.adminUrl,def)).map(m=>m.name)).toEqual(['t021_draft_origin.sql','004_draft_origins.sql']);
  expect(await snapshot()).toEqual(before);expect(await migrateApp(database.adminUrl,def)).toEqual([]);
  expect((await admin.query(`select * from ${app}.draft_origins`)).rows).toEqual([]);
  for(const role of [`${app}_app`,`${app}_runner`,'neos_desk'])expect((await admin.query("select has_function_privilege($1,$2,'execute') ok",[role,`${app}.capture_draft_origin()`])).rows[0].ok).toBe(false);
  expect((await admin.query("select relrowsecurity rls,relforcerowsecurity forced from pg_class where oid=$1::regclass",[`${app}.draft_origins`])).rows[0]).toEqual({rls:true,forced:true});
  appPool=createPool(roleUrl(database.adminUrl,`${app}_app`),1);
  await expect(withCompany(appPool,company,db=>db.query(`insert into ${app}.draft_origins(draft_id,company_id,job_id,proposer_user_id,basis,input_hash) values($1,$2,$3,$4,'linked_human',$5)`,[draft,company,job,randomUUID(),'a'.repeat(64)]))).rejects.toThrow(/permission denied/);
  // Legacy cancellation does not manufacture retrospective attribution either.
  await admin.query(`update ${app}.${table} set status='cancelled',cancelled_at=now(),cancel_ref='legacy-cancel' where id=$1`,[draft]);
  expect((await admin.query(`select * from ${app}.draft_origins`)).rows).toEqual([]);
 }finally{await appPool?.end();await admin.end();await database.drop();await rm(temp,{recursive:true,force:true});}
});
