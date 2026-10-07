import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { FLEET_APPS } from '../runtime/apps.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const AGENT_DEPENDENCIES = ['@hono/node-server', '@mariozechner/pi-agent-core', '@mariozechner/pi-ai', 'ajv', 'ajv-formats', 'hono'];
export const AGENT_FILES = [
  ...FLEET_APPS.map(app => `apps/${app}/scripts/agent.ts`),
  ...['agent', 'apps', 'config', 'process'].map(name => `scripts/fleet/runtime/${name}.ts`),
  ...['index.ts', 'worker.ts', 'extension.ts', 'prompt.ts', 'arguments.ts', 'SYSTEM.template.md'].map(name => `packages/neop-template/src/agent/${name}`),
];
export const forbiddenDependency = (name: string) => /^(?:pg(?:-|$)|postgres(?:$|-)|mysql|sqlite|better-sqlite3|deno$|@neop\/(?:pgkit|platform)$)/.test(name);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export interface Dependency {
  id: string; name: string; version: string; source: string;
  dependencies: Record<string, string>;
  unresolvedPeers: { name: string; range: string; optional: boolean }[];
  absentOptionalDependencies: string[];
}
export interface InventoryEntry { path: string; kind: 'file' | 'symlink'; sha256: string; bytes?: number; target?: string }
export interface AgentArtifact {
  format: 1; apps: readonly string[]; lockfileSha256: string; generatorSha256: string;
  dependencies: Dependency[]; inventory: InventoryEntry[];
  limitations: string[];
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function resolvePackage(from: string, name: string, root: string): Promise<string | null> {
  if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) throw new Error('invalid dependency name');
  let current = from;
  while (within(root, current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (await exists(candidate)) {
      const resolved = await realpath(candidate);
      if (!within(root, resolved)) throw new Error(`dependency outside installed workspace: ${name}`);
      return resolved;
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

export async function dependencyGraph(root: string, seedNames = AGENT_DEPENDENCIES, forbidden = forbiddenDependency): Promise<{ nodes: Dependency[]; seeds: Record<string, string> }> {
  const lock = parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const nodes: Dependency[] = [];
  const bySource = new Map<string, Dependency>();
  const seeds: Record<string, string> = {};
  async function add(dir: string): Promise<Dependency> {
    const previous = bySource.get(dir); if (previous) return previous;
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    if (!manifest.name || !manifest.version || forbidden(manifest.name)) throw new Error(`forbidden or unversioned dependency: ${manifest.name}`);
    if (!Object.hasOwn(lock.packages ?? {}, `${manifest.name}@${manifest.version}`)) throw new Error(`installed dependency is not pinned by the lockfile: ${manifest.name}@${manifest.version}`);
    const source = path.relative(root, dir);
    const node: Dependency = { id: hash(source).slice(0, 24), name: manifest.name, version: manifest.version, source, dependencies: {}, unresolvedPeers: [], absentOptionalDependencies: [] };
    nodes.push(node); bySource.set(dir, node);
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    for (const name of [...names].sort()) {
      const dependency = await resolvePackage(dir, name, root);
      if (!dependency) {
        if (name in (manifest.optionalDependencies ?? {})) node.absentOptionalDependencies.push(name);
        else if (name in (manifest.dependencies ?? {})) throw new Error(`required dependency is not installed: ${manifest.name} -> ${name}`);
        else if (manifest.peerDependenciesMeta?.[name]?.optional !== true) throw new Error(`required peer is not installed: ${manifest.name} -> ${name}`);
        else node.unresolvedPeers.push({ name, range: manifest.peerDependencies[name], optional: true });
      } else node.dependencies[name] = (await add(dependency)).id;
    }
    return node;
  }
  for (const name of seedNames) {
    const dir = await resolvePackage(path.join(root, 'packages/neop-template'), name, root);
    if (!dir) throw new Error(`agent dependency is not installed: ${name}`);
    seeds[name] = (await add(dir)).id;
  }
  return { nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)), seeds };
}

export async function copyTree(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of (await readdir(source)).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const from = path.join(source, name), to = path.join(dest, name), info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`package contains an unreviewed symlink: ${name}`);
    if (info.isDirectory()) await copyTree(from, to);
    else if (info.isFile()) {
      if (/\.(?:node|so|dylib|dll|exe)$/i.test(name)) throw new Error(`native artifact needs a target-platform build: ${name}`);
      await copyFile(from, to);
    } else throw new Error('unsupported dependency file type');
  }
}

export async function link(destination: string, target: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(path.relative(path.dirname(destination), target), destination);
}

/** Inventory does not follow symlinks; every link must terminate inside the artifact. */
export async function inventory(root: string): Promise<InventoryEntry[]> {
  // macOS /var and /private/var (or a caller's directory alias) identify the
  // same root. Compare canonical paths while still refusing escaping links.
  root = await realpath(root);
  return inventoryDirectory(root, root);
}

async function inventoryDirectory(root: string, directory: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), info = await lstat(file), relative = path.relative(root, file);
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !within(root, await realpath(file))) throw new Error(`escaping artifact link: ${relative}`);
      entries.push({ path: relative, kind: 'symlink', target, sha256: hash(target) });
    } else if (info.isDirectory()) entries.push(...await inventoryDirectory(root, file));
    else if (info.isFile()) { const bytes = await readFile(file); entries.push({ path: relative, kind: 'file', bytes: bytes.length, sha256: hash(bytes) }); }
    else throw new Error('unsupported artifact file type');
  }
  return entries;
}

/** Produce a new, explicit build context. Never overwrite an existing path or copy the repository wholesale. */
export async function createAgentContext(output: string, root = REPO): Promise<AgentArtifact> {
  root = await realpath(root);
  const out = path.resolve(output);
  if (within(out, root) || await exists(out)) throw new Error('output must be a new directory, not an existing path or workspace ancestor');
  const graph = await dependencyGraph(root);
  await mkdir(out, { recursive: true });
  const runtime = path.join(out, 'runtime');
  for (const file of AGENT_FILES) {
    const source = path.join(root, file);
    if (!(await stat(source)).isFile() || !within(root, await realpath(source))) throw new Error(`invalid source file: ${file}`);
    await mkdir(path.dirname(path.join(runtime, file)), { recursive: true });
    await copyFile(source, path.join(runtime, file));
  }
  await copyTree(path.join(root, 'packages/contracts/src'), path.join(runtime, 'packages/contracts/src'));
  await copyFile(path.join(root, 'packages/contracts/package.json'), path.join(runtime, 'packages/contracts/package.json'));
  await writeFile(path.join(runtime, 'package.json'), json({ private: true, type: 'module' }));
  await writeFile(path.join(runtime, 'packages/neop-template/package.json'), json({ name: '@neop/template', private: true, type: 'module', exports: { './agent': './src/agent/index.ts' } }));
  for (const node of graph.nodes) {
    const dest = path.join(runtime, 'node_modules/.vendor', node.id);
    await copyTree(path.join(root, node.source), dest);
    for (const [name, id] of Object.entries(node.dependencies)) await link(path.join(dest, 'node_modules', name), path.join(runtime, 'node_modules/.vendor', id));
  }
  for (const [name, id] of Object.entries(graph.seeds)) await link(path.join(runtime, 'node_modules', name), path.join(runtime, 'node_modules/.vendor', id));
  for (const name of ['contracts', 'neop-template']) await link(path.join(runtime, 'node_modules/@neop', name === 'neop-template' ? 'template' : name), path.join(runtime, 'packages', name));
  await mkdir(path.join(out, 'entries'));
  for (const app of FLEET_APPS) await writeFile(path.join(out, 'entries', `${app}.mjs`), `import './apps/${app}/scripts/agent.ts';\n`);
  await copyFile(path.join(root, 'deploy/fleet/agent.Dockerfile'), path.join(out, 'Dockerfile'));
  await writeFile(path.join(out, '.dockerignore'), '*\n!Dockerfile\n!runtime/\n!runtime/**\n!entries/\n!entries/**\n');
  const artifact: AgentArtifact = {
    format: 1, apps: FLEET_APPS,
    lockfileSha256: hash(await readFile(path.join(root, 'pnpm-lock.yaml'))),
    generatorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    dependencies: graph.nodes,
    inventory: await inventory(out),
    limitations: [
      'Local assistant packaging only; not a release attestation or backend image.',
      'Installed declared dependencies and available peers are preserved; absent peers are inventoried, never silently installed.',
      'The tested model path is the current proxy protocol; untested provider/optional-peer paths are not certified.',
      'No production network, credential, provider, Matrix or UI acceptance is implied.',
    ],
  };
  await writeFile(path.join(out, 'artifact.json'), json(artifact));
  return artifact;
}

export async function verifyAgentContext(output: string): Promise<AgentArtifact> {
  const artifact = JSON.parse(await readFile(path.join(output, 'artifact.json'), 'utf8')) as AgentArtifact;
  const observed = (await inventory(output)).filter(row => row.path !== 'artifact.json');
  if (artifact.format !== 1 || json(observed) !== json(artifact.inventory)) throw new Error('artifact inventory does not match files');
  if (artifact.dependencies.some(dep => forbiddenDependency(dep.name))) throw new Error('database/backend dependency in assistant artifact');
  return artifact;
}
