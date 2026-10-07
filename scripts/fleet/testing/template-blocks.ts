import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { blocksProblem, type Manifest, type ManifestAbility } from '../../../packages/contracts/src/index.ts';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(absolute: string, label: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    problems.push(`${label} is not valid JSON`);
    return undefined;
  }
}

function sourceAbilities(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) sourceAbilities(entry, found);
  else if (isObject(value)) {
    if (typeof value.ability === 'string') found.add(value.ability);
    for (const entry of Object.values(value)) sourceAbilities(entry, found);
  }
  return found;
}

function provenanceProblem(ability: ManifestAbility): string | null {
  const output = ability.output;
  if (!isObject(output) || output.type !== 'object' || !isObject(output.properties) || !Array.isArray(output.required)) {
    return `${ability.key} output must be a closed object contract`;
  }
  for (const field of ['generatedAt', 'empty', 'sources']) {
    if (!output.required.includes(field) || !(field in output.properties)) return `${ability.key} output must require ${field}`;
  }
  const sources = output.properties.sources;
  if (!isObject(sources) || sources.type !== 'object' || !isObject(sources.properties) || !Array.isArray(sources.required)) {
    return `${ability.key} sources must be an object contract`;
  }
  for (const field of ['entries', 'entry_ids', 'basis']) {
    if (!sources.required.includes(field) || !(field in sources.properties)) return `${ability.key} sources must require ${field}`;
  }
  return null;
}

export function templateBlocksProblems(root: string, app: string): string[] {
  const problems: string[] = [];
  const appRoot = path.join(root, 'apps', app);
  const manifestValue = readJson(path.join(appRoot, 'manifest.json'), `${app} manifest`, problems);
  if (!isObject(manifestValue) || manifestValue.app !== app || !Array.isArray(manifestValue.abilities) || !Array.isArray(manifestValue.blocks)) {
    problems.push(`${app} manifest does not expose abilities and blocks`);
    return problems;
  }
  const manifest = manifestValue as unknown as Manifest;
  const declared = [...manifest.blocks].sort();
  const blocksDir = path.join(appRoot, 'blocks');
  const actual = readdirSync(blocksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => `blocks/${entry.name}`)
    .sort();
  if (JSON.stringify(declared) !== JSON.stringify(actual)) problems.push(`${app} manifest must declare every JSON block file exactly once`);
  if (new Set(declared).size !== declared.length) problems.push(`${app} manifest repeats a block file`);

  const blocks: Record<string, unknown> = {};
  for (const relative of declared) {
    if (!/^blocks\/[a-z0-9._-]+\.json$/.test(relative)) {
      problems.push(`${app} block path is unsafe: ${relative}`);
      continue;
    }
    const absolute = path.join(appRoot, relative);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      problems.push(`${app} block is missing, not regular, or linked: ${relative}`);
      continue;
    }
    blocks[path.basename(relative, '.json')] = readJson(absolute, `${app} ${relative}`, problems);
  }
  const shape = blocksProblem(blocks, manifest);
  if (shape) problems.push(shape);

  const byKey = new Map(manifest.abilities.map((ability) => [ability.key, ability]));
  for (const key of sourceAbilities(blocks)) {
    const ability = byKey.get(key);
    if (!ability || ability.kind !== 'read') {
      problems.push(`${app} block source ${key} is not an app-owned read`);
      continue;
    }
    const provenance = provenanceProblem(ability);
    if (provenance) problems.push(provenance);
  }
  return [...new Set(problems)].sort();
}
