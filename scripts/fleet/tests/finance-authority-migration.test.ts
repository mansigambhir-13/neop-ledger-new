import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { migrateApp, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { loadFleetApp } from '../runtime/load.ts';

it.each(['pay','buy','renew'] as const)('%s: t020 applies forward on populated data without changing records or granting broad privileges', async app => {
  const database=await createTestDatabase('authority_upgrade'), temp=await mkdtemp(path.join(os.tmpdir(),'neop-t020-'));
  const admin=createPool(database.adminUrl,2), company=randomUUID(), job=randomUUID(), proposal=randomUUID();
  let appPool:ReturnType<typeof createPool>|undefined;
  try {
    await migratePlatform(database.adminUrl); await bootstrapFamily(database.adminUrl,app);
    const def=await loadFleetApp(app);
    await cp(TEMPLATE_MIGRATIONS,temp,{recursive:true});
    const ledger=JSON.parse(await readFile(path.join(temp,'migrate.json'),'utf8'));
    ledger.migrations=ledger.migrations.filter((m:{file:string})=>m.file!=='t020_human_authority.sql');
    await rm(path.join(temp,'t020_human_authority.sql')); await writeFile(path.join(temp,'migrate.json'),JSON.stringify(ledger));
    await migrate({adminUrl:database.adminUrl,schema:app,sources:{dir:def.migrationsDir,prepend:await templateFiles(temp)},lintExempt:TEMPLATE_INFRA_TABLES});
    await admin.query(`insert into ${app}.settings(company_id,currency,review_limit_minor) values($1,'INR',12345)`,[company]);
    await admin.query(`insert into ${app}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Old retained job','WAITING')`,[job,company,`user:${randomUUID()}`]);
    await admin.query(`insert into ${app}.proposals(id,company_id,job_id,ability_key,ability_version,args,card,fingerprint,status,expires_at,idempotency_key) values($1,$2,$3,$4,'1.0.0','{}','{}','sha256:'||repeat('a',64),'PROPOSED',now()+interval '1 day',$5)`,[proposal,company,job,`${app}.settings.update`,randomUUID()]);
    await admin.query(`insert into ${app}.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,'legacy-receipt',$3,'{"legacy":true}')`,[randomUUID(),company,'a'.repeat(64)]);
    const snapshot=async()=>Promise.all(['settings','jobs','proposals','write_receipts'].map(async table=>(await admin.query(`select to_jsonb(t) as row from ${app}.${table} t where company_id=$1`,[company])).rows));
    const before=await snapshot();
    expect((await admin.query('select to_regprocedure($1) as f',[`${app}.check_human_authority(uuid,text,text,jsonb)`])).rows[0].f).toBeNull();
    expect((await migrateApp(database.adminUrl,def)).map(m=>m.name)).toEqual(['t020_human_authority.sql']);
    expect(await snapshot()).toEqual(before); expect(await migrateApp(database.adminUrl,def)).toEqual([]);
    const functionName=`${app}.check_human_authority(uuid,text,text,jsonb)`;
    for(const [role,allowed] of [[`${app}_app`,true],[`${app}_runner`,false],['neos_desk',false]] as const) {
      expect((await admin.query('select has_function_privilege($1,$2,\'execute\') as ok',[role,functionName])).rows[0].ok).toBe(allowed);
    }
    appPool=createPool(roleUrl(database.adminUrl,`${app}_app`),1);
    await expect(appPool.query(`select ${app}.check_human_authority($1,$2,$3,'{}')`,[job,'legacy-receipt',`${app}.settings.update`])).rejects.toThrow(/authority_required/);
    await expect(withCompany(appPool,randomUUID(),db=>db.query(`select ${app}.check_human_authority($1,$2,$3,'{}')`,[job,'legacy-receipt',`${app}.settings.update`]))).rejects.toThrow(/authority_install/);
    await expect(withCompany(appPool,company,db=>db.query(`update ${app}.people set role='admin'`))).rejects.toThrow(/permission denied/);
  } finally {
    await appPool?.end(); await admin.end(); await database.drop(); await rm(temp,{recursive:true,force:true});
  }
});
