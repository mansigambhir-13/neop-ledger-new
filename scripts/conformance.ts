// Conformance attestation (plan, test bar: "The platform registers an app only when all
// template tests pass"). Runs the required suites for one app with vitest's JSON reporter
// and writes an attestation bound to that exact manifest (sha256 over its JCS form):
//   tsx scripts/conformance.ts ledger [--out conformance/ledger.json]
// then: tsx scripts/ops.ts register-app ledger <l3_url> --conformance conformance/ledger.json
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestationProblem, manifestSha256, REQUIRED_SUITES, type ConformanceAttestation } from '@neop/platform';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps: Record<string, () => Promise<{ manifest: any }>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const out = outAt >= 0 ? argv.splice(outAt, 2)[1] : undefined;
const app = argv[0];
if (!app || !apps[app]) {
  console.error(`usage: conformance.ts <${Object.keys(apps).join('|')}> [--out <file>]`);
  process.exit(64);
}

const files = REQUIRED_SUITES.map((name) => ({ name, file: path.join('apps', app, 'tests', `${name}.test.ts`) }));
const missing = files.filter((f) => !existsSync(path.join(ROOT, f.file)));
if (missing.length) {
  console.error(`${app} is missing required suites: ${missing.map((m) => m.file).join(', ')}`);
  process.exit(1);
}

const report = path.join(os.tmpdir(), `neop-conformance-${app}-${process.pid}.json`);
const run = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...files.map((f) => f.file), '--reporter=json', `--outputFile=${report}`], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
const json = JSON.parse(await readFile(report, 'utf8').catch(() => 'null'));
await rm(report, { force: true });
if (!json) {
  console.error(`vitest produced no report (exit ${run.status})`);
  process.exit(1);
}

const suites = files.map((f) => {
  const r = (json.testResults as any[]).find((t) => path.resolve(t.name) === path.join(ROOT, f.file));
  const res = (r?.assertionResults ?? []) as { status: string }[];
  // A suite that failed to load has no assertions but a failed status: count it as a failure.
  const loadFailed = !r || (r.status === 'failed' && res.length === 0) ? 1 : 0;
  return { name: f.name, file: f.file, passed: res.filter((x) => x.status === 'passed').length, failed: res.filter((x) => x.status === 'failed').length + loadFailed };
});

const git = (a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = git(['status', '--porcelain']).length > 0;
const manifest = (await apps[app]!()).manifest;
const att: ConformanceAttestation = {
  app,
  manifest_sha256: manifestSha256(manifest),
  commit: git(['rev-parse', 'HEAD']) + (dirty ? '-dirty' : ''),
  suites,
  failed: suites.reduce((n, s) => n + s.failed, 0),
  generated_at: new Date().toISOString(),
};
const file = out ?? path.join(ROOT, 'conformance', `${app}.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(att, null, 2) + '\n');
const problem = attestationProblem(att, app, manifest);
console.log(JSON.stringify({ written: file, failed: att.failed, commit: att.commit, registrable: !problem, ...(problem ? { problem } : {}) }));
process.exit(problem ? 1 : 0);
