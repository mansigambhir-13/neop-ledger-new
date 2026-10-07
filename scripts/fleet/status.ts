// Inventory is not registration. A work-package folder cannot become a runnable or certified app.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SUITES } from '@neop/platform';
import { templateAlignmentStatus } from './template-alignment.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export interface FleetEntry { id: string; name: string; role: string; wave: number; status: string; target: string; production_ready: boolean; run_guide: string }
export function fleetStatus(root = ROOT) {
  const catalog = JSON.parse(readFileSync(path.join(root, 'fleet/catalog.json'), 'utf8')) as { selection: string; apps: FleetEntry[] };
  const requirements = JSON.parse(readFileSync(path.join(root, 'fleet/requirements.json'), 'utf8')).requirements as {id:string}[];
  const sources = JSON.parse(readFileSync(path.join(root, 'fleet/source-lock.json'), 'utf8')).apps as {app:string}[];
  const template = templateAlignmentStatus(root);
  if (catalog.apps.length !== 20 || new Set(catalog.apps.map(a => a.id)).size !== 20) throw new Error('fleet catalogue must identify exactly twenty distinct NEOPs');
  return {
    selection: catalog.selection,
    apps: catalog.apps.map(a => {
      if (!/^[a-z][a-z0-9_]*$/.test(a.id) || a.target !== `apps/${a.id}`) throw new Error('unsafe fleet target');
      const app = path.join(root, a.target);
      const implementation_present = ['manifest.json','package.json','src/index.ts','migrations/migrate.json'].every(f => existsSync(path.join(app,f)));
      const missing_suites = REQUIRED_SUITES.filter(s => !existsSync(path.join(app,'tests',`${s}.test.ts`)));
      const domain = path.join(app,'src/domain');
      const domain_port_present = existsSync(domain) && readdirSync(domain).some(f=>f.endsWith('.ts'));
      const acceptance = JSON.parse(readFileSync(path.join(app,'ACCEPTANCE.json'),'utf8')) as {requirements:{id:string;status:string}[]};
      if(acceptance.requirements.length!==requirements.length || new Set(acceptance.requirements.map(r=>r.id)).size!==requirements.length || requirements.some(r=>!acceptance.requirements.some(a=>a.id===r.id))) throw new Error(`incomplete requirement accounting for ${a.id}`);
      const unfulfilled_requirements = acceptance.requirements.filter(r=>r.status!=='certified').map(r=>r.id);
      // Inventory is not an attestation. Missing evidence can never be overridden by a catalog boolean.
      if(a.production_ready && (!implementation_present || missing_suites.length || unfulfilled_requirements.length)) throw new Error(`unsupported production-ready claim for ${a.id}`);
      const templateApp = template.apps.find((entry) => entry.id === a.id)!;
      return { id:a.id, status:a.status, wave:a.wave, source_pinned:sources.some(s=>s.app===a.id), domain_port_present, implementation_present, missing_suites, unfulfilled_requirements, production_ready:a.production_ready, template_assessment:templateApp.assessment, template_verified_gates:templateApp.verified_gates, template_aligned:templateApp.template_aligned };
    }),
    template_alignment: { repository:template.repository, commit:template.commit, template_version:template.template_version, aligned:template.aligned, total:template.total },
  };
}
export function verifySourceSnapshots(root=ROOT): number {
  const lock=JSON.parse(readFileSync(path.join(root,'fleet/source-lock.json'),'utf8')) as {apps:{app:string;files:{local:string;sha256:string}[]}[]};
  let count=0;
  for(const app of lock.apps)for(const file of app.files) {
    if(!/^[a-z]+$/.test(app.app) || !file.local.startsWith(`reference/upstream/${app.app}/`) || file.local.split('/').includes('..'))throw new Error('unsafe source snapshot path');
    const hash=createHash('sha256').update(readFileSync(path.join(root,file.local))).digest('hex');
    if(hash!==file.sha256)throw new Error(`source snapshot mismatch: ${file.local}`);
    count++;
  }
  return count;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = fleetStatus();
  if(process.argv.includes('--check-sources'))console.log(`Verified ${verifySourceSnapshots()} pinned source snapshots`);
  console.log(JSON.stringify(process.argv.includes('--summary') ? {selection:report.selection,total:report.apps.length,source_pinned:report.apps.filter(a=>a.source_pinned).length,domain_ports:report.apps.filter(a=>a.domain_port_present).length,runtime_present:report.apps.filter(a=>a.implementation_present).map(a=>a.id),template_alignment:report.template_alignment,template_aligned:report.apps.filter(a=>a.template_aligned).map(a=>a.id),production_ready:report.apps.filter(a=>a.production_ready).map(a=>a.id)} : report,null,2));
  if (process.argv.includes('--require-complete') && (report.selection.startsWith('provisional_') || report.apps.some(a=>!a.implementation_present || a.missing_suites.length || a.unfulfilled_requirements.length || !a.template_aligned || !a.production_ready))) process.exitCode=1;
}
