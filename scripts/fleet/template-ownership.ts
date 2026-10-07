import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PINNED_TEMPLATE_COMMIT,
  PINNED_TEMPLATE_REPOSITORY,
  PINNED_TEMPLATE_VERSION,
  ROOT,
} from './template-alignment.ts';

export const PINNED_TEMPLATE_RULES_SHA256 = '14cb7afc0de6ceda640e91f6baf994cef701c9a12e523d04fd0dd7f4e1c48aa0';
export const TEMPLATE_OWNERSHIP_PATH = 'fleet/template-ownership.json';

const OWNERS = ['app', 'template', 'installer', 'generated'] as const;
const STATES = ['mapped', 'adapter_required', 'missing', 'conflict'] as const;
const STRATEGIES = [
  'app_owned',
  'compatibility_test',
  'development_fixture',
  'documented_deviation',
  'forward_migration',
  'generated_contract',
  'installer_boundary',
  'repository_policy',
  'shared_deployment',
  'shared_frontend',
  'shared_runtime',
  'typed_app_contract',
] as const;

type JsonObject = Record<string, unknown>;
type Owner = typeof OWNERS[number];
export type OwnershipState = typeof STATES[number];
type Strategy = typeof STRATEGIES[number];

interface UpstreamRule {
  path: string;
  owner: Owner;
  seed?: true;
  render?: true;
  migration?: true;
}

export interface OwnershipMapping extends UpstreamRule {
  state: OwnershipState;
  strategy: Strategy;
  fleet_paths: string[];
  note: string;
}

export interface TemplateOwnershipReport {
  repository: string;
  commit: string;
  template_version: string;
  rules_sha256: string;
  total: number;
  counts: Record<OwnershipState, number>;
  ready: boolean;
  mappings: OwnershipMapping[];
}

export interface TemplateOwnershipSourceVerification {
  template_directory: string;
  commit: string;
  template_version: string;
  rules_sha256: string;
  rules: number;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`invalid fleet template ownership: ${message}`);
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is unsupported`);
  return value as T[number];
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function safePattern(value: unknown, label: string): string {
  const candidate = nonemptyString(value, label);
  if (candidate.includes('\\') || candidate.startsWith('/') || candidate.includes('\0')) {
    fail(`${label} must be a safe repository-relative pattern`);
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label} must be a safe repository-relative pattern`);
  }
  return candidate;
}

function optionalTrue(value: unknown, label: string): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) fail(`${label} may only be true when present`);
  return true;
}

function parseRule(value: unknown, index: number, includeMapping: false): UpstreamRule;
function parseRule(value: unknown, index: number, includeMapping: true): OwnershipMapping;
function parseRule(value: unknown, index: number, includeMapping: boolean): UpstreamRule | OwnershipMapping {
  if (!isObject(value)) fail(`mapping ${index + 1} must be an object`);
  const ruleKeys = ['path', 'owner'];
  if ('seed' in value) ruleKeys.push('seed');
  if ('render' in value) ruleKeys.push('render');
  if ('migration' in value) ruleKeys.push('migration');
  const expected = includeMapping ? [...ruleKeys, 'state', 'strategy', 'fleet_paths', 'note'] : ruleKeys;
  exactKeys(value, expected, `mapping ${index + 1}`);

  const rule: UpstreamRule = {
    path: safePattern(value.path, `mapping ${index + 1} path`),
    owner: enumValue(value.owner, OWNERS, `mapping ${index + 1} owner`),
  };
  const seed = optionalTrue(value.seed, `mapping ${index + 1} seed`);
  const render = optionalTrue(value.render, `mapping ${index + 1} render`);
  const migration = optionalTrue(value.migration, `mapping ${index + 1} migration`);
  if (seed) rule.seed = true;
  if (render) rule.render = true;
  if (migration) rule.migration = true;
  if (!includeMapping) return rule;

  if (!Array.isArray(value.fleet_paths) || value.fleet_paths.length === 0) {
    fail(`mapping ${index + 1} fleet_paths must be a non-empty array`);
  }
  const fleetPaths = value.fleet_paths.map((entry, pathIndex) => safePattern(entry, `mapping ${index + 1} fleet_paths[${pathIndex}]`));
  if (new Set(fleetPaths).size !== fleetPaths.length) fail(`mapping ${index + 1} repeats a fleet path`);
  return {
    ...rule,
    state: enumValue(value.state, STATES, `mapping ${index + 1} state`),
    strategy: enumValue(value.strategy, STRATEGIES, `mapping ${index + 1} strategy`),
    fleet_paths: fleetPaths,
    note: nonemptyString(value.note, `mapping ${index + 1} note`),
  };
}

function upstreamRule(mapping: OwnershipMapping): UpstreamRule {
  const rule: UpstreamRule = { path: mapping.path, owner: mapping.owner };
  if (mapping.seed) rule.seed = true;
  if (mapping.render) rule.render = true;
  if (mapping.migration) rule.migration = true;
  return rule;
}

export function templateRulesDigest(rules: readonly UpstreamRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

export function validateTemplateOwnership(value: unknown): TemplateOwnershipReport {
  if (!isObject(value)) fail('root must be an object');
  exactKeys(value, ['schema_version', 'upstream', 'mappings'], 'root');
  if (value.schema_version !== 1) fail('schema_version must be 1');
  if (!isObject(value.upstream)) fail('upstream must be an object');
  exactKeys(value.upstream, ['repository', 'commit', 'template_version', 'rules_sha256'], 'upstream');
  if (value.upstream.repository !== PINNED_TEMPLATE_REPOSITORY) fail('upstream repository does not match the pin');
  if (value.upstream.commit !== PINNED_TEMPLATE_COMMIT) fail('upstream commit does not match the pin');
  if (value.upstream.template_version !== PINNED_TEMPLATE_VERSION) fail('upstream template version does not match the pin');
  if (value.upstream.rules_sha256 !== PINNED_TEMPLATE_RULES_SHA256) fail('upstream rules digest does not match the pin');
  if (!Array.isArray(value.mappings) || value.mappings.length === 0) fail('mappings must be a non-empty array');

  const mappings = value.mappings.map((mapping, index) => parseRule(mapping, index, true));
  const paths = mappings.map((mapping) => mapping.path);
  if (new Set(paths).size !== paths.length) fail('mapping paths must be unique');
  if (paths.at(-1) !== '**') fail('the upstream catch-all rule must remain last');
  const rulesSha256 = templateRulesDigest(mappings.map(upstreamRule));
  if (rulesSha256 !== PINNED_TEMPLATE_RULES_SHA256) fail('mappings do not exactly reproduce the ordered pinned upstream rules');

  const counts: Record<OwnershipState, number> = {
    mapped: 0,
    adapter_required: 0,
    missing: 0,
    conflict: 0,
  };
  for (const mapping of mappings) counts[mapping.state] += 1;
  return {
    repository: PINNED_TEMPLATE_REPOSITORY,
    commit: PINNED_TEMPLATE_COMMIT,
    template_version: PINNED_TEMPLATE_VERSION,
    rules_sha256: rulesSha256,
    total: mappings.length,
    counts,
    ready: counts.mapped === mappings.length,
    mappings,
  };
}

export function validatePinnedTemplateDefinition(value: unknown): { template_version: string; rules_sha256: string; rules: number } {
  if (!isObject(value)) fail('template.json root must be an object');
  if (value.name !== 'neos-neop-template') fail('template.json name does not match the pin');
  if (value.templateVersion !== PINNED_TEMPLATE_VERSION) fail('template.json version does not match the pin');
  if (!Array.isArray(value.rules)) fail('template.json rules must be an array');
  const rules = value.rules.map((rule, index) => parseRule(rule, index, false));
  const rulesSha256 = templateRulesDigest(rules);
  if (rulesSha256 !== PINNED_TEMPLATE_RULES_SHA256) fail('template.json rules do not match the pinned digest');
  return { template_version: PINNED_TEMPLATE_VERSION, rules_sha256: rulesSha256, rules: rules.length };
}

function readJson(absolute: string, label: string): unknown {
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) fail(`${label} is missing or is not a regular file`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function templateOwnershipStatus(root = ROOT): TemplateOwnershipReport {
  return validateTemplateOwnership(readJson(path.join(root, TEMPLATE_OWNERSHIP_PATH), TEMPLATE_OWNERSHIP_PATH));
}

export function verifyPinnedTemplateDirectory(templateDirectory: string): TemplateOwnershipSourceVerification {
  const resolved = path.resolve(templateDirectory);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) fail('template directory is missing or is not a directory');
  let commit: string;
  try {
    commit = execFileSync('git', ['-C', resolved, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('template directory is not a readable Git checkout');
  }
  if (commit !== PINNED_TEMPLATE_COMMIT) fail('template directory HEAD does not match the pinned commit');
  const definition = validatePinnedTemplateDefinition(readJson(path.join(resolved, 'template.json'), 'template directory template.json'));
  return {
    template_directory: resolved,
    commit,
    ...definition,
  };
}

export function parseTemplateOwnershipArgs(args: string[]): { templateDirectory?: string; requireReady: boolean } {
  let templateDirectory: string | undefined;
  let requireReady = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--' && index === 0) continue;
    if (argument === '--require-ready') {
      requireReady = true;
      continue;
    }
    if (argument === '--template-dir' && args[index + 1]) {
      if (templateDirectory) fail('--template-dir may only be provided once');
      templateDirectory = args[index + 1];
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${argument ?? ''}`);
  }
  return { ...(templateDirectory ? { templateDirectory } : {}), requireReady };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseTemplateOwnershipArgs(process.argv.slice(2));
  const report = templateOwnershipStatus();
  const sourceVerification = args.templateDirectory ? verifyPinnedTemplateDirectory(args.templateDirectory) : undefined;
  console.log(JSON.stringify(sourceVerification ? { ...report, source_verification: sourceVerification } : report, null, 2));
  if (args.requireReady && !report.ready) process.exitCode = 1;
}
