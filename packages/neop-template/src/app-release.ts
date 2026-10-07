import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompactSign, compactVerify, importJWK, type JWK } from 'jose';
import { assertGeneratedManifestsFresh, declarationProblems, FLEET_TEMPLATE_COMMIT, readAppDeclaration, stableJson } from './declaration.ts';

export const APP_RELEASE_SCHEMA_VERSION = 1 as const;
const INCLUDED_ROOTS = ['app.declaration.json', 'manifest.json', 'manifest.template.json', 'package.json', 'packages.lock.json', 'src', 'migrations', 'blocks', 'scripts', 'deploy'] as const;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_BYTES = 64 * 1024 * 1024;

export class AppReleaseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppReleaseError';
    this.code = code;
  }
}

export interface AppReleaseFile {
  sha256: string;
  bytes: number;
  base64: string;
}

export interface AppRelease {
  schema_version: typeof APP_RELEASE_SCHEMA_VERSION;
  app: string;
  version: string;
  template_commit: typeof FLEET_TEMPLATE_COMMIT;
  content_hash: string;
  files: Record<string, AppReleaseFile>;
}

export interface SignedAppRelease {
  release: AppRelease;
  signature: string;
}

export interface AppReleaseRegistry {
  publish(bundle: SignedAppRelease, trusted: { keys: JWK[] }): Promise<'published' | 'already-published'>;
  get(app: string, version: string): Promise<SignedAppRelease>;
}

function safeRelative(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!value || value.includes('\\') || normalized !== value || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new AppReleaseError(`unsafe app release path: ${value}`, 'unsafe_path');
  }
  return value;
}

function sha(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function releasePayload(value: Pick<AppRelease, 'schema_version' | 'app' | 'version' | 'template_commit' | 'files'>) {
  return {
    schema_version: value.schema_version,
    app: value.app,
    version: value.version,
    template_commit: value.template_commit,
    files: Object.fromEntries(Object.entries(value.files).sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [name, { sha256: file.sha256, bytes: file.bytes }])),
  };
}

export function appReleaseContentHash(release: Pick<AppRelease, 'schema_version' | 'app' | 'version' | 'template_commit' | 'files'>): string {
  return sha(JSON.stringify(releasePayload(release)));
}

async function collect(root: string, relative: string, out: Map<string, Buffer>): Promise<void> {
  const safe = safeRelative(relative.split(path.sep).join('/'));
  const absolute = path.join(root, safe);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new AppReleaseError(`release input cannot be a symlink: ${safe}`, 'unsafe_path');
  if (stat.isDirectory()) {
    const entries = await readdir(absolute);
    for (const name of entries.sort()) await collect(root, `${safe}/${name}`, out);
    return;
  }
  if (!stat.isFile()) throw new AppReleaseError(`release input is not a regular file: ${safe}`, 'unsafe_path');
  if (stat.size > MAX_FILE_BYTES) throw new AppReleaseError(`release file is too large: ${safe}`, 'release_too_large');
  out.set(safe, await readFile(absolute));
}

export async function createAppRelease(appRoot: string): Promise<AppRelease> {
  const root = path.resolve(appRoot);
  assertGeneratedManifestsFresh(root);
  const declaration = readAppDeclaration(root);
  const found = new Map<string, Buffer>();
  for (const relative of INCLUDED_ROOTS) await collect(root, relative, found);
  const compose = path.resolve(root, '../../deploy/fleet/generated', `${declaration.manifest.app}.compose.yaml`);
  const composeBytes = await readFile(compose).catch(() => null);
  if (!composeBytes) throw new AppReleaseError(`generated Compose contract is missing for ${declaration.manifest.app}`, 'bad_release');
  found.set('deploy/compose.yaml', composeBytes);
  let total = 0;
  const files: Record<string, AppReleaseFile> = {};
  for (const [name, bytes] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    total += bytes.length;
    if (total > MAX_RELEASE_BYTES) throw new AppReleaseError('app release is too large', 'release_too_large');
    files[name] = { sha256: sha(bytes), bytes: bytes.length, base64: bytes.toString('base64') };
  }
  const base = { schema_version: APP_RELEASE_SCHEMA_VERSION, app: declaration.manifest.app, version: declaration.manifest.version, template_commit: FLEET_TEMPLATE_COMMIT, files } as const;
  return { ...base, content_hash: appReleaseContentHash(base) };
}

export function appReleaseProblems(release: AppRelease): string[] {
  const problems: string[] = [];
  if (release.schema_version !== APP_RELEASE_SCHEMA_VERSION) problems.push(`schema_version must be ${APP_RELEASE_SCHEMA_VERSION}`);
  if (!/^[a-z][a-z0-9-]*$/.test(release.app)) problems.push('app is invalid');
  if (!/^\d+\.\d+\.\d+$/.test(release.version)) problems.push('version is invalid');
  if (release.template_commit !== FLEET_TEMPLATE_COMMIT) problems.push('template commit is not pinned v0.8.16');
  if (!release.files['app.declaration.json'] || !release.files['manifest.json'] || !release.files['manifest.template.json']) problems.push('generated manifest set is incomplete');
  for (const [name, file] of Object.entries(release.files)) {
    try { safeRelative(name); } catch { problems.push(`unsafe file ${name}`); continue; }
    let bytes: Buffer;
    try { bytes = Buffer.from(file.base64, 'base64'); } catch { problems.push(`${name} is not base64`); continue; }
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) problems.push(`${name} does not match its hash`);
  }
  try {
    const declaration = JSON.parse(Buffer.from(release.files['app.declaration.json']!.base64, 'base64').toString('utf8')) as unknown;
    const declaredProblems = declarationProblems(declaration, release.app);
    if (declaredProblems.length) problems.push(...declaredProblems.map((problem) => `declaration: ${problem}`));
    const value = declaration as { manifest: { app: string; version: string } };
    if (value.manifest.version !== release.version) problems.push('release version differs from the declaration');
    const fleet = JSON.parse(Buffer.from(release.files['manifest.json']!.base64, 'base64').toString('utf8')) as unknown;
    if (JSON.stringify(fleet) !== JSON.stringify(value.manifest)) problems.push('fleet manifest differs from the declaration');
    const template = JSON.parse(Buffer.from(release.files['manifest.template.json']!.base64, 'base64').toString('utf8')) as { id?: string; version?: string };
    if (template.id !== release.app || template.version !== release.version) problems.push('template manifest identity differs from the release');
  } catch {
    problems.push('generated manifest set is not valid JSON');
  }
  if (appReleaseContentHash(release) !== release.content_hash) problems.push('release does not match its content hash');
  return problems;
}

export async function signAppRelease(release: AppRelease, privateJwk: JWK, kid: string): Promise<SignedAppRelease> {
  const problems = appReleaseProblems(release);
  if (problems.length) throw new AppReleaseError(problems.join('; '), 'bad_release');
  const key = await importJWK(privateJwk, privateJwk.alg ?? 'EdDSA');
  const signature = await new CompactSign(Buffer.from(release.content_hash)).setProtectedHeader({ alg: privateJwk.alg ?? 'EdDSA', kid, typ: 'neos-app-release+jws' }).sign(key);
  return { release, signature };
}

export async function verifyAppRelease(bundle: SignedAppRelease, trusted: { keys: JWK[] }): Promise<void> {
  const problems = appReleaseProblems(bundle.release);
  if (problems.length) throw new AppReleaseError(problems.join('; '), 'bad_release');
  const protectedPart = bundle.signature.split('.')[0];
  let header: { kid?: string; alg?: string; typ?: string };
  try { header = JSON.parse(Buffer.from(protectedPart!, 'base64url').toString('utf8')) as typeof header; }
  catch { throw new AppReleaseError('release signature header is invalid', 'bad_signature'); }
  const jwk = trusted.keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk || header.typ !== 'neos-app-release+jws') throw new AppReleaseError('release signer is not trusted', 'bad_signature');
  try {
    const key = await importJWK(jwk, header.alg ?? jwk.alg ?? 'EdDSA');
    const verified = await compactVerify(bundle.signature, key);
    if (Buffer.from(verified.payload).toString('utf8') !== bundle.release.content_hash) throw new Error('payload mismatch');
  } catch {
    throw new AppReleaseError('release signature is invalid', 'bad_signature');
  }
}

export class FileAppReleaseRegistry implements AppReleaseRegistry {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  private file(app: string, version: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(app) || !/^\d+\.\d+\.\d+$/.test(version)) throw new AppReleaseError('invalid app release identity', 'bad_release');
    return path.join(this.root, app, `${version}.json`);
  }

  async publish(bundle: SignedAppRelease, trusted: { keys: JWK[] }): Promise<'published' | 'already-published'> {
    await verifyAppRelease(bundle, trusted);
    const target = this.file(bundle.release.app, bundle.release.version);
    const prior = await readFile(target, 'utf8').catch(() => null);
    if (prior !== null) {
      const existing = JSON.parse(prior) as SignedAppRelease;
      if (existing.release.content_hash === bundle.release.content_hash) return 'already-published';
      throw new AppReleaseError(`${bundle.release.app}@${bundle.release.version} is immutable and already has different content`, 'version_conflict');
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, stableJson(bundle), { mode: 0o600 });
    await rename(temp, target);
    return 'published';
  }

  async get(app: string, version: string): Promise<SignedAppRelease> {
    const text = await readFile(this.file(app, version), 'utf8').catch(() => null);
    if (text === null) throw new AppReleaseError(`${app}@${version} is not published`, 'not_found');
    return JSON.parse(text) as SignedAppRelease;
  }
}

interface InstallMarker {
  schema_version: 1;
  app: string;
  version: string;
  content_hash: string;
  template_commit: string;
  files: Record<string, Pick<AppReleaseFile, 'sha256' | 'bytes'>>;
}

async function installedProblems(root: string, files: Record<string, Pick<AppReleaseFile, 'sha256' | 'bytes'>>): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, file] of Object.entries(files)) {
    const bytes = await readFile(path.join(root, safeRelative(name))).catch(() => null);
    if (!bytes || bytes.length !== file.bytes || sha(bytes) !== file.sha256) problems.push(name);
  }
  return problems;
}

export async function installAppRelease(options: { bundle: SignedAppRelease; target: string; trusted: { keys: JWK[] }; /** Test-only activation fault injection used to prove rollback. */ faultAfterBackup?: boolean }): Promise<'installed' | 'already-installed'> {
  await verifyAppRelease(options.bundle, options.trusted);
  const release = options.bundle.release;
  const target = path.resolve(options.target);
  const markerFile = path.join(target, '.neop-release.json');
  const existing = await readFile(markerFile, 'utf8').then((text) => JSON.parse(text) as InstallMarker, () => null);
  if (existing) {
    if (!existing.files || typeof existing.files !== 'object') throw new AppReleaseError('installed release marker cannot prove file integrity', 'install_drift');
    const drift = await installedProblems(target, existing.files);
    if (drift.length) throw new AppReleaseError(`installed app drifted: ${drift.join(', ')}`, 'install_drift');
    if (release.content_hash === existing.content_hash) {
      return 'already-installed';
    }
    if (existing.app !== release.app || existing.template_commit !== release.template_commit) throw new AppReleaseError('installed target belongs to another app or template', 'install_drift');
  } else if (await lstat(target).then(() => true, () => false)) {
    throw new AppReleaseError('install target exists without a release marker', 'install_drift');
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.${path.basename(target)}.stage-${process.pid}-${Date.now()}`);
  const backup = path.join(parent, `.${path.basename(target)}.backup-${process.pid}-${Date.now()}`);
  await mkdir(stage, { recursive: false });
  try {
    for (const [name, file] of Object.entries(release.files)) {
      const destination = path.join(stage, safeRelative(name));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.base64, 'base64'), { mode: 0o444 });
    }
    const stagedDrift = await installedProblems(stage, release.files);
    if (stagedDrift.length) throw new AppReleaseError(`staged app failed verification: ${stagedDrift.join(', ')}`, 'bad_release');
    try { assertGeneratedManifestsFresh(stage, release.app); }
    catch (error) { throw new AppReleaseError(`staged generated contract is invalid: ${(error as Error).message}`, 'bad_release'); }
    await writeFile(path.join(stage, '.neop-release.json'), stableJson({ schema_version: 1, app: release.app, version: release.version, content_hash: release.content_hash, template_commit: release.template_commit, files: Object.fromEntries(Object.entries(release.files).map(([name, file]) => [name, { sha256: file.sha256, bytes: file.bytes }])) } satisfies InstallMarker), { mode: 0o444 });
    const hadTarget = await lstat(target).then(() => true, () => false);
    if (hadTarget) await rename(target, backup);
    try {
      if (options.faultAfterBackup) throw new AppReleaseError('injected activation failure', 'activation_failed');
      await rename(stage, target);
      if (hadTarget) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      if (hadTarget) await rename(backup, target);
      throw error;
    }
    return 'installed';
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}
