import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PINNED_TEMPLATE_COMMIT } from '../template-alignment.ts';

export const UPSTREAM_STANDARD_SUITES = [
  'contract.test.mjs',
  'honesty.test.mjs',
  'injection.test.mjs',
  'migration.test.mjs',
  'proposal.test.mjs',
  'resume.test.mjs',
  'schema-only.test.mjs',
  'sender.test.mjs',
  'switchboard.test.mjs',
] as const;

type StandardSuite = typeof UPSTREAM_STANDARD_SUITES[number];
type Crosswalk = Record<StandardSuite, readonly string[]>;

const DRAFT_CROSSWALK: Crosswalk = {
  'contract.test.mjs': ['conformance.test.ts'],
  'honesty.test.mjs': ['conformance.test.ts'],
  'injection.test.mjs': ['origins.test.ts', 'authority.test.ts'],
  'migration.test.mjs': ['template-migration.test.ts'],
  'proposal.test.mjs': ['approval-lifecycle.test.ts'],
  'resume.test.mjs': ['input-lifecycle.test.ts', 'timer-lifecycle.test.ts', 'bus-answer-lifecycle.test.ts', 'bus-question-lifecycle.test.ts', 'bus-result-lifecycle.test.ts'],
  'schema-only.test.mjs': ['authority.test.ts'],
  'sender.test.mjs': ['conformance.test.ts', 'bus-answer-lifecycle.test.ts', 'bus-question-lifecycle.test.ts', 'bus-result-lifecycle.test.ts'],
  'switchboard.test.mjs': ['conformance.test.ts', 'workflow.test.ts'],
};

const WAGE_CROSSWALK: Crosswalk = {
  'contract.test.mjs': ['conformance.test.ts'],
  'honesty.test.mjs': ['conformance.test.ts'],
  'injection.test.mjs': ['conformance.test.ts', 'workflow.test.ts'],
  'migration.test.mjs': ['template-migration.test.ts'],
  'proposal.test.mjs': ['conformance.test.ts', 'workflow.test.ts'],
  'resume.test.mjs': ['workflow.test.ts'],
  'schema-only.test.mjs': ['workflow.test.ts'],
  'sender.test.mjs': ['conformance.test.ts'],
  'switchboard.test.mjs': ['conformance.test.ts'],
};

const LEDGER_CROSSWALK: Crosswalk = Object.fromEntries(
  UPSTREAM_STANDARD_SUITES.map((suite) => [suite, [suite.replace(/\.mjs$/, '.ts')]]),
) as unknown as Crosswalk;

export function standardCrosswalk(app: string): Crosswalk {
  if (app === 'ledger') return LEDGER_CROSSWALK;
  if (app === 'wage') return WAGE_CROSSWALK;
  return DRAFT_CROSSWALK;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

export function templateStandardProblems(root: string, app: string): string[] {
  const problems: string[] = [];
  const upstream = path.join(root, 'reference/upstream/neos-neop-template');
  const standardDir = path.join(upstream, 'tests/standard');
  if (!existsSync(standardDir)) return ['pinned upstream standard-suite checkout is missing'];
  try {
    if (git(upstream, ['rev-parse', 'HEAD']) !== PINNED_TEMPLATE_COMMIT) problems.push('upstream standard suites are not at the pinned commit');
  } catch {
    problems.push('upstream standard suites are not a readable Git checkout');
  }
  const actual = readdirSync(standardDir)
    .filter((entry) => entry.endsWith('.test.mjs'))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...UPSTREAM_STANDARD_SUITES])) problems.push('upstream standard-suite inventory changed');

  const crosswalk = standardCrosswalk(app);
  if (JSON.stringify(Object.keys(crosswalk).sort()) !== JSON.stringify([...UPSTREAM_STANDARD_SUITES])) problems.push(`${app} standard crosswalk is incomplete`);
  for (const suite of UPSTREAM_STANDARD_SUITES) {
    const local = crosswalk[suite];
    if (!local?.length) {
      problems.push(`${app} has no local proof for ${suite}`);
      continue;
    }
    for (const file of local) {
      if (!/^[a-z0-9-]+\.test\.ts$/.test(file)) {
        problems.push(`${app}/${suite} has an unsafe proof path: ${file}`);
        continue;
      }
      const absolute = path.join(root, 'apps', app, 'tests', file);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) problems.push(`${app}/${suite} proof is missing or linked: ${file}`);
    }
  }
  return [...new Set(problems)].sort();
}
