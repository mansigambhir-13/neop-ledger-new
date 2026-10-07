import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {bootstrapFamily,createPool,createTestDatabase,migrate,roleUrl,sqlIdent,templateFiles,withCompany} from '@neop/pgkit';
import {migratePlatform} from '@neop/platform';
import {migrateApp,TEMPLATE_INFRA_TABLES,TEMPLATE_MIGRATIONS} from '@neop/template';
import {loadFleetApp} from '../runtime/load.ts';

it.each(['pay','buy','renew','grant'] as const)('%s: t022 preserves populated answer history and privileges while replacing the deadline check',async app=>{
 const db=await createTestDatabase('answer_deadline_upgrade'),temp=await mkdtemp(path.join(os.tmpdir(),'neop-answer-deadline-'));
 const admin=createPool(db.adminUrl,2),co=randomUUID(),job=randomUUID(),pending=randomUUID(),old=randomUUID(),user=`user:${randomUUID()}`,s=sqlIdent(app);
 let appPool:ReturnType<typeof createPool>|undefined;
 try{
  await migratePlatform(db.adminUrl);await bootstrapFamily(db.adminUrl,app);const def=await loadFleetApp(app);
  await cp(TEMPLATE_MIGRATIONS,temp,{recursive:true});const ledger=JSON.parse(await readFile(path.join(temp,'migrate.json'),'utf8'));
  ledger.migrations=ledger.migrations.filter((m:{file:string})=>m.file!=='t022_answer_deadline.sql');
  await rm(path.join(temp,'t022_answer_deadline.sql'));await writeFile(path.join(temp,'migrate.json'),JSON.stringify(ledger));
  await migrate({adminUrl:db.adminUrl,schema:app,sources:{dir:def.migrationsDir,prepend:await templateFiles(temp)},lintExempt:TEMPLATE_INFRA_TABLES});
  const ability=def.manifest.abilities.find(a=>a.key.endsWith('.import'))!;
  await admin.query(`insert into ${s}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Historical synthetic review','WAITING')`,[job,co,user]);
  for(const [id,status]of [[pending,'PROPOSED'],[old,'REJECTED']])await admin.query(`insert into ${s}.proposals(id,company_id,job_id,ability_key,ability_version,args,card,fingerprint,status,expires_at,idempotency_key,decided_by,answered_at) values($1,$2,$3,$4,$5,'{}','{}','sha256:'||repeat('a',64),$6,clock_timestamp()+interval '1 day',$7,$8,$9)`,[id,co,job,ability.key,ability.version,status,randomUUID(),status==='REJECTED'?user:null,status==='REJECTED'?new Date():null]);
  await admin.query(`insert into ${s}.waits(company_id,job_id,kind,ref_id,expires_at) values($1,$2,'proposal',$3,clock_timestamp()+interval '1 day')`,[co,job,pending]);
  await admin.query(`insert into ${s}.proposal_events(company_id,proposal_id,event,actor,fingerprint_seen) values($1,$2,'answered:no',$3,'sha256:'||repeat('a',64))`,[co,old,user]);
  await admin.query(`insert into ${s}.write_receipts(id,company_id,reference,request_hash,result) values($1,$2,'retained-history',$3,'{"internal":true}')`,[randomUUID(),co,'a'.repeat(64)]);
  const snapshot=()=>Promise.all(['jobs','proposals','waits','proposal_events','write_receipts'].map(async t=>(await admin.query(`select to_jsonb(r) as row from ${s}.${t} r where company_id=$1 order by id`,[co])).rows));
  const fn=`${s}.answer_proposal(uuid,text,text,text,text,text[])`,privileges=()=>admin.query("select proacl::text acl,prosecdef,proconfig,rolbypassrls from pg_proc join pg_roles on pg_roles.oid=proowner where pg_proc.oid=$1::regprocedure",[fn]);
  const before=await snapshot(),acl=(await privileges()).rows;
  expect((await admin.query('select pg_get_functiondef($1::regprocedure) body',[fn])).rows[0].body).toContain('p.expires_at <= now()');
  expect((await migrateApp(db.adminUrl,def)).map(m=>m.name)).toEqual(['t022_answer_deadline.sql']);
  expect(await snapshot()).toEqual(before);expect((await privileges()).rows).toEqual(acl);expect(acl[0].prosecdef).toBe(true);expect(acl[0].rolbypassrls).toBe(false);
  expect((await admin.query('select pg_get_functiondef($1::regprocedure) body',[fn])).rows[0].body).toContain('p.expires_at <= clock_timestamp()');
  expect(await migrateApp(db.adminUrl,def)).toEqual([]);
  for(const role of [`${app}_app`,`${app}_runner`,'neos_desk'])expect((await admin.query("select has_function_privilege($1,$2,'execute') ok",[role,fn])).rows[0].ok).toBe(true);
  appPool=createPool(roleUrl(db.adminUrl,`${app}_app`),1);
  await expect(withCompany(appPool,randomUUID(),c=>c.query(`select ${s}.answer_proposal($1,$2,'yes',$3,null,array['admin'])`,[pending,'sha256:'+'a'.repeat(64),user]))).rejects.toThrow(/not_found/);
  await admin.query(`update ${s}.proposals set expires_at=clock_timestamp()-interval '1 second' where id=$1`,[pending]);
  await expect(withCompany(appPool,co,c=>c.query(`select ${s}.answer_proposal($1,$2,'yes',$3,null,array['admin'])`,[pending,'sha256:'+'a'.repeat(64),user]))).rejects.toThrow(/expired/);
  expect((await admin.query(`select status from ${s}.proposals where id=$1`,[pending])).rows[0].status).toBe('PROPOSED');
 }finally{await appPool?.end();await admin.end();await db.drop();await rm(temp,{recursive:true,force:true});}
});
