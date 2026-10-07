import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { FLEET_APPS } from '../runtime/apps.ts';
import { copyTree, dependencyGraph, inventory, link, REPO, type Dependency, type InventoryEntry } from './agent-context.ts';

export const BACKEND_DEPENDENCIES = ['@hono/node-server', 'ajv', 'ajv-formats', 'hono', 'jose', 'pg'];
export const BACKEND_RUNTIME = ['backend', 'apps', 'config', 'process'];
export const BACKEND_PACKAGES = ['contracts', 'pgkit', 'domain-values', 'neop-template'];
export const backendForbidden = (name: string) => /^(?:@mariozechner\/|@anthropic-ai\/|@google\/genai$|@neop\/platform$|openai$|deno$|@deno\/)/.test(name);
const digest = (value: Buffer | string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(value).digest(encoding);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const write = async (file: string, data: string | Buffer) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data, { flag: 'wx' }); };
const exists = async (file: string) => { try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
async function sourceFile(root: string, relative: string): Promise<Buffer> {
  const file = path.join(root, relative), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !within(root, await realpath(file))) throw new Error(`unreviewed source file: ${relative}`);
  return readFile(file);
}
export type Architecture = 'arm64' | 'x64';
export interface DenoEvidence { name: string; version: string; architecture: Architecture; integrity: string; archiveSha256: string; binarySha256: string }
export interface BackendArtifact {
  format: 1; kind: 'backend'; apps: readonly string[]; architecture: Architecture;
  lockfileSha256: string; generators: Record<string, string>; deno: DenoEvidence;
  dependencies: Dependency[]; inventory: InventoryEntry[]; limitations: string[];
}

/** Only the lock-pinned platform archive is accepted. tar writes to stdout, never extracts paths. */
export async function readDenoArchive(archive: string, architecture: Architecture, root = REPO): Promise<{ evidence: DenoEvidence; binary: Buffer }> {
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('unsupported Linux architecture');
  const lock = parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const version = lock.importers?.['packages/neop-template']?.dependencies?.deno?.version;
  const name = `@deno/linux-${architecture}-glibc`;
  const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || lock.snapshots?.[`deno@${version}`]?.optionalDependencies?.[name] !== version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity ?? '')) throw new Error('Linux Deno archive is not pinned by the template lockfile');
  const bytes = await readFile(archive);
  if (`sha512-${digest(bytes, 'sha512', 'base64')}` !== integrity) throw new Error('Deno archive integrity mismatch');
  // Use verified bytes on stdin: no path race between integrity check and extraction.
  const extract = (entry: string) => execFileSync('tar', ['-xOzf', '-', entry], { input: bytes, maxBuffer: 200_000_000, timeout: 30_000 });
  const manifest = JSON.parse(extract('package/package.json').toString());
  if (manifest.name !== name || manifest.version !== version || !manifest.os?.includes('linux') || !manifest.cpu?.includes(architecture)) throw new Error('Deno archive platform/identity mismatch');
  const binary = extract('package/deno');
  if (binary.length < 64 || binary.subarray(0, 4).toString('hex') !== '7f454c46' || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== (architecture === 'arm64' ? 183 : 62)) throw new Error('Deno binary is not the requested Linux ELF architecture');
  return { binary, evidence: { name, version, architecture, integrity, archiveSha256: digest(bytes), binarySha256: digest(binary) } };
}

/** Source directories contain only reviewed code/data; hidden files and links fail closed. */
async function sourceTree(source: string, destination: string, root: string, skip: (relative: string) => boolean = () => false, relative = ''): Promise<void> {
  if (!within(root, await realpath(source)) || (await lstat(source)).isSymbolicLink()) throw new Error('source outside workspace or symlink');
  for (const name of (await readdir(source)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    if (skip(rel)) continue;
    const from = path.join(source, name), to = path.join(destination, name), info = await lstat(from);
    if (name.startsWith('.') || info.isSymbolicLink()) throw new Error(`unreviewed source file: ${rel}`);
    if (info.isDirectory()) await sourceTree(from, to, root, skip, rel);
    else if (info.isFile() && /\.(?:ts|json|sql|md)$/.test(name) && !/\.(?:test|spec)\.ts$/.test(name)) await write(to, await readFile(from));
    else throw new Error(`unreviewed source file: ${rel}`);
  }
}

export async function createBackendContext(output: string, archive: string, architecture: Architecture, root = REPO): Promise<BackendArtifact> {
  root = await realpath(root);
  const out = path.resolve(output);
  if (within(out, root) || await exists(out)) throw new Error('output must be a new directory, not an existing path or workspace ancestor');
  const graph = await dependencyGraph(root, BACKEND_DEPENDENCIES, backendForbidden);
  const deno = await readDenoArchive(archive, architecture, root);
  await mkdir(out, { recursive: true });
  const runtime = path.join(out, 'runtime');
  for (const name of BACKEND_RUNTIME) await write(path.join(runtime, `scripts/fleet/runtime/${name}.ts`), await sourceFile(root, `scripts/fleet/runtime/${name}.ts`));
  for (const name of BACKEND_PACKAGES) {
    const pkg = path.join(root, 'packages', name), dest = path.join(runtime, 'packages', name);
    await sourceTree(path.join(pkg, 'src'), path.join(dest, 'src'), root, rel => name === 'neop-template' && rel.startsWith('agent/') && !['agent/bundle.ts', 'agent/context.ts', 'agent/load.ts'].includes(rel));
    const metadata = JSON.parse((await sourceFile(root, `packages/${name}/package.json`)).toString());
    await write(path.join(dest, 'package.json'), json({ name: metadata.name, version: metadata.version, private: true, type: 'module', exports: { '.': './src/index.ts' } }));
    await link(path.join(runtime, 'node_modules', metadata.name), dest);
  }
  await sourceTree(path.join(root, 'packages/neop-template/migrations'), path.join(runtime, 'packages/neop-template/migrations'), root);
  await write(path.join(runtime, 'package.json'), json({ private: true, type: 'module' }));
  for (const node of graph.nodes) {
    const dest = path.join(runtime, 'node_modules/.vendor', node.id);
    await copyTree(path.join(root, node.source), dest);
    for (const [name, id] of Object.entries(node.dependencies)) await link(path.join(dest, 'node_modules', name), path.join(runtime, 'node_modules/.vendor', id));
  }
  for (const [name, id] of Object.entries(graph.seeds)) await link(path.join(runtime, 'node_modules', name), path.join(runtime, 'node_modules/.vendor', id));
  for (const app of FLEET_APPS) {
    const overlay = path.join(out, 'entries', app), appRoot = path.join(root, 'apps', app), dest = path.join(overlay, 'apps', app);
    for (const dir of ['src', 'migrations', 'blocks']) await sourceTree(path.join(appRoot, dir), path.join(dest, dir), root);
    for (const file of ['manifest.json', 'scripts/backend.ts']) await write(path.join(dest, file), await sourceFile(root, `apps/${app}/${file}`));
    const metadata = JSON.parse((await sourceFile(root, `apps/${app}/package.json`)).toString());
    if (metadata.name !== `@neop/${app}`) throw new Error('app package identity mismatch');
    await write(path.join(dest, 'package.json'), json({ name: metadata.name, version: metadata.version, private: true, type: 'module', exports: { '.': './src/index.ts' } }));
    // Fixed-app loader removes the other seventeen domains from the shipped image.
    await write(path.join(overlay, 'scripts/fleet/runtime/load.ts'), `import { ${app}App } from '../../../apps/${app}/src/index.ts';\nimport { RuntimeConfigError } from './config.ts';\nexport async function loadFleetApp(app: string) {\n  if (app !== '${app}') throw new RuntimeConfigError(['NEOP_APP']);\n  const def = await ${app}App();\n  if (def.manifest.app !== app) throw new RuntimeConfigError(['NEOP_APP']);\n  return def;\n}\n`);
    await write(path.join(overlay, 'entry.mjs'), `import './apps/${app}/scripts/backend.ts';\n`);
  }
  await write(path.join(out, 'deno/deno'), deno.binary); await chmod(path.join(out, 'deno/deno'), 0o555);
  await write(path.join(out, 'deno/provenance.json'), json(deno.evidence));
  await write(path.join(out, 'Dockerfile'), await sourceFile(root, 'deploy/fleet/backend.Dockerfile'));
  await write(path.join(out, '.dockerignore'), '*\n!Dockerfile\n!runtime/\n!runtime/**\n!entries/\n!entries/**\n!deno/\n!deno/**\n');
  const generators: Record<string, string> = {};
  for (const name of ['backend-context.ts', 'agent-context.ts']) generators[name] = digest(await readFile(new URL(name, import.meta.url)));
  const artifact: BackendArtifact = {
    format: 1, kind: 'backend', apps: FLEET_APPS, architecture, deno: deno.evidence,
    lockfileSha256: digest(await readFile(path.join(root, 'pnpm-lock.yaml'))), generators,
    dependencies: graph.nodes, inventory: await inventory(out),
    limitations: ['Local backend packaging, not a release attestation.', 'Only the selected Linux architecture is included; no host Deno binary is copied.', 'No provider, production network, Matrix, model or UI acceptance is implied.'],
  };
  await write(path.join(out, 'artifact.json'), json(artifact));
  return artifact;
}

export async function verifyBackendContext(output: string): Promise<BackendArtifact> {
  const artifact = JSON.parse(await readFile(path.join(output, 'artifact.json'), 'utf8')) as BackendArtifact;
  if (artifact.format !== 1 || artifact.kind !== 'backend' || json(artifact.apps) !== json(FLEET_APPS) || !['arm64', 'x64'].includes(artifact.architecture)) throw new Error('not a supported backend artifact');
  const observed = (await inventory(output)).filter(row => row.path !== 'artifact.json');
  if (json(observed) !== json(artifact.inventory)) throw new Error('artifact inventory does not match files');
  if (artifact.dependencies.some(dep => backendForbidden(dep.name))) throw new Error('model/platform dependency in backend artifact');
  if (digest(await readFile(path.join(output, 'deno/deno'))) !== artifact.deno.binarySha256 || artifact.deno.architecture !== artifact.architecture) throw new Error('Deno provenance mismatch');
  if (((await lstat(path.join(output, 'deno/deno'))).mode & 0o777) !== 0o555) throw new Error('Deno executable mode mismatch');
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output, archive, arch] = process.argv.slice(2);
  const result = mode === 'verify' && output && !archive ? await verifyBackendContext(output) : mode === 'build' && output && archive && (arch === 'arm64' || arch === 'x64') && process.argv.length === 6 ? await createBackendContext(output, archive, arch) : null;
  if (!result) throw new Error('usage: backend-context.ts build NEW_CONTEXT DENO_TGZ arm64|x64 | verify CONTEXT');
  console.log(json({ apps: result.apps.length, architecture: result.architecture, dependencies: result.dependencies.length, files: result.inventory.length, deno: result.deno }));
}
