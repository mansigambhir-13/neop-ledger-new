import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {bootstrapFamily,createPool,createTestDatabase,migrate,roleUrl,sqlIdent,templateFiles,withCompany} from '@neop/pgkit';
import {migratePlatform} from '@neop/platform';
import {migrateApp,TEMPLATE_INFRA_TABLES,TEMPLATE_MIGRATIONS} from '@neop/template';
import {loadFleetApp} from '../runtime/load.ts';

it.each(['pay','buy','renew','grant'] as const)('%s: t023 preserves populated input history and privileges',async app=>{
 const db=await createTestDatabase('input_deadline_upgrade'),temp=await mkdtemp(path.join(os.tmpdir(),'neop-input-deadline-'));
 const admin=createPool(db.adminUrl,2),co=randomUUID(),job=randomUUID(),pending=randomUUID(),old=randomUUID(),user=`user:${randomUUID()}`,s=sqlIdent(app);
 let appPool:ReturnType<typeof createPool>|undefined;
 try{
  await migratePlatform(db.adminUrl);await bootstrapFamily(db.adminUrl,app);const def=await loadFleetApp(app);
  await cp(TEMPLATE_MIGRATIONS,temp,{recursive:true});const ledger=JSON.parse(await readFile(path.join(temp,'migrate.json'),'utf8'));
  ledger.migrations=ledger.migrations.filter((m:{file:string})=>m.file!=='t023_input_deadline.sql');
  await rm(path.join(temp,'t023_input_deadline.sql'));await writeFile(path.join(temp,'migrate.json'),JSON.stringify(ledger));
  await migrate({adminUrl:db.adminUrl,schema:app,sources:{dir:def.migrationsDir,prepend:await templateFiles(temp)},lintExempt:TEMPLATE_INFRA_TABLES});
  await admin.query(`insert into ${s}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task',$3,'Historical input fixture','WAITING')`,[job,co,user]);
  const question={text:'Which fixture?',why:'Do not infer.',fields:[{key:'code',label:'Code',type:'text',required:true}]};
  for(const [id,status]of [[pending,'pending'],[old,'ready']])await admin.query(`insert into ${s}.waits(id,company_id,job_id,kind,status,expires_at,question,answered_by,answer,outcome,ready_at) values($1,$2,$3,'input',$4,clock_timestamp()+interval '1 day',$5,$6,$7,$8,case when $4='ready' then clock_timestamp() else null end)`,[id,co,job,status,question,status==='ready'?user:null,status==='ready'?{answers:{code:'historical'},trusted:true}:null,status==='ready'?'ANSWERED':null]);
  await admin.query(`insert into ${s}.facts(company_id,subject,value,source,job_id) values($1,'answer:code','"historical"','synthetic historical answer',$2)`,[co,job]);
  await admin.query(`insert into ${s}.steps(company_id,job_id,seq,kind,summary) values($1,$2,1,'system','Historical input evidence')`,[co,job]);
  await admin.query(`insert into ${s}.outbox(company_id,event_type,payload,dedupe_key) values($1,'question.answered',$2,$3)`,[co,{wait_id:old},'answered:'+old]);
  const snapshot=()=>Promise.all(['jobs','waits','facts','steps','outbox'].map(async t=>(await admin.query(`select to_jsonb(r) row from ${s}.${t} r where company_id=$1 order by id`,[co])).rows));
  const fn=`${s}.answer_wait(uuid,jsonb,text,text)`,privileges=()=>admin.query("select proacl::text acl,prosecdef,proconfig,proowner,rolbypassrls from pg_proc join pg_roles on pg_roles.oid=proowner where pg_proc.oid=$1::regprocedure",[fn]);
  const before=await snapshot(),acl=(await privileges()).rows;
  expect((await admin.query('select pg_get_functiondef($1::regprocedure) body',[fn])).rows[0].body).toContain('w.expires_at <= now()');
  expect((await migrateApp(db.adminUrl,def)).map(m=>m.name)).toEqual(['t023_input_deadline.sql']);
  expect(await snapshot()).toEqual(before);expect((await privileges()).rows).toEqual(acl);expect(acl[0].prosecdef).toBe(true);expect(acl[0].rolbypassrls).toBe(false);
  expect((await admin.query('select pg_get_functiondef($1::regprocedure) body',[fn])).rows[0].body).toContain('w.expires_at <= clock_timestamp()');
  expect(await migrateApp(db.adminUrl,def)).toEqual([]);
  for(const role of [`${app}_app`,`${app}_runner`,'neos_desk'])expect((await admin.query("select has_function_privilege($1,$2,'execute') ok",[role,fn])).rows[0].ok).toBe(true);
  appPool=createPool(roleUrl(db.adminUrl,`${app}_app`),1);
  const answer=(company:string,id=pending)=>withCompany(appPool!,company,async c=>(await c.query(`select ${s}.answer_wait($1,'{"code":"historical"}',$2,'desk') r`,[id,user])).rows[0].r);
  await expect(answer(randomUUID())).rejects.toThrow(/not_found/);
  expect(await answer(co,old)).toMatchObject({status:'answered',idempotent:true});
  await admin.query(`update ${s}.waits set expires_at=clock_timestamp()-interval '1 second' where id=$1`,[pending]);
  const expired=await snapshot();expect(await answer(co)).toMatchObject({status:'stale'});expect(await snapshot()).toEqual(expired);
 }finally{await appPool?.end();await admin.end();await db.drop();await rm(temp,{recursive:true,force:true});}
});
