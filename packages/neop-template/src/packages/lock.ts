// packages.lock.json (v3 §10, §13 src/packages): what `neos install` pinned into this app at build time.
// Each package: its version, the artifact hash the registry co-signed, the registry's signature and the key it
// verifies under, every unpacked file's sha256, and the host migration files its migrations became. Each
// skill-only entry: its version and content hash (the text stays in neos_registry.skills, read at spawn).
// The backend re-verifies all of it before a package runs: a hand-edited file is a package that does not load.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { packageOffers, packageRequires, registryContentHash, sha256Tagged } from '@neop/contracts';
import { importJWK, jwtVerify } from 'jose';
import type { PackageBundle } from './types.ts';

export const LOCK_FILE = 'packages.lock.json';
export const PACKAGES_DIR = path.join('src', 'packages');

/** The registry's co-signature over (key, version, content_hash), and the public key it verified under at install. */
export interface LockSignature {
  platform_sig: string;
  kid: string | null;
  public_key: Record<string, unknown>;
}

export interface LockedMigration {
  /** The file inside the package (migrations/001_x.sql). */
  package_file: string;
  /** The host's migration file it became (apps/<app>/migrations/008_nep_x__001_x.sql). */
  host_file: string;
  /** sha256 of the package file's text: a later version may not change a migration that already shipped. */
  sha256: string;
}

export interface LockedPackage {
  key: string;
  version: string;
  artifact_hash: string;
  content_hash: string;
  signature: LockSignature;
  /** The folder the package was unpacked into, relative to the app root. */
  dir: string;
  /** Every unpacked file (relative to dir) → its sha256. bundle.json is the artifact itself. */
  files: Record<string, string>;
  /** The package's own database role (DML on its tables only). */
  role: string;
  tables: string[];
  migrations: LockedMigration[];
}

export interface LockedSkill {
  key: string;
  version: string;
  owner_app: string | null;
  content_hash: string;
  requires: string[];
  signature: LockSignature;
}

export interface PackagesLock {
  $comment?: string;
  lock_version: 1;
  packages: LockedPackage[];
  skills: LockedSkill[];
}

export const EMPTY_LOCK: PackagesLock = {
  $comment: 'Written by `neos install` (scripts/neos-install.ts). Never edit by hand: the backend re-verifies every hash here at spawn.',
  lock_version: 1,
  packages: [],
  skills: [],
};

export function readLockSync(file: string): PackagesLock {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return structuredClone(EMPTY_LOCK);
  }
  return normalizeLock(JSON.parse(raw));
}

export async function readLock(file: string): Promise<PackagesLock> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  return raw === null ? structuredClone(EMPTY_LOCK) : normalizeLock(JSON.parse(raw));
}

function normalizeLock(v: any): PackagesLock {
  if (!v || typeof v !== 'object' || v.lock_version !== 1) throw new Error(`${LOCK_FILE}: unknown lock_version ${String(v?.lock_version)}`);
  return { $comment: v.$comment ?? EMPTY_LOCK.$comment, lock_version: 1, packages: Array.isArray(v.packages) ? v.packages : [], skills: Array.isArray(v.skills) ? v.skills : [] };
}

export function renderLock(lock: PackagesLock): string {
  const sorted: PackagesLock = {
    $comment: lock.$comment ?? EMPTY_LOCK.$comment,
    lock_version: 1,
    packages: [...lock.packages].sort((a, b) => a.key.localeCompare(b.key)),
    skills: [...lock.skills].sort((a, b) => a.key.localeCompare(b.key)),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** The table prefix and database role a package gets in a host. */
export function packageSlug(key: string): string {
  return key.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_');
}

/** Verify a registry co-signature offline, against the key the lock recorded (and, when given, a trusted key set). */
export async function verifyLockSignature(
  sig: LockSignature,
  expect: { key: string; version: string; content_hash: string },
  trusted?: { keys: Record<string, unknown>[] } | null,
): Promise<string | null> {
  if (!sig || typeof sig.platform_sig !== 'string' || !sig.public_key) return 'no registry signature recorded';
  if (trusted) {
    const same = trusted.keys.some((k) => k.x === sig.public_key.x && (k.kid ?? null) === (sig.kid ?? k.kid ?? null));
    if (!same) return `the registry key ${sig.kid ?? '(no kid)'} is not one this backend trusts`;
  }
  try {
    const key = await importJWK(sig.public_key as any, 'EdDSA');
    const { payload } = await jwtVerify(sig.platform_sig, key, { issuer: 'neos-registry', algorithms: ['EdDSA'] });
    if (payload.key !== expect.key || payload.version !== expect.version || payload.content_hash !== expect.content_hash) return 'the registry signature is for something else';
    return null;
  } catch (e) {
    return `the registry signature does not verify: ${(e as Error).message}`;
  }
}

/** The content hash the registry co-signs for a package, recomputed from its bundle and artifact hash. */
export function packageContentHash(bundle: PackageBundle, artifactHash: string): string {
  const m = bundle.manifest;
  return registryContentHash({ key: m.key, version: m.version, kind: 'package', body: null, requires: packageRequires(m), offers: packageOffers(m), artifact_hash: artifactHash });
}

export interface VerifiedPackage {
  entry: LockedPackage;
  bundle: PackageBundle;
}

/**
 * Everything a package must be before it runs (v3 §10 "verified at spawn"): every file the lock lists is on disk
 * with its hash, bundle.json is the co-signed artifact, the content hash recomputed from it is the one the lock and
 * the signature name, and the signature verifies. Returns the reason it is not, or the bundle.
 */
export async function verifyInstalledPackage(root: string, entry: LockedPackage, trusted?: { keys: Record<string, unknown>[] } | null): Promise<{ ok: true; bundle: PackageBundle } | { ok: false; reason: string }> {
  const dir = path.join(root, entry.dir);
  if (!entry.files || !entry.files['bundle.json']) return { ok: false, reason: 'the lock lists no bundle.json' };
  let bundleBytes: Buffer | null = null;
  for (const [rel, want] of Object.entries(entry.files)) {
    const bytes = await readFile(path.join(dir, rel)).catch(() => null);
    if (!bytes) return { ok: false, reason: `${entry.dir}/${rel} is missing` };
    if (sha256Tagged(bytes) !== want) return { ok: false, reason: `${entry.dir}/${rel} was changed after install: its files no longer match the signed artifact` };
    if (rel === 'bundle.json') bundleBytes = bytes;
  }
  if (sha256Tagged(bundleBytes!) !== entry.artifact_hash) return { ok: false, reason: `${entry.dir}/bundle.json is not the artifact the registry signed` };
  let bundle: PackageBundle;
  try {
    bundle = JSON.parse(bundleBytes!.toString('utf8')) as PackageBundle;
  } catch {
    return { ok: false, reason: `${entry.dir}/bundle.json is not JSON` };
  }
  if (bundle.manifest?.key !== entry.key || bundle.manifest?.version !== entry.version) return { ok: false, reason: 'bundle.json is for another package or version' };
  if (packageContentHash(bundle, entry.artifact_hash) !== entry.content_hash) return { ok: false, reason: 'the content hash does not match the artifact' };
  const bad = await verifyLockSignature(entry.signature, { key: entry.key, version: entry.version, content_hash: entry.content_hash }, trusted);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, bundle };
}

/** The content hash of a skill-only registry row (what the lock pins and the registry co-signed). */
export function skillContentHash(row: { key: string; version: string; body: string | null; requires: string[]; offers?: unknown }): string {
  return registryContentHash({ key: row.key, version: row.version, kind: 'skill', body: row.body, requires: row.requires ?? [], offers: row.offers ?? [], artifact_hash: null });
}

