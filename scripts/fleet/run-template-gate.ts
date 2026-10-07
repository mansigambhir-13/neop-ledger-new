import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAlignmentSourceAtCommit,
  computeAlignmentSourceDigest,
  FLEET_APP_IDS,
  type FleetAppId,
  type GateEvidence,
  type GateId,
  PINNED_TEMPLATE_COMMIT,
  ROOT,
  TEMPLATE_GATES,
  templateGateCommand,
  templateGateEvidencePath,
  templateGateReportPath,
  templateGateTestFile,
  validateGateEvidence,
  validateVitestGateReport,
} from './template-alignment.ts';

function usage(): never {
  throw new Error('usage: pnpm fleet:template-gate -- --app <fleet-app> --gate <template-gate>');
}

export function parseTemplateGateArgs(argv: string[]): { app: FleetAppId; gate: GateId } {
  const appIndex = argv.indexOf('--app');
  const gateIndex = argv.indexOf('--gate');
  const app = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  const gate = gateIndex >= 0 ? argv[gateIndex + 1] : undefined;
  if (!app || !FLEET_APP_IDS.includes(app as FleetAppId)) usage();
  if (!gate || !TEMPLATE_GATES.some(([id]) => id === gate)) usage();
  return { app: app as FleetAppId, gate: gate as GateId };
}

function headCommit(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function runTemplateGate(app: FleetAppId, gate: GateId, root = ROOT): GateEvidence {
  const sourceCommit = headCommit(root);
  assertAlignmentSourceAtCommit(root, app, sourceCommit);
  const sourceBefore = computeAlignmentSourceDigest(root, app);
  const testFile = templateGateTestFile(app, gate);
  const reportPath = templateGateReportPath(app, gate);
  const evidencePath = templateGateEvidencePath(app, gate);
  const reportAbsolute = path.join(root, reportPath);
  const evidenceAbsolute = path.join(root, evidencePath);
  if (existsSync(evidenceAbsolute)) throw new Error(`${app}/${gate} already has an evidence file; remove it only through reviewed evidence replacement`);
  mkdirSync(path.dirname(reportAbsolute), { recursive: true });
  rmSync(reportAbsolute, { force: true });

  const command = templateGateCommand(app, gate);
  const run = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${app}/${gate} gate failed with exit ${run.status ?? 'unknown'}`);

  const reportBytes = readFileSync(reportAbsolute);
  const report = JSON.parse(reportBytes.toString('utf8')) as unknown;
  validateVitestGateReport(report, root, testFile);
  const sourceAfter = computeAlignmentSourceDigest(root, app);
  if (sourceAfter.sha256 !== sourceBefore.sha256) throw new Error(`${app}/${gate} source changed while the gate was running`);
  assertAlignmentSourceAtCommit(root, app, sourceCommit);

  const evidence: GateEvidence = {
    schema_version: 1,
    app,
    gate,
    template_commit: PINNED_TEMPLATE_COMMIT,
    source_commit: sourceCommit,
    source_sha256: sourceBefore.sha256,
    test_file: testFile,
    runner: {
      kind: 'vitest-json-v1',
      command,
      report: reportPath,
      report_sha256: createHash('sha256').update(reportBytes).digest('hex'),
    },
  };
  writeFileSync(evidenceAbsolute, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  validateGateEvidence(evidence, evidencePath, app, root);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, gate } = parseTemplateGateArgs(process.argv.slice(2));
  const evidence = runTemplateGate(app, gate);
  console.log(JSON.stringify({
    status: 'verified_gate_evidence_created',
    app,
    gate,
    evidence: templateGateEvidencePath(app, gate),
    source_commit: evidence.source_commit,
    source_sha256: evidence.source_sha256,
    next: `add ${templateGateEvidencePath(app, gate)} to ${app}.evidence in fleet/template-alignment.json and set assessment to partial`,
  }, null, 2));
}
