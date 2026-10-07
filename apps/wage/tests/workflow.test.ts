import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, toolName, type Pilot } from '@neop/testkit';
import { migrateApp } from '@neop/template';
import { wageApp } from '../src/index.ts';
import { employees, settings } from './fixtures.ts';
let P: Pilot;
const CARD = { what: 'Payroll operation', why: 'requested by payroll team', changes: 'reviewed Wage records only', if_no_answer: 'nothing changes' };
beforeAll(async () => { P = await bootPilot({ apps: [{ def: await wageApp() }] }); });
afterAll(async () => { await P?.close(); });
const read = async (key: string, args = {}) => {
  const r = await P.read(`wage.${key}`,args,{app:'wage'});
  expect(r.status,JSON.stringify(r.body)).toBe(200); return r.body.result;
};
async function start(key: string, args: any) {
  let first = '';
  P.setBrain(v => {
    if(v.job.includes('WOKEN')) return {tool:toolName('job.finish'),args:{outcome:'done',summary:'Read the runner proof; released does not mean paid.'}};
    if(v.calls===0) return {tool:toolName(`wage.${key}`),args:{...args,...key==='payroll.prepare'?{}:{card:CARD}}};
    first=v.results[0]?.text ?? '';
    return first.includes('Proposal ') ? {text:'waiting'} : {tool:toolName('job.finish'),args:{outcome:'done',summary:first}};
  });
  const task=await P.ask(`Wage ${key}`,undefined,'wage');
  const pending=await P.waitFor(async()=>{
    const card=(await P.desk()).find(c=>c.task_id===task.task_id && c.status==='PENDING');
    if(card)return {card};
    const t=await P.task(task.task_id); return ['COMPLETED','FAILED'].includes(t.task.status)?{card:null}:null;
  },key);
  return {...task,...pending,get first(){return first;}};
}
async function approve(t: Awaited<ReturnType<typeof start>>) {
  expect(t.card).toBeTruthy();
  const r=await P.api('POST',`/api/desk/${t.card.id}/answer`,{decision:'yes',fingerprint_seen:t.card.fingerprint});
  expect(r.status).toBe(200);
  await P.waitFor(async()=>['COMPLETED','FAILED'].includes((await P.task(t.task_id)).task.status),'finished');
  return (await P.backend.core.runnerPool.query('select status,proof from wage.proposals where id=$1',[t.card.proposal_id])).rows[0]!;
}
async function run(key:string,args:any) { const t=await start(key,args); if(t.card)expect((await approve(t)).status).toBe('DONE'); return t; }

describe('Wage through the V3 Matrix / gate / runner path',()=>{
  it('ships genuinely blank, then gates payroll settings and the employee master',async()=>{
    expect((await read('employees.list')).empty).toBe(true);
    const t=await start('settings.update',settings);
    expect((await read('settings.get')).empty).toBe(true);
    expect((await approve(t)).status).toBe('DONE');
    await run('employees.import',{employees});
    expect((await read('employees.list')).rows).toHaveLength(2);
  });
  it('prepares payroll once and exposes the same persisted rows on the desk',async()=>{
    await run('payroll.prepare',{period:'2026-09'});
    const r=(await read('payroll.list')).rows[0];
    expect(r).toMatchObject({net_minor:720000,status:'prepared',paid:false});
    expect((await read('payslips.list',{run_id:r.id})).rows).toHaveLength(2);
    const desk=await P.api('POST','/api/apps/wage/read/wage.payroll.list',{});
    expect(desk.status).toBe(200);
    expect(desk.body.result.rows).toEqual((await read('payroll.list')).rows);
    await run('payroll.prepare',{period:'2026-09'});
    expect((await read('payroll.list')).rows).toHaveLength(1);
  });
  it('refuses a stale fingerprint, survives a waiting-backend restart, then releases exactly once',async()=>{
    const r=(await read('payroll.list')).rows[0];
    const t=await start('payroll.release',{run_id:r.id});
    expect(t.card.args).toMatchObject({input_hash:r.input_hash,amount_minor:720000,currency:'INR'});
    const stale=await P.api('POST',`/api/desk/${t.card.id}/answer`,{decision:'yes',fingerprint_seen:'wrong'});
    expect(stale.status).not.toBe(200);
    expect((await read('payroll.list')).rows[0].status).toBe('prepared');
    await P.restartBackend('wage');
    const proof=await approve(t);
    expect(proof.status).toBe('DONE');
    expect(proof.proof.read_back).toMatchObject({status:'released',paid:false});
    const again=await P.api('POST',`/api/desk/${t.card.id}/answer`,{decision:'yes',fingerprint_seen:t.card.fingerprint});
    expect([200,409]).toContain(again.status);
    expect((await read('payroll.list')).rows[0]).toMatchObject({status:'released',paid:false});
    const cannotReopen=await start('payroll.reopen',{run_id:r.id});
    expect(cannotReopen.card).toBeNull();
  });
  it('checks source changes at effect time; an old yes cannot release changed payroll',async()=>{
    await run('payroll.prepare',{period:'2026-10'});
    const r=(await read('payroll.list',{period:'2026-10'})).rows[0];
    const t=await start('payroll.release',{run_id:r.id});
    await P.backend.core.company(P.company.id,db=>db.query('update wage.employees set rate_minor=rate_minor+100 where source_id=$1',['E-1']));
    const result=await approve(t);
    expect(result.status).toBe('FAILED');
    expect(result.proof.error).toContain('inputs changed');
    expect((await read('payroll.list',{period:'2026-10'})).rows[0].status).toBe('prepared');
    await run('payroll.reopen',{run_id:r.id});
    await run('payroll.prepare',{period:'2026-10'});
    const runs=(await read('payroll.list',{period:'2026-10'})).rows;
    expect(runs.map((r:any)=>r.status)).toEqual(['superseded','prepared']);
    expect(runs[1].net_minor).toBe(720080);
  });
  it('rolls back a batch when any timesheet employee is unknown',async()=>{
    const t=await start('timesheets.import',{period:'2026-11',entries:[{source_id:'E-1',minutes:60},{source_id:'missing',minutes:60}]});
    expect((await approve(t)).status).toBe('FAILED');
    expect((await read('timesheets.list',{period:'2026-11'})).rows).toEqual([]);
  });
  it('rejects mutations to payroll history and reapplies migrations on populated data unchanged',async()=>{
    await expect(P.backend.core.company(P.company.id,db=>db.query('update wage.payslips set net_minor=net_minor'))).rejects.toThrow('immutable');
    await expect(P.backend.core.company(P.company.id,db=>db.query('delete from wage.pay_runs'))).rejects.toThrow('cannot be deleted');
    const before=(await read('payroll.list')).rows;
    await migrateApp(P.adminUrl,await wageApp());
    expect((await read('payroll.list')).rows).toEqual(before);
  });
  it('denies cross-schema reads and unscoped tenant access',async()=>{
    await expect(P.backend.core.company(P.company.id,db=>db.query('select * from neos.users'))).rejects.toThrow(/permission denied/);
    const B=await P.platform.createCompany('Wage isolated company');
    await P.platform.installApp(B.id,'wage');
    expect((await P.read('wage.employees.list',{}, {app:'wage',company:B.id})).body.result.empty).toBe(true);
  });
});
