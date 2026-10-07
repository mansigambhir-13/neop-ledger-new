import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createPool,createTestDatabase,renderDbaBundle,roleUrl} from '@neop/pgkit';
import {appMigrationSources,migrateApp} from '@neop/template';
import {grantApp} from '../src/index.ts';
let migrated:Awaited<ReturnType<typeof createTestDatabase>>;
let bundled:Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async()=>{migrated=await createTestDatabase();bundled=await createTestDatabase();});
afterAll(async()=>{await migrated?.drop();await bundled?.drop();});
describe('Grant DBA SQL parity',()=>{
 it('applies the reserved-name schema bundle and gives the app its correct unqualified home',async()=>{
  const app=await grantApp();await migrateApp(migrated.adminUrl,app);
  const bundle=await renderDbaBundle({schema:'grant',sources:await appMigrationSources(app)});
  const admin=createPool(bundled.adminUrl),other=createPool(migrated.adminUrl);
  try{
   await admin.query(bundle.sql);
   const sql='select name,checksum from "grant".schema_migrations order by name';
   expect((await admin.query(sql)).rows).toEqual((await other.query(sql)).rows);
   expect(bundle.migrations).toHaveLength(25);
   expect((await admin.query(sql)).rows.some(m=>m.name==='t024_answer_intents.sql')).toBe(true);
  }finally{await admin.end();await other.end();}
  const appPool=createPool(roleUrl(bundled.adminUrl,'grant_app'));
  try{
   expect((await appPool.query('select current_schema() as schema')).rows[0].schema).toBe('grant');
   expect((await appPool.query('select * from requests')).rows).toEqual([]);
   await expect(appPool.query('create table "grant".not_allowed(id uuid)')).rejects.toThrow(/permission denied/);
  }finally{await appPool.end();}
 });
});
