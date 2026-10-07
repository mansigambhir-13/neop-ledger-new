import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { checkMigrateLedger, expandContractLint } from '../../../packages/pgkit/src/index.ts';
import { PINNED_TEMPLATE_COMMIT } from '../template-alignment.ts';

type Entry = { file: string; baseline?: boolean };
type Rule = { upstream: string; fleet: string[]; equivalence: string };
type Crosswalk = { schema_version: number; template_commit: string; strategy: string; rules: Rule[] };

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function migrationFiles(dir: string, template = false): string[] {
  const expression = template ? /^(?:001_standard|t\d{3}_.+)\.sql$/ : /^\d{3}_.+\.sql$/;
  return readdirSync(dir).filter((name) => expression.test(name)).sort();
}

async function ledgerProblems(dir: string, template: boolean, label: string): Promise<string[]> {
  const problems: string[] = [];
  const files = migrationFiles(dir, template);
  let entries: Entry[] = [];
  try { entries = (await checkMigrateLedger(dir, files)) ?? []; }
  catch (error) { problems.push(`${label}: ${(error as Error).message}`); return problems; }
  const earlier: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      problems.push(`${label}: ${entry.file} is missing, not regular, or linked`);
      continue;
    }
    try {
      if (!entry.baseline) expandContractLint(entry.file, readFileSync(absolute, 'utf8'), earlier);
    } catch (error) { problems.push(`${label}: ${(error as Error).message}`); }
    earlier.push(entry.file);
  }
  return problems;
}

export async function templateMigrationProblems(root: string, app: string): Promise<string[]> {
  const problems: string[] = [];
  const upstream = path.join(root, 'reference/upstream/neos-neop-template');
  try {
    if (git(upstream, ['rev-parse', 'HEAD']) !== PINNED_TEMPLATE_COMMIT) problems.push('upstream migration source is not at the pinned commit');
  } catch { problems.push('upstream migration source is not a readable Git checkout'); }

  const upstreamLedger = JSON.parse(readFileSync(path.join(upstream, 'migrations/migrate.json'), 'utf8')) as { migrations: { file: string }[] };
  const upstreamFiles = upstreamLedger.migrations.map((entry) => entry.file);
  const expectedUpstream = ['001_standard.sql', '002_notes.sql', '003_standard_notices.sql', '004_standard_schedules.sql', '005_standard_files.sql', '006_standard_job_endings.sql', '007_standard_sources.sql', '008_standard_peer_payloads.sql'];
  if (JSON.stringify(upstreamFiles) !== JSON.stringify(expectedUpstream)) problems.push('pinned upstream migration inventory changed');

  const crosswalk = JSON.parse(readFileSync(path.join(root, 'fleet/template-migrations.json'), 'utf8')) as Crosswalk;
  if (crosswalk.schema_version !== 1 || crosswalk.template_commit !== PINNED_TEMPLATE_COMMIT || crosswalk.strategy !== 'forward-only-equivalence') problems.push('migration crosswalk identity is invalid');
  if (JSON.stringify(crosswalk.rules.map((rule) => rule.upstream)) !== JSON.stringify(expectedUpstream)) problems.push('migration crosswalk must cover upstream 001-008 exactly once and in order');
  const sharedDir = path.join(root, 'packages/neop-template/migrations');
  const appDir = path.join(root, 'apps', app, 'migrations');
  const sharedFiles = new Set(migrationFiles(sharedDir, true));
  const appFiles = migrationFiles(appDir);
  for (const rule of crosswalk.rules) {
    if (!rule.equivalence.trim()) problems.push(`${rule.upstream} has no equivalence rationale`);
    for (const target of rule.fleet) {
      if (target === 'app:first-shape') {
        if (!appFiles.some((file) => file !== '003_declared_reads.sql' && file !== '010_declared_reads.sql')) problems.push(`${app} has no app-owned shape migration for ${rule.upstream}`);
      } else if (target === 'app:declared-reads') {
        if (!appFiles.some((file) => file.endsWith('_declared_reads.sql'))) problems.push(`${app} has no declared-read migration for ${rule.upstream}`);
      } else if (!sharedFiles.has(target)) problems.push(`${rule.upstream} maps to missing shared migration ${target}`);
    }
  }
  problems.push(...await ledgerProblems(sharedDir, true, 'shared migrations'));
  problems.push(...await ledgerProblems(appDir, false, `${app} migrations`));
  return [...new Set(problems)].sort();
}
