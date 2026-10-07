import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, sqlIdent, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { migrateApp, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { loadFleetApp } from '../runtime/load.ts';

const apps=['clear','reach','desk','hire','deal','grant','shift','sync','post','roster','quote','sign','guard','vet','asset'] as const;
it.each(apps)('%s: app-only origin upgrade preserves populated drafts without guessed attribution',async app=>{
 const database=await createTestDatabase('review_origin_upgrade'),temp=await mkdtemp(path.join(os.tmpdir(),'neop-review-origin-upgrade-'));
 const admin=createPool(database.adminUrl,2),company=randomUUID(),job=randomUUID(),s=sqlIdent(app);
 let appPool:ReturnType<typeof createPool>|undefined;
 try{
  await migratePlatform(database.adminUrl);await bootstrapFamily(database.adminUrl,app);const def=await loadFleetApp(app);
  const {fixture:f}=await import(`../../../apps/${app}/tests/fixture.ts`);
  const repo=await import(`../../../apps/${app}/src/data/drafts.repo.ts`);
  // Recreate the prior app schema with the already released shared template intact.
  const dir=path.join(temp,'app');await cp(def.migrationsDir,dir,{recursive:true});
  const ledger=JSON.parse(await readFile(path.join(dir,'migrate.json'),'utf8'));
  ledger.migrations=ledger.migrations.filter((m:{file:string})=>m.file!=='004_draft_origins.sql');
  await rm(path.join(dir,'004_draft_origins.sql'));await writeFile(path.join(dir,'migrate.json'),JSON.stringify(ledger));
  await migrate({adminUrl:database.adminUrl,schema:app,sources:{dir,prepend:await templateFiles(TEMPLATE_MIGRATIONS)},lintExempt:TEMPLATE_INFRA_TABLES});
  appPool=createPool(roleUrl(database.adminUrl,`${app}_app`),1);
  await admin.query(`insert into ${s}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Historical synthetic job','RUNNING')`,[job,company,`user:${randomUUID()}`]);
  const draft=await withCompany(appPool,company,async db=>{
   if(f.settings)await repo.configure(db,company,f.settings);
   await repo.importParties(db,company,[{source_id:'OLD-PARTY',name:'Historical fixture',category:null}]);
   const party=(await db.query(`select id from ${s}.${sqlIdent(f.master)} where company_id=$1`,[company])).rows[0].id;
   const args={...f.sample,source_id:'OLD-DRAFT',[f.fk]:party};
   const result=await repo.prepareDraft(db,company,args,'old-draft');
   await repo.saveReceipt(db,company,'old-draft',{ability:`${app}.${f.noun}.prepare`,args},result);
   return result;
  });
  const snapshot=()=>Promise.all([...(f.settings?['settings']:[]),'jobs',f.master,f.table,'write_receipts'].map(async t=>(await admin.query(`select to_jsonb(r) as row from ${s}.${sqlIdent(t)} r where company_id=$1`,[company])).rows));
  const before=await snapshot();expect((await admin.query('select to_regclass($1) t',[`${s}.draft_origins`])).rows[0].t).toBeNull();
  expect((await migrateApp(database.adminUrl,def)).map(m=>m.name)).toEqual(['004_draft_origins.sql']);
  expect(await snapshot()).toEqual(before);expect(await migrateApp(database.adminUrl,def)).toEqual([]);
  expect((await admin.query(`select * from ${s}.draft_origins`)).rows).toEqual([]);
  for(const role of [`${app}_app`,`${app}_runner`,'neos_desk'])expect((await admin.query("select has_function_privilege($1,$2,'execute') ok",[role,`${s}.capture_draft_origin()`])).rows[0].ok).toBe(false);
  expect((await admin.query('select relrowsecurity rls,relforcerowsecurity forced from pg_class where oid=$1::regclass',[`${s}.draft_origins`])).rows[0]).toEqual({rls:true,forced:true});
  await expect(withCompany(appPool,company,db=>db.query(`insert into ${s}.draft_origins(draft_id,company_id,job_id,proposer_user_id,basis,input_hash) values($1,$2,$3,$4,'linked_human',$5)`,[draft.id,company,job,randomUUID(),draft.input_hash]))).rejects.toThrow(/permission denied/);
  // Domain-level historical cancellation still works, without retrospective attribution.
  await withCompany(appPool,company,db=>repo.cancel(db,company,{id:draft.id,input_hash:draft.input_hash},'legacy-cancel'));
  expect((await admin.query(`select * from ${s}.draft_origins`)).rows).toEqual([]);
 }finally{await appPool?.end();await admin.end();await database.drop();await rm(temp,{recursive:true,force:true});}
});
