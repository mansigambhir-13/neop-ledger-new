import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PINNED_TEMPLATE_COMMIT } from '../template-alignment.ts';
import { templateOwnershipStatus } from '../template-ownership.ts';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeAppPath(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/')) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && value.startsWith(prefix) && !value.split('/').includes('..');
}

function inspectPath(root: string, relative: string, kind: 'file' | 'directory', problems: string[]) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) {
    problems.push(`${relative} is missing`);
    return;
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    problems.push(`${relative} must not be a symbolic link`);
    return;
  }
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) problems.push(`${relative} must be a ${kind}`);
}

function findSymlinks(root: string, relative: string, problems: string[]) {
  const absolute = path.join(root, relative);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) problems.push(`${child} must not be a symbolic link`);
    else if (entry.isDirectory()) findSymlinks(root, child, problems);
  }
}

export function templateOwnershipProblems(root: string, app: string): string[] {
  const problems: string[] = [];
  const ownership = templateOwnershipStatus(root);
  if (ownership.total !== 41) problems.push(`ownership crosswalk has ${ownership.total} rules instead of 41`);

  const catalog = JSON.parse(readFileSync(path.join(root, 'fleet/catalog.json'), 'utf8')) as unknown;
  if (!isObject(catalog) || !Array.isArray(catalog.apps) || !catalog.apps.some((entry) => isObject(entry) && entry.id === app)) {
    problems.push(`${app} is not in the governed fleet catalog`);
  }

  const appRoot = `apps/${app}`;
  inspectPath(root, appRoot, 'directory', problems);
  if (!existsSync(path.join(root, appRoot)) || !lstatSync(path.join(root, appRoot)).isDirectory()) return problems;
  for (const relative of ['manifest.json', 'package.json', 'src/index.ts', 'src/agent/SYSTEM.md', 'NEOP-V3-ALIGNMENT.md']) {
    inspectPath(root, `${appRoot}/${relative}`, 'file', problems);
  }
  for (const relative of ['src/domain', 'migrations', 'blocks', 'tests']) {
    inspectPath(root, `${appRoot}/${relative}`, 'directory', problems);
  }
  findSymlinks(root, appRoot, problems);

  for (const forbidden of [
    'src/gate',
    'src/presence',
    'src/domain/proposals.mjs',
    'src/domain/rules.mjs',
    'migrations/checksum.mjs',
    'deploy',
  ]) {
    if (existsSync(path.join(root, appRoot, forbidden))) problems.push(`${appRoot}/${forbidden} copies template-owned runtime into the app`);
  }

  const manifestPath = path.join(root, appRoot, 'manifest.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    problems.push(`${appRoot}/manifest.json is not valid JSON`);
  }
  if (isObject(manifest)) {
    if (manifest.app !== app) problems.push(`${appRoot}/manifest.json app must be ${app}`);
    if (!Array.isArray(manifest.skills)) problems.push(`${appRoot}/manifest.json skills must be an array`);
    else for (const [index, skill] of manifest.skills.entries()) {
      if (!isObject(skill) || !safeAppPath(skill.path, 'src/agent/skills/')) {
        problems.push(`${appRoot}/manifest.json skills[${index}].path must stay in src/agent/skills`);
      } else inspectPath(root, `${appRoot}/${skill.path}`, 'file', problems);
    }
    if (!Array.isArray(manifest.blocks)) problems.push(`${appRoot}/manifest.json blocks must be an array`);
    else for (const [index, block] of manifest.blocks.entries()) {
      if (!safeAppPath(block, 'blocks/')) problems.push(`${appRoot}/manifest.json blocks[${index}] must stay in blocks`);
      else inspectPath(root, `${appRoot}/${block}`, 'file', problems);
    }
  }

  const alignmentPath = path.join(root, appRoot, 'NEOP-V3-ALIGNMENT.md');
  if (existsSync(alignmentPath)) {
    const alignment = readFileSync(alignmentPath, 'utf8');
    if (!alignment.includes(PINNED_TEMPLATE_COMMIT)) problems.push(`${appRoot}/NEOP-V3-ALIGNMENT.md does not name the pinned commit`);
    if (!/\*\*\d+\/12 alignment gates verified\*\*/.test(alignment)) problems.push(`${appRoot}/NEOP-V3-ALIGNMENT.md must state its verified gate count`);
  }

  return problems;
}
