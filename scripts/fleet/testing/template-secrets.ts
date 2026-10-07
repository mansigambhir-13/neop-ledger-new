import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { templateRuntimeCredentialProblems } from './template-runtime-credentials.ts';
import { templateRuntimeProcessProblems } from './template-runtime-processes.ts';
import type { FleetApp } from '../runtime/apps.ts';

const PROVIDER = [
  /\bsk-or-v1-[0-9a-f]{16,}/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bsyt_[A-Za-z0-9_]{8,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@"'`]*):([^@\s"'`/]+)@/gi;
const NAMED_ASSIGNMENT = /(?<![A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|ApiKey|AccessToken))['")\]]*\s*(?::|=(?![=>]))\s*(["'`])((?:(?!\2)[^\n])*)\2/g;
const MARKED = (value: string) => !value || /^synthetic-/.test(value) || /^(?:…|\.\.\.|<[^>]+>|your[_-]|\*{3})/i.test(value) || /\$\{/.test(value) || /^\$[A-Za-z_]/.test(value) || /^x-[a-z0-9-]+$/.test(value);

export function unmarkedSecrets(text: string): string[] {
  const findings: string[] = [];
  for (const expression of PROVIDER) for (const match of text.matchAll(expression)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 48), match.index);
    if (!/synthetic-[^\s"'`]*$/.test(before)) findings.push(`provider token ${match[0]!.slice(0, 24)}`);
  }
  for (const match of text.matchAll(URL_PASSWORD)) if (!/^(?:…|\.\.\.|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(match[2]!)) findings.push(`credential in URL ${match[0]!.replace(match[2]!, '…')}`);
  for (const match of text.matchAll(NAMED_ASSIGNMENT)) if (!MARKED(match[3]!)) findings.push(`unmarked credential assignment ${match[1]}`);
  return [...new Set(findings)].sort();
}

function tracked(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

export async function templateSecretProblems(root: string, app: FleetApp): Promise<string[]> {
  const problems: string[] = [];
  const included = [`apps/${app}/`, 'packages/', 'scripts/', 'deploy/', 'fleet/', 'package.json', 'pnpm-lock.yaml'];
  const skipped = [/node_modules\//, /^reference\//, /^docs\/evidence\//, /\.vitest\.json$/, /template-secrets\.ts$/];
  for (const file of tracked(root)) {
    if (!included.some((prefix) => file === prefix || file.startsWith(prefix)) || skipped.some((expression) => expression.test(file))) continue;
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue;
    let text: string;
    try { text = readFileSync(absolute, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const finding of unmarkedSecrets(text)) problems.push(`${file}: ${finding}`);
  }
  for (const process of ['backend', 'agent', 'frontend']) {
    const dockerfile = readFileSync(path.join(root, 'deploy/fleet', `${process}.Dockerfile`), 'utf8');
    if (!/RUN chmod -R a\+rX \/srv\s+USER node/.test(dockerfile)) problems.push(`${process} image depends on source checkout modes`);
  }
  problems.push(...await templateRuntimeCredentialProblems(root, app));
  problems.push(...templateRuntimeProcessProblems(root, app));
  return [...new Set(problems)].sort();
}
