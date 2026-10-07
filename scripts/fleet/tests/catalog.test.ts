import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, fleetStatus } from '../status.ts';
import { wageApp } from '@neop/wage';

describe('fleet rebuild accounting',()=>{
  it('tracks the documented twenty separately from the alternate legacy app roster',()=>{
    const r=fleetStatus();
    expect(r.apps.map(a=>a.id)).toEqual(['ledger','wage','clear','reach','desk','hire','deal','buy','grant','shift','sync','post','roster','quote','sign','guard','vet','pay','asset','renew']);
    expect(r.selection).toBe('documented_20_working_scope');
  });
  it('distinguishes twenty runtime definitions from complete or production-ready apps',()=>{
    const r=fleetStatus();
    expect(r.apps.filter(a=>a.implementation_present)).toHaveLength(20);
    const drafts=r.apps.filter(a=>!['ledger','wage'].includes(a.id));
    expect(drafts).toHaveLength(18);
    for(const a of drafts) {
      expect(a.domain_port_present).toBe(true);
      expect(a.implementation_present).toBe(true);
      expect(a.production_ready).toBe(false);
      expect(a.missing_suites.length).toBeGreaterThan(0);
      expect(existsSync(path.join(ROOT,'apps',a.id,'REBUILD.md'))).toBe(true);
    }
    expect(r.apps.every(a=>a.unfulfilled_requirements.length===18 && !a.production_ready)).toBe(true);
  });
  it('Wage declares only implemented handlers and does not pretend to pay or file',async()=>{
    const app=await wageApp();
    expect(Object.keys(app.abilities).sort()).toEqual(app.manifest.abilities.map(a=>a.key).sort());
    expect(app.manifest.doors).toEqual([]);
    expect(app.manifest.abilities.some(a=>a.effects?.external)).toBe(false);
    expect(fleetStatus().apps.find(a=>a.id==='wage')?.production_ready).toBe(false);
  });
  it('business slices cannot replace template identity or authority tables',()=>{
    const reserved=new Set(['people','acted_for','jobs','steps','waits','proposals','grants','operations','facts','switchboard','installs','bus_threads','bus_answer_intents']);
    for(const app of fleetStatus().apps.filter(a=>!['ledger','wage'].includes(a.id))){
      const migrations=JSON.parse(readFileSync(path.join(ROOT,'apps',app.id,'migrations/migrate.json'),'utf8'));
      for(const migration of migrations.migrations)for(const table of migration.tables)expect(reserved.has(table),app.id+':'+table).toBe(false);
    }
  });
  it('does not build or commit the legacy source snapshot as runtime code',()=>{
    expect(readFileSync(path.join(ROOT,'.gitignore'),'utf8')).toContain('reference/quickbuild/');
    expect(readFileSync(path.join(ROOT,'.gitignore'),'utf8')).toContain('reference/upstream/');
    expect(readFileSync(path.join(ROOT,'.dockerignore'),'utf8').split('\n')).toContain('reference');
  });
  it('accounts for every captured source capability and catalog-only entry without claiming full parity',()=>{
    const lock=JSON.parse(readFileSync(path.join(ROOT,'fleet/source-lock.json'),'utf8'));
    expect(lock.apps).toHaveLength(18);
    for(const app of lock.apps){
      expect(app.commit).toMatch(/^[a-f0-9]{40}$/);expect(app.tree_sha).toMatch(/^[a-f0-9]{40}$/);
      expect(app.files).toHaveLength(6);expect(app.files.every((f:any)=>/^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
      const parity=JSON.parse(readFileSync(path.join(ROOT,'apps',app.app,'SOURCE-PARITY.json'),'utf8'));
      expect(parity.source_commit).toBe(app.commit);expect(parity.full_parity).toBe(false);
      expect(new Set(parity.mappings.map((m:any)=>m.legacy)).size).toBe(parity.mappings.length);
      for(const cap of app.capabilities)expect(parity.mappings.some((m:any)=>m.legacy===cap)).toBe(true);
    }
  });
});
