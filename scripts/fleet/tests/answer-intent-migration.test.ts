import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, sqlIdent, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { migrateApp, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { loadFleetApp } from '../runtime/load.ts';

it.each(['pay','buy','renew','grant'] as const)('%s: t024 preserves historical books and scopes immutable answer intents', async app => {
  const db = await createTestDatabase('answer_intent_upgrade'), temp = await mkdtemp(path.join(os.tmpdir(),'neop-answer-intent-'));
  const admin = createPool(db.adminUrl,2), co = randomUUID(), job = randomUUID(), thread = randomUUID(), wait = randomUUID(), s = sqlIdent(app);
  let appPool: ReturnType<typeof createPool> | undefined;
  try {
    await migratePlatform(db.adminUrl); await bootstrapFamily(db.adminUrl, app); const def = await loadFleetApp(app);
    await cp(TEMPLATE_MIGRATIONS, temp, { recursive: true });
    const ledger = JSON.parse(await readFile(path.join(temp,'migrate.json'),'utf8'));
    ledger.migrations = ledger.migrations.filter((m: {file:string}) => m.file !== 't024_answer_intents.sql');
    await rm(path.join(temp,'t024_answer_intents.sql')); await writeFile(path.join(temp,'migrate.json'), JSON.stringify(ledger));
    await migrate({ adminUrl: db.adminUrl, schema: app, sources: { dir: def.migrationsDir, prepend: await templateFiles(temp) }, lintExempt: TEMPLATE_INFRA_TABLES });
    await admin.query(`insert into ${s}.jobs(id,company_id,source,requester,ask,status) values($1,$2,'task','user:fixture','Historical answer fixture','WAITING')`, [job,co]);
    await admin.query(`insert into ${s}.waits(id,company_id,job_id,kind,ref_id,status,expires_at) values($1,$2,$3,'a2a_task',$4,'pending',now()+interval '1 day')`, [wait,co,job,thread]);
    await admin.query(`insert into ${s}.bus_threads(id,company_id,job_id,direction,kind,room_id,peer,peer_app,root_event_id,wait_id,question)
      values($1,$2,$3,'out','task','!room:fixture','@peer:fixture','fixture','$root',$4,$5)`, [thread,co,job,wait,{ wait_id:'historical-question', question:{text:'Never infer historical answers'} }]);
    await admin.query(`insert into ${s}.outbound_events(company_id,account,room_id,key,event_id,kind) values($1,'@app:fixture','!room:fixture',$2,'$historical','bus:answer')`, [co,`bus:answer:${thread}:historical-question`]);
    const snapshot = () => Promise.all(['jobs','waits','bus_threads','outbound_events'].map(async table =>
      (await admin.query(`select to_jsonb(r)-'answer_protocol' row from ${s}.${table} r where company_id=$1 order by id`, [co])).rows));
    const before = await snapshot();
    expect((await migrateApp(db.adminUrl,def)).map(m => m.name)).toEqual(['t024_answer_intents.sql']);
    expect(await snapshot()).toEqual(before); expect(await migrateApp(db.adminUrl,def)).toEqual([]);
    expect((await admin.query(`select answer_protocol from ${s}.bus_threads where id=$1`, [thread])).rows[0].answer_protocol).toBe(0);
    expect((await admin.query(`select * from ${s}.bus_answer_intents`)).rows).toEqual([]);
    appPool = createPool(roleUrl(db.adminUrl, `${app}_app`), 1);
    const scoped = (company: string, sql: string, args: unknown[] = []) => withCompany(appPool!,company,c => c.query(sql,args));
    const insert = `insert into ${s}.bus_answer_intents(company_id,job_id,thread_id,question_wait_id,return_wait_id,account,room_id,peer,root_event_id,answers)
      values($1,$2,$3,$4,$5,'@app:fixture','!room:fixture','@peer:fixture','$root','{"value":"fixture"}') returning id`;
    // Low-level table tests do not authorize historical replay: the gate separately refuses protocol 0.
    const intent = (await scoped(co, insert, [co,job,thread,'fixture-intent',wait])).rows[0].id;
    expect((await scoped(randomUUID(),`select * from ${s}.bus_answer_intents`)).rows).toEqual([]);
    await expect(scoped(randomUUID(),insert,[co,job,thread,'foreign',randomUUID()])).rejects.toThrow(/row-level security/);
    for (const args of [[co,randomUUID(),thread,'wrong-job',randomUUID()],[co,job,randomUUID(),'wrong-thread',randomUUID()],[co,job,thread,'wrong-wait',randomUUID()]])
      await expect(scoped(co,insert,args)).rejects.toThrow(/foreign key/);
    const foreignCo=randomUUID(), foreignJob=randomUUID(), foreignWait=randomUUID(), foreignThread=randomUUID();
    await admin.query(`insert into ${s}.jobs(id,company_id,source,requester,ask) values($1,$2,'task','user:fixture','Other company fixture')`,[foreignJob,foreignCo]);
    await admin.query(`insert into ${s}.waits(id,company_id,job_id,kind,expires_at) values($1,$2,$3,'a2a_task',now()+interval '1 day')`,[foreignWait,foreignCo,foreignJob]);
    await admin.query(`insert into ${s}.bus_threads(id,company_id,job_id,direction,kind,room_id,peer,peer_app) values($1,$2,$3,'out','task','!other:fixture','@peer:fixture','fixture')`,[foreignThread,foreignCo,foreignJob]);
    await expect(scoped(co,insert,[co,job,thread,'cross-company-wait',foreignWait])).rejects.toThrow(/foreign key/);
    await expect(scoped(co,insert,[co,foreignJob,foreignThread,'cross-company-job-thread',foreignWait])).rejects.toThrow(/foreign key/);
    await expect(scoped(co,`update ${s}.bus_answer_intents set answers='{}' where id=$1`,[intent])).rejects.toThrow(/permission denied/);
    await expect(scoped(co,`delete from ${s}.bus_answer_intents where id=$1`,[intent])).rejects.toThrow(/permission denied/);
    await expect(admin.query(`update ${s}.bus_answer_intents set answers='{}' where id=$1`,[intent])).rejects.toThrow(/immutable_answer_intent/);
    await expect(admin.query(`delete from ${s}.bus_answer_intents where id=$1`,[intent])).rejects.toThrow(/immutable_answer_intent/);
    await expect(admin.query(`delete from ${s}.waits where id=$1`,[wait])).rejects.toThrow(/foreign key/);
    expect((await scoped(co,`select key from ${s}.outbound_events where company_id=$1`,[co])).rows).toHaveLength(1);
    expect((await scoped(randomUUID(),`select key from ${s}.outbound_events`)).rows).toEqual([]);
    await expect(scoped(co,`select event_id from ${s}.outbound_events`)).rejects.toThrow(/permission denied/);
    for (const role of [`${app}_app`,`${app}_runner`]) {
      expect((await admin.query("select has_table_privilege($1,$2,'SELECT') as r,has_table_privilege($1,$2,'INSERT') as i,has_table_privilege($1,$2,'UPDATE') as u,has_table_privilege($1,$2,'DELETE') as d",[role,`${s}.bus_answer_intents`])).rows[0]).toEqual({r:true,i:true,u:false,d:false});
      expect((await admin.query("select has_table_privilege($1,$2,'TRUNCATE') as t, has_table_privilege($1,$2,'TRIGGER') as g",[role,`${s}.bus_answer_intents`])).rows[0]).toEqual({t:false,g:false});
    }
  } finally { await appPool?.end(); await admin.end(); await db.drop(); await rm(temp,{recursive:true,force:true}); }
});
