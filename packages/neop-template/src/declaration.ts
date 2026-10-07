import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Manifest, ManifestAbility } from '@neop/contracts';

export const FLEET_DECLARATION_SCHEMA_VERSION = 1 as const;
export const FLEET_TEMPLATE_REPOSITORY = 'https://github.com/NEOS-Ecosystem/neos-neop-template';
export const FLEET_TEMPLATE_COMMIT = '94db804f94403c15ad1279e6d30dcecc7c078b82';
export const FLEET_TEMPLATE_VERSION = '0.8.16';

export interface AppDeclaration {
  schema_version: typeof FLEET_DECLARATION_SCHEMA_VERSION;
  template: {
    repository: typeof FLEET_TEMPLATE_REPOSITORY;
    commit: typeof FLEET_TEMPLATE_COMMIT;
    version: typeof FLEET_TEMPLATE_VERSION;
  };
  role: string;
  kit: 'NEOS V3';
  catalogue_id: string;
  icon: { emoji: string };
  category: string;
  manifest: Manifest;
}

type JsonObject = Record<string, unknown>;

export interface TemplateManifest extends JsonObject {
  id: string;
  name: string;
  role: string;
  kit: string;
  version: string;
  catalogueId: string;
  schema: string;
  capabilities: JsonObject[];
  abilities: JsonObject[];
  skills: JsonObject[];
  blocks: JsonObject[];
  runtime: JsonObject;
}

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export function declarationProblems(value: unknown, expectedApp?: string): string[] {
  if (!object(value)) return ['declaration must be an object'];
  const problems: string[] = [];
  if (value.schema_version !== FLEET_DECLARATION_SCHEMA_VERSION) problems.push(`schema_version must be ${FLEET_DECLARATION_SCHEMA_VERSION}`);
  const template = value.template;
  if (!object(template) || template.repository !== FLEET_TEMPLATE_REPOSITORY || template.commit !== FLEET_TEMPLATE_COMMIT || template.version !== FLEET_TEMPLATE_VERSION) {
    problems.push('template must exactly identify the pinned v0.8.16 source');
  }
  if (typeof value.role !== 'string' || !value.role.trim()) problems.push('role must be non-empty');
  if (value.kit !== 'NEOS V3') problems.push('kit must be NEOS V3');
  if (typeof value.catalogue_id !== 'string' || !/^ne-[a-z][a-z0-9-]*$/.test(value.catalogue_id)) problems.push('catalogue_id must be ne-<app>');
  if (!object(value.icon) || typeof value.icon.emoji !== 'string' || !value.icon.emoji) problems.push('icon.emoji must be non-empty');
  if (typeof value.category !== 'string' || !value.category.trim()) problems.push('category must be non-empty');
  const manifest = value.manifest;
  if (!object(manifest)) problems.push('manifest must be an object');
  else {
    if (typeof manifest.app !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.app)) problems.push('manifest.app is invalid');
    if (expectedApp && manifest.app !== expectedApp) problems.push(`manifest.app must be ${expectedApp}`);
    if (value.catalogue_id !== `ne-${String(manifest.app)}`) problems.push('catalogue_id must match manifest.app');
    if (!Array.isArray(manifest.abilities) || !manifest.abilities.length) problems.push('manifest.abilities must be non-empty');
    if (!Array.isArray(manifest.skills)) problems.push('manifest.skills must be an array');
    if (!Array.isArray(manifest.blocks)) problems.push('manifest.blocks must be an array');
  }
  return problems;
}

export function readAppDeclaration(root: string, expectedApp = path.basename(root)): AppDeclaration {
  const file = path.join(root, 'app.declaration.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const problems = declarationProblems(value, expectedApp);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return value as AppDeclaration;
}

export function fleetManifest(declaration: AppDeclaration): Manifest {
  return structuredClone(declaration.manifest);
}

function title(value: string): string {
  return value.split(/[-_.]/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}

function blockContract(appRoot: string, file: string, abilities: Map<string, ManifestAbility>): JsonObject {
  if (!file.startsWith('blocks/') || file.includes('..')) throw new Error(`unsafe block path ${file}`);
  const absolute = path.join(appRoot, file);
  const block = JSON.parse(readFileSync(absolute, 'utf8')) as JsonObject;
  const source = object(block.source) ? block.source : null;
  const abilityKey = typeof source?.ability === 'string' ? source.ability : null;
  const ability = abilityKey ? abilities.get(abilityKey) : undefined;
  return {
    id: typeof block.id === 'string' ? block.id : path.basename(file, '.json'),
    kind: typeof block.block === 'string' ? block.block : 'page',
    title: typeof block.title === 'string' ? block.title : title(path.basename(file, '.json')),
    file,
    ...(abilityKey ? { source: { method: ability?.kind === 'write' ? 'POST' : 'GET', route: `/api/v1/abilities/${abilityKey}`, ability: abilityKey } } : {}),
  };
}

function credential(name: string, process: 'backend' | 'frontend', kind: 'platform-db' | 'platform-matrix' | 'operator', purpose: string): JsonObject {
  return { name, class: kind, process, required: true, secret: true, purpose };
}

function runtimeContract(app: string): JsonObject {
  const credentials = [
    credential('NEOP_APP_DB_URL', 'backend', 'platform-db', `connection for ${app}_app, restricted to the ${app} schema`),
    credential('NEOP_RUNNER_DB_URL', 'backend', 'platform-db', `connection for ${app}_runner, used by the trusted backend only`),
    credential('NEOP_DIRECT_DB_URL', 'backend', 'platform-db', 'direct database session for advisory locks and LISTEN'),
    credential('NEOP_JOB_TOKEN_SECRET', 'backend', 'operator', 'short-lived job-token signing secret; never sent to the agent'),
    credential('NEOP_LLM_SIGNING_KEY', 'backend', 'operator', 'short-lived model-session signing key; never sent to the agent'),
    credential('NEOP_MATRIX_CLIENT_ACCOUNTS', 'backend', 'platform-matrix', 'Matrix client account map and access tokens for the installed app'),
    credential('NEOP_FRONTEND_KEY', 'frontend', 'operator', 'key presented by the authenticated platform proxy to the standalone frontend'),
  ];
  const process = (name: 'backend' | 'agent' | 'frontend', port: number, health: string, build: string, command: string) => {
    const mine = credentials.filter((item) => item.process === name);
    return { name, service: `${app}-${name}`, build, command, port, health: { http: health, live: health.replace('/ready', '/live') }, receives: [...new Set(mine.map((item) => item.class))], credentials: mine.map((item) => item.name) };
  };
  return {
    run: { compose: 'deploy/compose.yaml', files: ['deploy/compose.yaml'] },
    frontend: { source: '../../packages/neop-frontend', build: 'pnpm --filter @neop/frontend typecheck', out: '../../packages/neop-frontend', servedBy: 'frontend', process: 'frontend', path: `/apps/${app}`, api: '/api/v1', backend: 'NEOS_PLATFORM_URL', basePath: 'NEOP_FRONTEND_BASE_PATH' },
    processes: [
      process('backend', 4101, 'http://127.0.0.1:4101/ready', '../../../deploy/fleet/backend.Dockerfile', 'node entry.mjs'),
      process('agent', 4103, 'http://127.0.0.1:4103/live', '../../../deploy/fleet/agent.Dockerfile', 'node entry.mjs'),
      process('frontend', 4105, 'http://127.0.0.1:4105/ready', '../../../deploy/fleet/frontend.Dockerfile', 'node entry.mjs'),
    ],
    credentials,
  };
}

export function templateManifest(declaration: AppDeclaration, appRoot: string): TemplateManifest {
  const m = declaration.manifest;
  const abilities = new Map(m.abilities.map((ability) => [ability.key, ability]));
  const capabilities = m.abilities.map((ability) => ({
    id: ability.key,
    method: ability.kind === 'read' ? 'GET' : 'POST',
    scope: `${m.app}.${ability.kind}`,
    input: ability.input,
    output: ability.output,
  }));
  const abilityLines: JsonObject[] = m.abilities.map((ability) => ({
    line: ability.key,
    kind: 'ability',
    from: 'own',
    floor: ability.floor === 'ask_first' ? 'ask' : ability.floor,
    skill: m.skills.find((skill) => skill.requires.includes(ability.key))?.key ?? null,
    offers: ability.description,
    read: ability.kind === 'read',
    capability: ability.key,
    cappable: false,
    ...(ability.kind === 'write' && ability.floor === 'on' ? { floorReason: ability.effects?.external === false ? 'the effect is internal and is verified from the company record book' : 'the declared ability contract permits this operation without an additional switchboard prompt' } : {}),
  }));
  const packageAbilities: JsonObject[] = (m.packages ?? []).flatMap((pkg) => pkg.abilities ?? []).map((ability) => ({
    line: ability.key, kind: 'ability', from: 'package', package: m.packages.find((pkg) => pkg.abilities?.some((candidate) => candidate.key === ability.key))?.key,
    floor: ability.floor === 'ask_first' ? 'ask' : ability.floor, skill: null, offers: ability.description, read: ability.kind === 'read', capability: ability.key, cappable: false,
  }));
  const talksToUses = m.uses.map((use) => use.ability);
  const asks = [...new Set(m.uses.map((use) => use.app))].sort();
  const personal = (m.personal_data ?? []).map((item) => `${item.table}.${item.columns.join(` · ${item.table}.`)}`);
  const tables = Object.fromEntries((m.personal_data ?? []).map((item) => [item.table, `(company_id, ${item.subject_key}); personal: ${item.columns.join(', ')}`]));
  const output: TemplateManifest = {
    id: m.app,
    name: m.name,
    role: declaration.role,
    kit: declaration.kit,
    version: m.version,
    catalogueId: declaration.catalogue_id,
    icon: declaration.icon,
    category: declaration.category,
    persistence: 'schema',
    schema: m.app,
    migrations: 'migrations/',
    doors: structuredClone(m.doors),
    uses: structuredClone(m.uses),
    talksTo: { asks, uses: talksToUses, offers: m.abilities.map((ability) => ability.key), line: 'ask_app', dueMinutes: 1440 },
    packages: structuredClone(m.packages),
    files: true,
    fileStore: { route: '/api/v1/files', store: 'schema', tables: ['files', 'file_blobs'], key: '<schema>/<company>/<id>', types: ['text/csv', 'application/json', 'application/pdf'], maxKb: 5120 },
    matrix: { account: 'NEOP_MATRIX_CLIENT_ACCOUNTS', mode: 'client', direct_messages_only: true },
    rooms: { direct_messages: `1:1 with ${m.name}'s account, from users on the install allowlist` },
    events: ['neos.neop.task', 'neos.neop.ask', 'neos.neop.answer', 'neos.neop.propose', 'neos.neop.approve', 'neos.neop.done', 'neos.neop.note'],
    valueClasses: { money: 'integer minor units + ISO currency', unknown: 'NULL', personalData: personal },
    scopes: [`${m.app}.read`, `${m.app}.write`],
    keys: { ...Object.fromEntries((m.personal_data ?? []).map((item) => [item.table, item.subject_key])), operations: 'idempotency_key' },
    tables: { ...tables, standard: 'jobs · steps · waits · proposals · grants · operations · facts · switchboard · installs · config · notices · schedules · files · file_blobs · source_status · demo_rows' },
    sources: [],
    switchboard: { floor: Object.fromEntries(m.abilities.filter((ability) => ability.floor !== 'on').map((ability) => [ability.key, ability.floor === 'ask_first' ? 'ask' : ability.floor])) },
    capabilities,
    abilities: [...abilityLines, ...packageAbilities,
      { line: 'ask_app', kind: 'ability', from: 'own', floor: 'on', skill: null, offers: 'ask another installed app for information or a pinned ability', read: true, capability: null, cappable: false },
      { line: 'notify_person', kind: 'ability', from: 'own', floor: 'on', skill: null, offers: 'send one rate-limited notice to an allowlisted person', read: false, capability: null, cappable: false, floorReason: 'a notice changes no company record and cannot carry an approval' },
    ],
    schedules: [],
    skills: m.skills.map((skill) => ({ id: skill.key, name: title(skill.key), offers: title(skill.key), requires: skill.requires })),
    blocks: m.blocks.map((file) => blockContract(appRoot, file, abilities)),
    runtime: runtimeContract(m.app),
  };
  return output;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function declarationContentHash(declaration: AppDeclaration, appRoot: string): string {
  return `sha256:${createHash('sha256').update(stableJson({ declaration, template_manifest: templateManifest(declaration, appRoot) })).digest('hex')}`;
}

export function assertGeneratedManifestsFresh(appRoot: string, expectedApp?: string): void {
  const declaration = readAppDeclaration(appRoot, expectedApp);
  const expectedFleet = stableJson(fleetManifest(declaration));
  const expectedTemplate = stableJson(templateManifest(declaration, appRoot));
  const fleetFile = path.join(appRoot, 'manifest.json');
  const templateFile = path.join(appRoot, 'manifest.template.json');
  if (!existsSync(fleetFile) || readFileSync(fleetFile, 'utf8') !== expectedFleet) throw new Error(`${fleetFile} is stale; run pnpm fleet:emit-manifests`);
  if (!existsSync(templateFile) || readFileSync(templateFile, 'utf8') !== expectedTemplate) throw new Error(`${templateFile} is stale; run pnpm fleet:emit-manifests`);
}
