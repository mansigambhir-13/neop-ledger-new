import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PINNED_TEMPLATE_REPOSITORY = 'https://github.com/NEOS-Ecosystem/neos-neop-template';
export const PINNED_TEMPLATE_COMMIT = '94db804f94403c15ad1279e6d30dcecc7c078b82';
export const PINNED_TEMPLATE_VERSION = '0.8.16';
export const PINNED_TEMPLATE_ARCHIVE_SHA256 = '6a22d515c2a36ddeb8ad613af042960d15b4ab3f41e829bc933e105c9505aa23';
export const FLEET_SELECTION = 'documented_20_working_scope';
export const FLEET_APP_IDS = [
  'ledger', 'wage', 'clear', 'reach', 'desk', 'hire', 'deal', 'buy', 'grant', 'shift',
  'sync', 'post', 'roster', 'quote', 'sign', 'guard', 'vet', 'pay', 'asset', 'renew',
] as const;

export const TEMPLATE_GATES = [
  ['ownership', 'template-ownership.test.ts'],
  ['manifest', 'template-manifest.test.ts'],
  ['standard-tests', 'template-standard.test.ts'],
  ['migrations', 'template-migration.test.ts'],
  ['ingress-approval', 'template-ingress-approval.test.ts'],
  ['runtime-credentials', 'template-runtime-credentials.test.ts'],
  ['model-auth-provider', 'template-model-auth-provider.test.ts'],
  ['runtime-processes', 'template-runtime-processes.test.ts'],
  ['frontend', 'template-frontend.test.ts'],
  ['blocks', 'template-blocks.test.ts'],
  ['secrets', 'template-secrets.test.ts'],
  ['publish-install', 'template-publish-install.test.ts'],
] as const;

export type GateId = typeof TEMPLATE_GATES[number][0];
export type FleetAppId = typeof FLEET_APP_IDS[number];

export const PINNED_TEMPLATE_PATHS = {
  ownership: ['template.json', 'scripts/template-sync.mjs'],
  manifest: ['src/manifest.mjs', 'src/emit-manifest.mjs', 'manifest.json'],
  'standard-tests': ['tests/standard'],
  migrations: ['migrations', 'tests/standard/migration.test.mjs', 'tests/standard/schema-only.test.mjs'],
  'ingress-approval': ['src/presence', 'src/gate', 'src/capabilities/approved.mjs'],
  'runtime-credentials': ['manifest.json', 'tests/runtime-credentials.test.mjs'],
  'model-auth-provider': ['src/auth/chatgpt', 'src/agent/llm', 'scripts/chatgpt.mjs', 'tests/chatgpt-hardening.test.mjs', 'tests/chatgpt-plan.test.mjs', 'tests/codex-provider.test.mjs'],
  'runtime-processes': ['deploy', 'tests/runtime-processes.test.mjs', 'tests/compose-topology.test.mjs'],
  frontend: ['frontend', 'tests/frontend.test.mjs', 'tests/frontend-no-login.test.mjs'],
  blocks: ['blocks', 'src/web/surface.mjs', 'tests/blocks.test.mjs'],
  secrets: ['tests/synthetic-secrets.test.mjs', 'deploy'],
  'publish-install': ['tests/platform/publish.test.mjs', 'tests/verify-install.mjs'],
} as const satisfies Record<GateId, readonly string[]>;

export const PINNED_TEMPLATE_DIRECTORIES = new Set([
  'tests/standard', 'migrations', 'src/presence', 'src/gate', 'deploy', 'frontend', 'blocks',
  'src/auth/chatgpt', 'src/agent/llm',
]);

const SHARED_ALIGNMENT_SOURCE_PATHS = [
  'packages/neop-template',
  'packages/contracts',
  'packages/domain-values',
  'packages/pgkit',
  'packages/platform',
  'scripts/fleet',
  'deploy',
  'fleet/catalog.json',
  'fleet/requirements.json',
  'fleet/template-ownership.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
] as const;

type JsonObject = Record<string, unknown>;
type Catalog = { selection: string; apps: { order: number; id: string }[] };

export interface TemplateAppStatus {
  id: string;
  assessment: string;
  verified_gates: GateId[];
  required_gates: number;
  template_aligned: boolean;
}

export interface TemplateAlignmentStatus {
  repository: string;
  commit: string;
  template_version: string;
  direct_template_sync_allowed: false;
  total: number;
  aligned: number;
  apps: TemplateAppStatus[];
}

export interface TemplateSourceVerification {
  archive_sha256: string;
  template_version: string;
  checked_archive_paths: number;
}

export interface AlignmentSourceDigest {
  sha256: string;
  files: string[];
}

export interface GateEvidence {
  schema_version: 1;
  app: FleetAppId;
  gate: GateId;
  template_commit: string;
  source_commit: string;
  source_sha256: string;
  test_file: string;
  runner: {
    kind: 'vitest-json-v1';
    command: string[];
    report: string;
    report_sha256: string;
  };
}

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const fullCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function fail(message: string): never {
  throw new Error(`invalid fleet template alignment: ${message}`);
}

function exactStrings(actual: unknown[], expected: readonly string[], label: string) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) fail(`${label} must exactly match the pinned contract`);
}

function safeRelativeFile(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\')) fail(`${label} must be a safe repository-relative path`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) fail(`${label} must be a safe repository-relative path`);
  return value;
}

function readJsonFile(root: string, relative: string, label: string): unknown {
  const safe = safeRelativeFile(relative, label);
  const absolute = path.join(root, safe);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) fail(`${label} is missing or is not a regular file: ${safe}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    fail(`${label} is not valid JSON: ${safe}`);
  }
}

export function alignmentSourcePaths(app: string): string[] {
  if (!FLEET_APP_IDS.includes(app as FleetAppId)) fail(`unknown fleet app for source scope: ${app}`);
  // The status document changes when evidence is admitted; binding it would make the
  // evidence invalidate itself. Code, tests, manifests and all other app files remain bound.
  return [`apps/${app}`, `:(exclude)apps/${app}/NEOP-V3-ALIGNMENT.md`, ...SHARED_ALIGNMENT_SOURCE_PATHS];
}

function gitFiles(root: string, args: string[]): string[] {
  let output: Buffer;
  try {
    output = execFileSync('git', ['-C', root, 'ls-files', '-z', ...args], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    fail('alignment source inventory requires a readable Git worktree');
  }
  return output.toString('utf8').split('\0').filter(Boolean).sort();
}

export function computeAlignmentSourceDigest(root: string, app: string): AlignmentSourceDigest {
  const files = gitFiles(root, ['--cached', '--others', '--exclude-standard', '--', ...alignmentSourcePaths(app)]);
  if (!files.length) fail(`${app} alignment source scope is empty`);
  const hash = createHash('sha256');
  for (const relative of files) {
    const safe = safeRelativeFile(relative, `${app} source file`);
    const absolute = path.join(root, safe);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) fail(`${app} source file is missing or not regular: ${safe}`);
    const bytes = readFileSync(absolute);
    hash.update(safe);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files };
}

function gitCheck(root: string, args: string[], message: string) {
  try {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  } catch {
    fail(message);
  }
}

export function assertAlignmentSourceAtCommit(root: string, app: string, sourceCommit: string) {
  if (!fullCommit(sourceCommit)) fail(`${app} evidence source_commit must be a full commit`);
  gitCheck(root, ['cat-file', '-e', `${sourceCommit}^{commit}`], `${app} evidence source_commit is not present in this repository`);
  gitCheck(root, ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], `${app} evidence source_commit is not an ancestor of HEAD`);
  gitCheck(root, ['diff', '--quiet', sourceCommit, '--', ...alignmentSourcePaths(app)], `${app} alignment source differs from its evidence commit`);
  const untracked = gitFiles(root, ['--others', '--exclude-standard', '--', ...alignmentSourcePaths(app)]);
  if (untracked.length) fail(`${app} alignment source has untracked files: ${untracked.join(', ')}`);
}

export function templateGateEvidencePath(app: string, gate: GateId): string {
  return `docs/evidence/template-alignment/${app}/${gate}.evidence.json`;
}

export function templateGateReportPath(app: string, gate: GateId): string {
  return `docs/evidence/template-alignment/${app}/${gate}.vitest.json`;
}

export function templateGateTestFile(app: string, gate: GateId): string {
  const suite = TEMPLATE_GATES.find(([id]) => id === gate)?.[1];
  if (!suite) fail(`unsupported template gate: ${gate}`);
  return `apps/${app}/tests/${suite}`;
}

export function templateGateCommand(app: string, gate: GateId): string[] {
  const testFile = templateGateTestFile(app, gate);
  const report = templateGateReportPath(app, gate);
  return ['pnpm', 'exec', 'vitest', 'run', testFile, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`];
}

function exactNumber(value: unknown, expected: number, label: string) {
  if (value !== expected) fail(`${label} must be ${expected}`);
}

export function validateVitestGateReport(value: unknown, root: string, testFile: string) {
  if (!isObject(value)) fail('gate runner report must be an object');
  if (value.success !== true) fail('gate runner report is not successful');
  if (typeof value.numTotalTests !== 'number' || value.numTotalTests < 1) fail('gate runner report must execute at least one test');
  exactNumber(value.numPassedTests, value.numTotalTests, 'gate runner passed test count');
  exactNumber(value.numFailedTests, 0, 'gate runner failed test count');
  exactNumber(value.numPendingTests, 0, 'gate runner pending/skipped test count');
  exactNumber(value.numTodoTests, 0, 'gate runner todo test count');
  if (typeof value.numTotalTestSuites !== 'number' || value.numTotalTestSuites < 1) fail('gate runner report must execute at least one suite');
  exactNumber(value.numPassedTestSuites, value.numTotalTestSuites, 'gate runner passed suite count');
  exactNumber(value.numFailedTestSuites, 0, 'gate runner failed suite count');
  exactNumber(value.numPendingTestSuites, 0, 'gate runner pending suite count');
  if (!Array.isArray(value.testResults) || value.testResults.length !== 1 || !isObject(value.testResults[0])) fail('gate runner report must contain exactly one test file result');
  const result = value.testResults[0];
  if (result.status !== 'passed') fail('gate runner test file did not pass');
  if (typeof result.name !== 'string') fail('gate runner test file name is missing');
  const reportedFile = path.isAbsolute(result.name) ? path.relative(root, result.name) : result.name;
  if (reportedFile.split(path.sep).join('/') !== testFile) fail('gate runner report is for a different test file');
  if (!Array.isArray(result.assertionResults) || !result.assertionResults.length || result.assertionResults.some((assertion) => !isObject(assertion) || assertion.status !== 'passed')) fail('gate runner report contains an unpassed assertion');
}

export function validateGateEvidence(value: unknown, reference: string, app: string, root = ROOT): GateId {
  if (!isObject(value) || value.schema_version !== 1) fail(`${app} gate evidence must use schema_version 1`);
  if (value.app !== app) fail(`${app} gate evidence names another app`);
  if (typeof value.gate !== 'string' || !TEMPLATE_GATES.some(([id]) => id === value.gate)) fail(`${app} gate evidence names an unsupported gate`);
  const gate = value.gate as GateId;
  if (reference !== templateGateEvidencePath(app, gate)) fail(`${app} gate evidence is not stored at its canonical path`);
  if (value.template_commit !== PINNED_TEMPLATE_COMMIT) fail(`${app}/${gate} evidence uses another template commit`);
  if (!fullCommit(value.source_commit)) fail(`${app}/${gate} evidence source_commit must be a full commit`);
  if (!digest(value.source_sha256)) fail(`${app}/${gate} evidence source_sha256 must be a SHA-256 digest`);
  const testFile = templateGateTestFile(app, gate);
  if (value.test_file !== testFile || !existsSync(path.join(root, testFile))) fail(`${app}/${gate} evidence test file is missing or incorrect`);

  if (!isObject(value.runner) || value.runner.kind !== 'vitest-json-v1') fail(`${app}/${gate} evidence runner is unsupported`);
  if (!Array.isArray(value.runner.command) || value.runner.command.some((part) => typeof part !== 'string')) fail(`${app}/${gate} evidence runner command is invalid`);
  exactStrings(value.runner.command, templateGateCommand(app, gate), `${app}/${gate} runner command`);
  const reportPath = templateGateReportPath(app, gate);
  if (value.runner.report !== reportPath || !digest(value.runner.report_sha256)) fail(`${app}/${gate} evidence report binding is invalid`);
  const reportAbsolute = path.join(root, reportPath);
  if (!existsSync(reportAbsolute) || !lstatSync(reportAbsolute).isFile()) fail(`${app}/${gate} runner report is missing`);
  const reportBytes = readFileSync(reportAbsolute);
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  if (reportSha256 !== value.runner.report_sha256) fail(`${app}/${gate} runner report digest does not match`);
  let report: unknown;
  try {
    report = JSON.parse(reportBytes.toString('utf8')) as unknown;
  } catch {
    fail(`${app}/${gate} runner report is not valid JSON`);
  }
  validateVitestGateReport(report, root, testFile);

  const source = computeAlignmentSourceDigest(root, app);
  if (source.sha256 !== value.source_sha256) fail(`${app}/${gate} source digest does not match the current app/shared source`);
  assertAlignmentSourceAtCommit(root, app, value.source_commit);
  return gate;
}

export function validateTemplateAlignment(value: unknown, catalog: Catalog, root = ROOT): TemplateAlignmentStatus {
  if (!isObject(value)) fail('document must be an object');
  if (value.schema_version !== 2) fail('schema_version must be 2');
  if (catalog.selection !== FLEET_SELECTION) fail('catalog selection is not the reviewed twenty-app scope');
  const catalogIds = catalog.apps.map((app) => app.id);
  exactStrings(catalogIds, FLEET_APP_IDS, 'catalog app ids');
  if (new Set(catalogIds).size !== FLEET_APP_IDS.length) fail('catalog app ids must be distinct');

  const upstream = value.upstream;
  if (!isObject(upstream)) fail('upstream must be an object');
  if (upstream.repository !== PINNED_TEMPLATE_REPOSITORY) fail('upstream repository is not the reviewed repository');
  if (upstream.commit !== PINNED_TEMPLATE_COMMIT || !fullCommit(upstream.commit)) fail('upstream commit is not the reviewed full commit');
  if (upstream.template_version !== PINNED_TEMPLATE_VERSION) fail('template version does not match the reviewed source');
  if (upstream.archive_sha256 !== PINNED_TEMPLATE_ARCHIVE_SHA256 || !digest(upstream.archive_sha256)) fail('archive digest does not match the reviewed source');

  const strategy = value.strategy;
  if (!isObject(strategy) || strategy.mode !== 'controlled_compatibility_adoption' || strategy.direct_template_sync_allowed !== false) fail('direct template sync must remain explicitly prohibited');
  if (strategy.decision !== 'docs/adr/0032-pinned-upstream-template-adoption.md' || strategy.plan !== 'docs/TEMPLATE-ALIGNMENT-PLAN.md') fail('strategy must name the reviewed decision and plan');
  if (!existsSync(path.join(root, strategy.decision)) || !existsSync(path.join(root, strategy.plan))) fail('strategy decision or plan is missing');

  if (!Array.isArray(value.required_gates)) fail('required_gates must be a list');
  const gateIds: string[] = [];
  const suites = new Map<GateId, string>();
  for (let index = 0; index < value.required_gates.length; index++) {
    const gate = value.required_gates[index];
    if (!isObject(gate) || typeof gate.id !== 'string' || typeof gate.suite !== 'string' || !Array.isArray(gate.upstream) || !gate.upstream.length || gate.upstream.some((item) => typeof item !== 'string' || !item || item.includes('..'))) fail('every required gate needs a safe id, suite and upstream evidence paths');
    const expected = TEMPLATE_GATES[index];
    if (!expected || gate.id !== expected[0] || gate.suite !== expected[1]) fail('required gates must exactly match the reviewed contract');
    exactStrings(gate.upstream, PINNED_TEMPLATE_PATHS[expected[0]], `${gate.id} upstream paths`);
    gateIds.push(gate.id);
    suites.set(gate.id as GateId, gate.suite);
  }
  exactStrings(gateIds, TEMPLATE_GATES.map(([id]) => id), 'required gate ids');
  exactStrings([...suites.values()], TEMPLATE_GATES.map(([, suite]) => suite), 'required gate suites');

  if (!Array.isArray(value.apps)) fail('apps must be a list');
  const alignmentIds = value.apps.map((app) => isObject(app) ? app.id : undefined);
  exactStrings(alignmentIds, catalogIds, 'app ids');

  const allowedAssessments = new Set(['unassessed', 'gap', 'conflict', 'partial', 'aligned']);
  const appStatuses: TemplateAppStatus[] = [];
  for (let index = 0; index < value.apps.length; index++) {
    const app = value.apps[index];
    if (!isObject(app)) fail(`apps[${index}] must be an object`);
    const id = catalogIds[index]!;
    if ('template_aligned' in app) fail(`${id} must not store a template_aligned claim; it is derived from evidence`);
    if (app.order !== catalog.apps[index]!.order) fail(`${id} order does not match fleet/catalog.json`);
    if (typeof app.profile !== 'string' || !app.profile) fail(`${id} names no migration profile`);
    if (typeof app.assessment !== 'string' || !allowedAssessments.has(app.assessment)) fail(`${id} has an unsupported assessment`);
    const expectedDoc = `apps/${id}/NEOP-V3-ALIGNMENT.md`;
    if (app.alignment_doc !== expectedDoc || !existsSync(path.join(root, expectedDoc))) fail(`${id} is missing its app-owned alignment document`);
    if (!Array.isArray(app.product_gaps) || !app.product_gaps.length || app.product_gaps.some((gap) => typeof gap !== 'string' || !gap.trim())) fail(`${id} must name its remaining product gaps`);
    if (!Array.isArray(app.evidence)) fail(`${id} evidence must be a list`);

    const verifiedGates: GateId[] = [];
    for (const reference of app.evidence) {
      if (typeof reference !== 'string') fail(`${id} evidence entries must be report references, not self-attested objects`);
      const safe = safeRelativeFile(reference, `${id} evidence reference`);
      const gate = validateGateEvidence(readJsonFile(root, safe, `${id} gate evidence`), safe, id, root);
      if (verifiedGates.includes(gate)) fail(`${id} repeats evidence for the ${gate} gate`);
      verifiedGates.push(gate);
    }
    verifiedGates.sort((a, b) => TEMPLATE_GATES.findIndex(([id]) => id === a) - TEMPLATE_GATES.findIndex(([id]) => id === b));
    if (verifiedGates.length > 0 && verifiedGates.length < TEMPLATE_GATES.length && app.assessment !== 'partial') fail(`${id} with partial gate evidence must have assessment partial`);
    if (verifiedGates.length === TEMPLATE_GATES.length && app.assessment !== 'aligned') fail(`${id} with complete gate evidence must have assessment aligned`);
    if (verifiedGates.length === 0 && app.assessment === 'aligned') fail(`${id} cannot be assessed aligned without gate evidence`);

    appStatuses.push({
      id,
      assessment: app.assessment,
      verified_gates: verifiedGates,
      required_gates: TEMPLATE_GATES.length,
      template_aligned: verifiedGates.length === TEMPLATE_GATES.length,
    });
  }

  return {
    repository: PINNED_TEMPLATE_REPOSITORY,
    commit: PINNED_TEMPLATE_COMMIT,
    template_version: PINNED_TEMPLATE_VERSION,
    direct_template_sync_allowed: false,
    total: appStatuses.length,
    aligned: appStatuses.filter((app) => app.template_aligned).length,
    apps: appStatuses,
  };
}

export function validatePinnedTemplateArchiveEntries(entries: string[], templateBytes: Buffer): { template_version: string; checked_archive_paths: number } {
  const archiveRoot = `neos-neop-template-${PINNED_TEMPLATE_COMMIT}/`;
  if (!entries.length || entries.some((entry) => !entry.startsWith(archiveRoot) || entry.includes('/../') || entry.includes('\\'))) fail('pinned upstream archive has an unexpected root or unsafe entry');
  const template = JSON.parse(templateBytes.toString('utf8')) as unknown;
  if (!isObject(template) || template.name !== 'neos-neop-template' || template.templateVersion !== PINNED_TEMPLATE_VERSION) fail('verified upstream template identity/version does not match the pin');

  const requiredPaths = [...new Set(Object.values(PINNED_TEMPLATE_PATHS).flat())];
  for (const relative of requiredPaths) {
    const entry = `${archiveRoot}${relative}`;
    const exactFile = !PINNED_TEMPLATE_DIRECTORIES.has(relative) && entries.includes(entry);
    const populatedDirectory = entries.some((candidate) => candidate.startsWith(`${entry}/`) && candidate !== `${entry}/`);
    if (PINNED_TEMPLATE_DIRECTORIES.has(relative) ? !populatedDirectory : !exactFile) fail(`verified upstream archive path is missing, empty or has the wrong type: ${relative}`);
  }
  return { template_version: template.templateVersion, checked_archive_paths: requiredPaths.length };
}

export function verifyPinnedTemplateArchive(archivePath: string): TemplateSourceVerification {
  if (!existsSync(archivePath)) fail('pinned upstream archive is missing');
  const archiveSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (archiveSha256 !== PINNED_TEMPLATE_ARCHIVE_SHA256) fail('pinned upstream archive bytes do not match the reviewed digest');

  const archiveRoot = `neos-neop-template-${PINNED_TEMPLATE_COMMIT}/`;
  let entries: string[];
  let templateBytes: Buffer;
  try {
    entries = execFileSync('unzip', ['-Z1', path.resolve(archivePath)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n').filter(Boolean);
    templateBytes = execFileSync('unzip', ['-p', path.resolve(archivePath), `${archiveRoot}template.json`], { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    fail('pinned upstream archive cannot be inspected safely (system unzip is required)');
  }
  return { archive_sha256: archiveSha256, ...validatePinnedTemplateArchiveEntries(entries, templateBytes!) };
}

export function templateAlignmentStatus(root = ROOT): TemplateAlignmentStatus {
  const catalog = JSON.parse(readFileSync(path.join(root, 'fleet/catalog.json'), 'utf8')) as Catalog;
  const alignment = JSON.parse(readFileSync(path.join(root, 'fleet/template-alignment.json'), 'utf8')) as unknown;
  return validateTemplateAlignment(alignment, catalog, root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = templateAlignmentStatus();
  const archiveIndex = process.argv.indexOf('--verify-archive');
  if (archiveIndex >= 0 && !process.argv[archiveIndex + 1]) fail('--verify-archive needs an archive path');
  const sourceVerification = archiveIndex >= 0
    ? verifyPinnedTemplateArchive(process.argv[archiveIndex + 1]!)
    : undefined;
  console.log(JSON.stringify(sourceVerification ? { ...report, source_verification: sourceVerification } : report, null, 2));
  if (process.argv.includes('--require-aligned') && report.aligned !== report.total) process.exitCode = 1;
}
