import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAlignmentSourceDigest,
  FLEET_APP_IDS,
  type GateId,
  PINNED_TEMPLATE_COMMIT,
  PINNED_TEMPLATE_DIRECTORIES,
  PINNED_TEMPLATE_PATHS,
  ROOT,
  TEMPLATE_GATES,
  templateAlignmentStatus,
  templateGateCommand,
  templateGateEvidencePath,
  templateGateReportPath,
  templateGateTestFile,
  validatePinnedTemplateArchiveEntries,
  validateTemplateAlignment,
} from '../template-alignment.ts';
import { parseTemplateGateArgs } from '../run-template-gate.ts';

const catalog = JSON.parse(readFileSync(path.join(ROOT, 'fleet/catalog.json'), 'utf8'));
const baseline = () => {
  const data = JSON.parse(readFileSync(path.join(ROOT, 'fleet/template-alignment.json'), 'utf8'));
  for (const app of data.apps) {
    app.assessment = 'gap';
    app.evidence = [];
  }
  return data;
};
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureRoot(data: any, testApp = 'ledger') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-template-alignment-'));
  temporary.push(root);
  for (const file of [data.strategy.decision, data.strategy.plan]) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '# synthetic strategy fixture\n');
  }
  for (const app of data.apps) {
    const doc = path.join(root, app.alignment_doc);
    await mkdir(path.dirname(doc), { recursive: true });
    await writeFile(doc, `# ${app.id}\n`);
  }
  for (const [, suite] of TEMPLATE_GATES) {
    const file = path.join(root, 'apps', testApp, 'tests', suite);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// synthetic alignment evidence fixture\n');
  }
  return root;
}

function git(root: string, args: string[], output = false) {
  if (output) return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  return '';
}

function commitFixture(root: string) {
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Alignment Fixture', '-c', 'user.email=alignment@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture source']);
  return git(root, ['rev-parse', 'HEAD'], true);
}

function passingReport(root: string, app: string, gate: GateId) {
  const testFile = templateGateTestFile(app, gate);
  return {
    // Vitest counts both the file-level suite and nested describe blocks here.
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [{
      name: path.join(root, testFile),
      status: 'passed',
      assertionResults: [{ status: 'passed', title: 'proves the gate' }],
    }],
  };
}

async function addGateEvidence(data: any, root: string, app = 'ledger', gate: GateId = 'ownership') {
  const sourceCommit = commitFixture(root);
  const source = computeAlignmentSourceDigest(root, app);
  const reportPath = templateGateReportPath(app, gate);
  const reportBytes = Buffer.from(JSON.stringify(passingReport(root, app, gate), null, 2) + '\n');
  await mkdir(path.dirname(path.join(root, reportPath)), { recursive: true });
  await writeFile(path.join(root, reportPath), reportBytes);
  const evidencePath = templateGateEvidencePath(app, gate);
  const evidence = {
    schema_version: 1,
    app,
    gate,
    template_commit: PINNED_TEMPLATE_COMMIT,
    source_commit: sourceCommit,
    source_sha256: source.sha256,
    test_file: templateGateTestFile(app, gate),
    runner: {
      kind: 'vitest-json-v1',
      command: templateGateCommand(app, gate),
      report: reportPath,
      report_sha256: createHash('sha256').update(reportBytes).digest('hex'),
    },
  };
  await writeFile(path.join(root, evidencePath), JSON.stringify(evidence, null, 2) + '\n');
  const target = data.apps.find((candidate: any) => candidate.id === app);
  target.assessment = 'partial';
  target.evidence = [evidencePath];
  return { evidence, evidencePath, reportPath };
}

describe('pinned upstream template alignment', () => {
  it('accepts only catalogued apps and reviewed gates in the gate runner', () => {
    expect(parseTemplateGateArgs(['--app', 'wage', '--gate', 'ownership'])).toEqual({ app: 'wage', gate: 'ownership' });
    expect(() => parseTemplateGateArgs(['--app', 'other', '--gate', 'ownership'])).toThrow(/usage/);
    expect(() => parseTemplateGateArgs(['--app', 'wage', '--gate', 'other'])).toThrow(/usage/);
  });

  it('accounts for the exact twenty without claiming one is aligned', () => {
    const report = templateAlignmentStatus();
    expect(report.commit).toBe(PINNED_TEMPLATE_COMMIT);
    expect(report.template_version).toBe('0.8.16');
    expect(report.direct_template_sync_allowed).toBe(false);
    expect(report.total).toBe(20);
    expect(report.aligned).toBe(0);
    expect(report.apps.every((app) => app.verified_gates.length === 1 && app.verified_gates[0] === 'ownership' && !app.template_aligned)).toBe(true);
  });

  it.each([
    ['repository', (data: any) => { data.upstream.repository = 'https://github.com/example/template'; }],
    ['moving commit', (data: any) => { data.upstream.commit = 'main'; }],
    ['another full commit', (data: any) => { data.upstream.commit = 'a'.repeat(40); }],
    ['template version', (data: any) => { data.upstream.template_version = '0.8.14'; }],
    ['archive digest', (data: any) => { data.upstream.archive_sha256 = 'c'.repeat(64); }],
  ])('rejects an unreviewed %s pin', async (_name, mutate) => {
    const data = baseline();
    mutate(data);
    const root = await fixtureRoot(data);
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/invalid fleet template alignment/);
  });

  it('requires evidence schema v2', async () => {
    const data = baseline();
    data.schema_version = 1;
    const root = await fixtureRoot(data);
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/schema_version must be 2/);
  });

  it('rejects missing, extra or reordered apps and gates', async () => {
    for (const mutate of [
      (data: any) => data.apps.pop(),
      (data: any) => data.apps.push({ ...data.apps[0], id: 'other' }),
      (data: any) => data.apps.reverse(),
      (data: any) => data.required_gates.pop(),
      (data: any) => data.required_gates.push({ ...data.required_gates[0], id: 'other' }),
      (data: any) => data.required_gates.reverse(),
      (data: any) => data.required_gates[0].upstream.reverse(),
      (data: any) => data.required_gates[0].upstream[0] = 'README.md',
    ]) {
      const data = baseline();
      mutate(data);
      const root = await fixtureRoot(data);
      expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/invalid fleet template alignment/);
    }
  });

  it('rejects an empty, renamed or duplicate catalog scope', async () => {
    const cases = [
      { ...catalog, apps: [] },
      { ...catalog, selection: 'anything_else' },
      { ...catalog, apps: catalog.apps.map((app: any, index: number) => index === 1 ? { ...app, id: 'ledger' } : app) },
    ];
    const data = baseline();
    const root = await fixtureRoot(data);
    for (const invalidCatalog of cases) {
      expect(() => validateTemplateAlignment(data, invalidCatalog, root)).toThrow(/invalid fleet template alignment/);
    }
  });

  it('refuses self-attested evidence objects instead of report references', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    data.apps[0].evidence = [{ gate: 'ownership', passed: 1 }];
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/report references/);
  });

  it('does not treat expected filenames as passing evidence', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    const report = validateTemplateAlignment(data, catalog, root);
    expect(report.apps[0]).toMatchObject({ id: 'ledger', verified_gates: [], template_aligned: false });
  });

  it('accepts a canonical report-bound gate and derives partial status', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    await addGateEvidence(data, root);
    const report = validateTemplateAlignment(data, catalog, root);
    expect(report.apps[0]).toMatchObject({
      id: 'ledger',
      assessment: 'partial',
      verified_gates: ['ownership'],
      template_aligned: false,
    });
  });

  it('rejects report tampering even when the evidence object still claims success', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    const { reportPath } = await addGateEvidence(data, root);
    const report = JSON.parse(await readFile(path.join(root, reportPath), 'utf8'));
    report.success = false;
    await writeFile(path.join(root, reportPath), JSON.stringify(report));
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/report digest does not match/);
  });

  it('rejects a digest-bound report with skipped assertions', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    const { evidence, evidencePath, reportPath } = await addGateEvidence(data, root);
    const report = passingReport(root, 'ledger', 'ownership');
    report.numPassedTests = 0;
    report.numPendingTests = 1;
    report.testResults[0]!.assertionResults[0]!.status = 'pending';
    const bytes = Buffer.from(JSON.stringify(report));
    await writeFile(path.join(root, reportPath), bytes);
    evidence.runner.report_sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(root, evidencePath), JSON.stringify(evidence));
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/passed test count|pending/);
  });

  it('rejects source changes and untracked app files after the recorded commit', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    await addGateEvidence(data, root);
    await writeFile(path.join(root, templateGateTestFile('ledger', 'ownership')), '// changed after evidence\n');
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/source digest does not match/);

    const second = baseline();
    const secondRoot = await fixtureRoot(second);
    await addGateEvidence(second, secondRoot);
    await writeFile(path.join(secondRoot, 'apps/ledger/src/untracked.ts'), 'export {};\n', { flag: 'w' }).catch(async () => {
      await mkdir(path.join(secondRoot, 'apps/ledger/src'), { recursive: true });
      await writeFile(path.join(secondRoot, 'apps/ledger/src/untracked.ts'), 'export {};\n');
    });
    expect(() => validateTemplateAlignment(second, catalog, secondRoot)).toThrow(/source digest does not match|untracked files/);
  });

  it('rejects noncanonical evidence paths, commands and source commits', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    const { evidence, evidencePath } = await addGateEvidence(data, root);
    data.apps[0].evidence = ['docs/evidence/template-alignment/ledger/renamed.json'];
    await writeFile(path.join(root, 'docs/evidence/template-alignment/ledger/renamed.json'), JSON.stringify(evidence));
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/canonical path/);

    data.apps[0].evidence = [evidencePath];
    evidence.runner.command = ['vitest', 'run'];
    await writeFile(path.join(root, evidencePath), JSON.stringify(evidence));
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/runner command/);

    evidence.runner.command = templateGateCommand('ledger', 'ownership');
    evidence.source_commit = 'f'.repeat(40);
    await writeFile(path.join(root, evidencePath), JSON.stringify(evidence));
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/not present/);
  });

  it('requires assessment to match the derived evidence state', async () => {
    const data = baseline();
    const root = await fixtureRoot(data);
    await addGateEvidence(data, root);
    data.apps[0].assessment = 'gap';
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/assessment partial/);

    const empty = baseline();
    const emptyRoot = await fixtureRoot(empty);
    empty.apps[0].assessment = 'aligned';
    expect(() => validateTemplateAlignment(empty, catalog, emptyRoot)).toThrow(/cannot be assessed aligned/);
  });

  it('refuses a stored completion boolean', async () => {
    const data = baseline();
    data.apps[0].template_aligned = true;
    const root = await fixtureRoot(data);
    expect(() => validateTemplateAlignment(data, catalog, root)).toThrow(/must not store a template_aligned claim/);
  });

  it('validates mapped paths inside the pinned archive inventory, including populated directories', () => {
    const archiveRoot = `neos-neop-template-${PINNED_TEMPLATE_COMMIT}/`;
    const required = [...new Set(Object.values(PINNED_TEMPLATE_PATHS).flat())];
    const entries = [archiveRoot, ...required.flatMap((relative) => PINNED_TEMPLATE_DIRECTORIES.has(relative)
      ? [`${archiveRoot}${relative}/`, `${archiveRoot}${relative}/fixture.txt`]
      : [`${archiveRoot}${relative}`])];
    const template = Buffer.from(JSON.stringify({ name: 'neos-neop-template', templateVersion: '0.8.16' }));
    expect(validatePinnedTemplateArchiveEntries(entries, template)).toEqual({ template_version: '0.8.16', checked_archive_paths: required.length });

    const withoutDirectoryContents = entries.filter((entry) => entry !== `${archiveRoot}frontend/fixture.txt`);
    expect(() => validatePinnedTemplateArchiveEntries(withoutDirectoryContents, template)).toThrow(/wrong type/);
    const wrongRoot = entries.map((entry) => entry.replace(archiveRoot, `neos-neop-template-${'f'.repeat(40)}/`));
    expect(() => validatePinnedTemplateArchiveEntries(wrongRoot, template)).toThrow(/unexpected root/);
    expect(FLEET_APP_IDS).toHaveLength(20);
  });
});
