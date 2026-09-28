// `neos install` (v3 §10 INSTALL, build time): fetch a registry entry by key@version, verify the registry's
// co-signature and — for a package — the artifact's hash, unpack it read-only into src/packages/nep-<name>/,
// pin it in packages.lock.json, append its migrations to the host's numbered set (with a migrate.json entry each,
// so they go to the DBA with the host's own file), put its lines in the host manifest's `packages` (the platform
// shows them on the switchboard; the runner stamps their floors at boot) and run the package's self-test inside
// the host — its migrations and the host's, in a scratch database — before the install stands. A skill-only entry
// is pinned (lock + manifest `registry_skills`) and nothing else: its text stays in neos_registry.skills.
//
// Nothing here runs at request time and nothing here is ever evaluated from a database row.

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageRequires, registryContentHash, sha256Tagged, type Manifest, type ManifestAbility } from '@neop/contracts';
import { createTestDatabase } from '@neop/pgkit';
import { LOCK_FILE, PACKAGES_DIR, packageContentHash, packageSlug, readLock, renderLock, verifyLockSignature, type LockedPackage, type LockedSkill, type LockSignature, type PackagesLock } from './lock.ts';
import { packageRole } from './migrate.ts';
import { hasSelftest, selftestPackage } from './selftest.ts';
import type { PackageBundle } from './types.ts';

/** A registry row as the registry serves it for install (signed; the artifact is fetched by its hash). */
export interface RegistryEntry {
  key: string;
  version: string;
  kind: 'skill' | 'package';
  owner_app: string | null;
  requires: string[];
  offers: unknown;
  body: string | null;
  artifact_hash: string | null;
  content_hash: string;
  platform_sig: string;
  status: string;
}

export interface RegistrySource {
  entry(key: string, version: string): Promise<RegistryEntry>;
  artifact(hash: string): Promise<Buffer>;
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}

/** The registry over the platform's HTTP surface: an operator's bearer token, or an app's service secret. */
export function httpRegistrySource(o: { platformUrl: string; bearer?: string; service?: { app: string; secret: string } }): RegistrySource {
  const base = o.platformUrl.replace(/\/$/, '');
  const auth = o.bearer ? `Bearer ${o.bearer}` : o.service ? `Service ${o.service.app}:${o.service.secret}` : '';
  const get = async (p: string) => {
    const res = await fetch(base + p, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new InstallError(`registry ${p}: ${res.status} ${JSON.stringify(body)}`, 'registry_unavailable');
    return body as any;
  };
  return {
    entry: async (key, version) => (await get(`/api/registry/entry?key=${encodeURIComponent(key)}&version=${encodeURIComponent(version)}`)).entry,
    artifact: async (hash) => Buffer.from((await get(`/api/registry/artifact?hash=${encodeURIComponent(hash)}`)).base64, 'base64'),
    jwks: async () => get('/.well-known/registry-jwks.json'),
  };
}

export class InstallError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

export interface InstallOptions {
  /** The app's folder (apps/<app>): manifest.json, migrations/, src/packages/, packages.lock.json. */
  root: string;
  /** `<key>@<version>` — a package (nep-<name>) or a skill (<owner>/<name>). */
  spec: string;
  source: RegistrySource;
  /** When set, the registry key must be one of these (production pins the registry's JWKS). */
  trusted?: { keys: Record<string, unknown>[] } | null;
  /**
   * Run the package's tests inside the host: migrate the host (template + app + the new files) into a scratch
   * database and run the package's self-test there. Default on; `adminUrl` is the cluster to make the scratch
   * database on (default NEOS_ADMIN_URL). A failure leaves the app exactly as it was.
   */
  tests?: false | { adminUrl?: string };
  /** migrate.json `proven_on_populated_data` for the appended files (where they were proven). Unset: unproven. */
  proven?: string;
  log?: (m: string) => void;
}

export interface InstallResult {
  key: string;
  version: string;
  kind: 'skill' | 'package';
  artifact_hash: string | null;
  migrations: string[];
  selftest: 'passed' | 'none' | 'skipped';
}

export function parseSpec(spec: string): { key: string; version: string } {
  const m = /^((?:nep-[a-z][a-z0-9-]*)|(?:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*))@(\d+\.\d+\.\d+)$/.exec(spec);
  if (!m) throw new InstallError(`${spec}: expected <package-key>@<x.y.z> (nep-<name>@1.0.0) or <owner>/<skill>@<x.y.z>`, 'bad_spec');
  return { key: m[1]!, version: m[2]! };
}

// ── JSON files edited in place: only the property touched changes, the rest of the file keeps its layout ──

function findArray(text: string, prop: string): { start: number; end: number; indent: string } | null {
  const at = text.search(new RegExp(`\\n([ \\t]*)"${prop}"\\s*:\\s*\\[`));
  if (at < 0) return null;
  const indent = /\n([ \t]*)/.exec(text.slice(at))![1]!;
  let i = text.indexOf('[', at);
  const start = i;
  let depth = 0;
  let inStr = false;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1, indent };
    }
  }
  throw new Error(`unbalanced ${prop} array`);
}

function renderArray(items: unknown[], indent: string): string {
  if (!items.length) return '[]';
  const inner = items.map((x) => JSON.stringify(x, null, 2).split('\n').map((l) => `${indent}  ${l}`).join('\n'));
  return `[\n${inner.join(',\n')}\n${indent}]`;
}

/** Replace (or add, after `after`) one top-level array property of a JSON object file, keeping the rest verbatim. */
export function setJsonArray(text: string, prop: string, items: unknown[], after?: string): string {
  const found = findArray(text, prop);
  if (found) return text.slice(0, found.start) + renderArray(items, found.indent) + text.slice(found.end);
  const anchor = after ? findArray(text, after) : null;
  if (!anchor) {
    const close = text.lastIndexOf('}');
    const indent = '  ';
    return `${text.slice(0, close).replace(/\s*$/, '')},\n${indent}"${prop}": ${renderArray(items, indent)}\n${text.slice(close)}`;
  }
  return `${text.slice(0, anchor.end)},\n${anchor.indent}"${prop}": ${renderArray(items, anchor.indent)}${text.slice(anchor.end)}`;
}

/** Append entries to a top-level array property, leaving the existing entries' text as it is. */
export function appendJsonArray(text: string, prop: string, items: unknown[]): string {
  if (!items.length) return text;
  const found = findArray(text, prop);
  if (!found) return setJsonArray(text, prop, items);
  const body = text.slice(found.start + 1, found.end - 1);
  const add = items.map((x) => JSON.stringify(x, null, 2).split('\n').map((l) => `${found.indent}  ${l}`).join('\n')).join(',\n');
  const inner = body.trim() ? `${body.replace(/\s*$/, '')},\n${add}\n${found.indent}` : `\n${add}\n${found.indent}`;
  return `${text.slice(0, found.start + 1)}${inner}${text.slice(found.end - 1)}`;
}

// ── the files the installer touches, kept so a failed install puts every one back ──

class Staging {
  private saved = new Map<string, string | null>();
  private dirs: string[] = [];
  async keep(file: string): Promise<void> {
    if (!this.saved.has(file)) this.saved.set(file, await readFile(file, 'utf8').catch(() => null));
  }
  async write(file: string, text: string, mode?: number): Promise<void> {
    await this.keep(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, mode ? { mode } : undefined);
  }
  /** A directory that is replaced as a whole: the old one is moved aside and restored on failure. */
  async replaceDir(dir: string): Promise<void> {
    const aside = `${dir}.neos-install-${process.pid}-${Date.now()}`;
    const had = await readdir(dir).then(() => true, () => false);
    if (had) {
      await makeWritable(dir);
      await rename(dir, aside);
    }
    this.dirs.push(had ? `${dir}\n${aside}` : `${dir}\n`);
  }
  async commit(): Promise<void> {
    for (const d of this.dirs) {
      const [, aside] = d.split('\n');
      if (aside) await rm(aside, { recursive: true, force: true });
    }
  }
  async rollback(): Promise<void> {
    for (const [file, text] of this.saved) {
      if (text === null) await rm(file, { force: true });
      else await writeFile(file, text);
    }
    for (const d of this.dirs.reverse()) {
      const [dir, aside] = d.split('\n') as [string, string];
      await makeWritable(dir).catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (aside) await rename(aside, dir);
    }
  }
}

async function makeWritable(dir: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    await chmod(d, 0o755).catch(() => {});
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else await chmod(p, 0o644).catch(() => {});
    }
  };
  await walk(dir);
}

// ── the package's files ──

/** The files a package unpacks into: bundle.json (the artifact, byte for byte) and its parts, for people to read. */
export function unpackFiles(bytes: Buffer, bundle: PackageBundle): Record<string, Buffer> {
  const m = bundle.manifest;
  const out: Record<string, Buffer> = { 'bundle.json': bytes };
  const { migrations, skills, ...nep } = m;
  out['nep.json'] = Buffer.from(`${JSON.stringify({ ...nep, skills: skills.map((s) => ({ key: s.key, requires: s.requires })), migrations: Object.keys(migrations).sort() }, null, 2)}\n`);
  out['handlers.js'] = Buffer.from(bundle.handlers);
  for (const s of skills) out[`skills/${s.key}.md`] = Buffer.from(`---\nrequires: [${s.requires.join(', ')}]\n---\n${s.body}`);
  for (const [f, sql] of Object.entries(migrations)) out[`migrations/${f}`] = Buffer.from(sql);
  if (bundle.metrics) out['metrics.json'] = Buffer.from(`${JSON.stringify(bundle.metrics, null, 2)}\n`);
  for (const [r, text] of Object.entries(bundle.references ?? {})) out[`references/${r}`] = Buffer.from(text);
  for (const k of Object.keys(out)) if (k.includes('..') || path.isAbsolute(k)) throw new InstallError(`unsafe path in package: ${k}`, 'bad_package');
  return out;
}

const CREATE_TABLE = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:\{\{schema\}\}\.|"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** The host migration a package migration becomes: its SQL once (skipped where the pre-v3 runtime installer ran it), then the host role's read-only view. */
export function hostMigrationSql(o: { key: string; version: string; artifact_hash: string; packageFile: string; hostFile: string; sql: string; tables: string[] }): string {
  let tag = 'neos_pkg';
  while (o.sql.includes(`$${tag}$`)) tag += '_';
  const legacy = `${o.key}@%/${o.packageFile}`.replace(/'/g, "''");
  const tables = o.tables.map((t) => `'${t}'`).join(', ');
  return [
    `-- ${o.hostFile} · installed by \`neos install\` from ${o.key}@${o.version} (migrations/${o.packageFile}; artifact ${o.artifact_hash}).`,
    `-- The package's own SQL, applied once with the host's migrations. A book where the pre-v3 runtime installer already`,
    `-- ran it (schema_migrations row '${o.key}@<version>/${o.packageFile}') keeps what it has: the SQL is skipped there.`,
    `-- Its tables are the package's: the package role writes them (granted after migrating), the host role only reads them.`,
    `do $neos_install$`,
    `begin`,
    `  if exists (select 1 from {{schema}}.schema_migrations where name like '${legacy}') then return; end if;`,
    `  execute $${tag}$`,
    o.sql.replace(/\s*$/, ''),
    `$${tag}$;`,
    `end`,
    `$neos_install$;`,
    ...(o.tables.length
      ? [
          `do $neos_grants$`,
          `declare t text;`,
          `begin`,
          `  foreach t in array array[${tables}]::text[] loop`,
          `    if to_regclass('{{schema}}.' || t) is not null then`,
          `      execute format('revoke insert, update, delete on {{schema}}.%I from {{schema}}_app', t);`,
          `      execute format('grant select on {{schema}}.%I to {{schema}}_app', t);`,
          `    end if;`,
          `  end loop;`,
          `end`,
          `$neos_grants$;`,
        ]
      : []),
    '',
  ].join('\n');
}

// ── install ──

async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

function pinFor(entry: RegistryEntry, jwks: { keys: Record<string, unknown>[] }): LockSignature {
  let kid: string | null = null;
  try {
    kid = JSON.parse(Buffer.from(entry.platform_sig.split('.')[0]!, 'base64url').toString('utf8')).kid ?? null;
  } catch {
    kid = null;
  }
  const key = jwks.keys.find((k) => (k.kid ?? null) === kid) ?? (jwks.keys.length === 1 ? jwks.keys[0] : undefined);
  if (!key) throw new InstallError(`the registry has no public key ${kid ?? '(no kid)'} for ${entry.key}@${entry.version}`, 'bad_signature');
  const { d: _private, ...pub } = key as Record<string, unknown>;
  return { platform_sig: entry.platform_sig, kid, public_key: pub };
}

/** Verify what the registry served: its own content hash and the co-signature over it. */
async function verifyEntry(entry: RegistryEntry, key: string, version: string, jwks: { keys: Record<string, unknown>[] }, trusted?: { keys: Record<string, unknown>[] } | null): Promise<LockSignature> {
  if (!entry || entry.key !== key || entry.version !== version) throw new InstallError(`the registry answered with another entry than ${key}@${version}`, 'bad_entry');
  if (!['published', 'deprecated'].includes(entry.status)) throw new InstallError(`${key}@${version} is ${entry.status}; only a published version installs`, 'not_published');
  const ch = registryContentHash({ key: entry.key, version: entry.version, kind: entry.kind, body: entry.body, requires: entry.requires ?? [], offers: entry.offers ?? [], artifact_hash: entry.artifact_hash });
  if (ch !== entry.content_hash) throw new InstallError(`${key}@${version}: the entry does not match its content hash`, 'bad_signature');
  if (!entry.platform_sig) throw new InstallError(`${key}@${version} carries no registry signature`, 'bad_signature');
  const sig = pinFor(entry, jwks);
  const bad = await verifyLockSignature(sig, { key, version, content_hash: entry.content_hash }, trusted);
  if (bad) throw new InstallError(`${key}@${version}: ${bad}`, 'bad_signature');
  return sig;
}

export async function installEntry(o: InstallOptions): Promise<InstallResult> {
  const log = o.log ?? (() => {});
  const { key, version } = parseSpec(o.spec);
  const root = path.resolve(o.root);
  const manifestFile = path.join(root, 'manifest.json');
  const lockFile = path.join(root, LOCK_FILE);
  const manifestText = await readText(manifestFile);
  const manifest = JSON.parse(manifestText) as Manifest;
  const host = manifest.app;
  const lock = await readLock(lockFile);

  const entry = await o.source.entry(key, version);
  const jwks = await o.source.jwks();
  const signature = await verifyEntry(entry, key, version, jwks, o.trusted);
  const stage = new Staging();

  if (entry.kind === 'skill') {
    if (!entry.body) throw new InstallError(`${key}@${version} has no text`, 'bad_entry');
    const pin: LockedSkill = { key, version, owner_app: entry.owner_app, content_hash: entry.content_hash, requires: entry.requires ?? [], signature };
    const next: PackagesLock = { ...lock, skills: [...lock.skills.filter((s) => s.key !== key), pin] };
    const pins = [...(manifest.registry_skills ?? []).filter((s) => s.key !== key), { key, version, owner_app: entry.owner_app, content_hash: entry.content_hash, requires: pin.requires }].sort((a, b) => a.key.localeCompare(b.key));
    await stage.write(lockFile, renderLock(next));
    await stage.write(manifestFile, setJsonArray(manifestText, 'registry_skills', pins, 'packages'));
    await stage.commit();
    log(`${host}: pinned skill ${key}@${version} (${entry.content_hash}); it loads where the company switches it and all it requires on`);
    return { key, version, kind: 'skill', artifact_hash: null, migrations: [], selftest: 'none' };
  }

  // A package: the artifact by hash, and the hash checked against the signed entry.
  if (!entry.artifact_hash) throw new InstallError(`${key}@${version} has no artifact`, 'bad_entry');
  const bytes = await o.source.artifact(entry.artifact_hash);
  if (sha256Tagged(bytes) !== entry.artifact_hash) throw new InstallError(`${key}@${version}: the artifact does not match its hash ${entry.artifact_hash}; nothing was installed`, 'hash_mismatch');
  const bundle = JSON.parse(bytes.toString('utf8')) as PackageBundle;
  const m = bundle.manifest;
  if (m?.key !== key || m.version !== version) throw new InstallError(`the artifact is ${m?.key}@${m?.version}, not ${key}@${version}`, 'bad_package');
  if (packageContentHash(bundle, entry.artifact_hash) !== entry.content_hash) throw new InstallError(`${key}@${version}: the artifact's offers and requirements are not the ones the registry signed`, 'bad_signature');
  const slug = packageSlug(key);
  const prefix = `nep_${slug}_`;
  for (const t of m.tables ?? []) if (!t.startsWith(prefix) || !/^[a-z_][a-z0-9_]*$/.test(t)) throw new InstallError(`${key}: table ${t} is not named ${prefix}*`, 'bad_package');
  for (const [f, sql] of Object.entries(m.migrations ?? {})) {
    for (const mt of sql.matchAll(CREATE_TABLE)) {
      if (!(m.tables ?? []).includes(mt[1]!)) throw new InstallError(`${key}: migrations/${f} creates ${mt[1]}, which is not one of its declared ${prefix}* tables`, 'bad_package');
    }
  }
  const own = new Set(manifest.abilities.map((a) => a.key));
  for (const a of m.abilities) if (own.has(a.key)) throw new InstallError(`${key}: ability ${a.key} is already one of ${host}'s own`, 'bad_package');
  for (const other of manifest.packages ?? []) {
    if (other.key === key) continue;
    const clash = (other.abilities ?? []).find((a) => m.abilities.some((b) => b.key === a.key));
    if (clash) throw new InstallError(`${key}: ability ${clash.key} is already offered by ${other.key}`, 'bad_package');
  }

  // Migrations: appended to the host's numbered set, in the package's order; a file that already shipped never changes.
  const prev = lock.packages.find((p) => p.key === key);
  const migDir = path.join(root, 'migrations');
  const hostFiles = (await readdir(migDir)).filter((n) => /^\d{3}_.+\.(sql|ts)$/.test(n)).sort();
  let next = hostFiles.length ? Number(/^(\d{3})/.exec(hostFiles.at(-1)!)![1]) + 1 : 2;
  const migrations: LockedMigration[] = [];
  const appended: { file: string; tables: string[] }[] = [];
  // A package removed earlier and installed again: its files are still in the host's set (forward only) — reused.
  const shipped = new Map<string, { host_file: string; sql: string }>();
  for (const n of hostFiles) {
    const mm = new RegExp(`^\\d{3}_nep_${slug}__(.+)$`).exec(n);
    if (!mm) continue;
    const body = /\n {2}execute \$(neos_pkg_*)\$\n([\s\S]*?)\n\$\1\$;\n/.exec(await readFile(path.join(migDir, n), 'utf8'));
    if (body) shipped.set(mm[1]!, { host_file: n, sql: body[2]! });
  }
  for (const f of Object.keys(m.migrations ?? {}).sort()) {
    const sql = m.migrations[f]!;
    const sha = sha256Tagged(sql);
    const earlier = shipped.get(f.replace(/[^A-Za-z0-9_.-]/g, '_'));
    const had = prev?.migrations.find((x) => x.package_file === f) ?? (earlier ? { package_file: f, host_file: earlier.host_file, sha256: earlier.sql === sql.replace(/\s*$/, '') ? sha : 'changed' } : undefined);
    if (had) {
      if (had.sha256 !== sha) throw new InstallError(`${key}@${version} changes migrations/${f}, which already shipped as ${had.host_file}; a package fixes forward with a new file`, 'migration_changed');
      migrations.push(had);
      continue;
    }
    if (next > 999) throw new InstallError(`${host} has no migration numbers left`, 'no_numbers');
    const hostFile = `${String(next++).padStart(3, '0')}_nep_${slug}__${f.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const tables = [...new Set([...sql.matchAll(CREATE_TABLE)].map((x) => x[1]!).concat((m.tables ?? []).filter((t) => new RegExp(`\\b${t}\\b`).test(sql))))];
    await stage.write(path.join(migDir, hostFile), hostMigrationSql({ key, version, artifact_hash: entry.artifact_hash, packageFile: f, hostFile, sql, tables: m.tables ?? [] }));
    migrations.push({ package_file: f, host_file: hostFile, sha256: sha });
    appended.push({ file: hostFile, tables });
  }
  // Earlier versions' files stay listed (they ran; forward only) even when a new version dropped them.
  for (const old of prev?.migrations ?? []) if (!migrations.some((x) => x.host_file === old.host_file)) migrations.push(old);
  migrations.sort((a, b) => a.host_file.localeCompare(b.host_file));
  if (appended.length) {
    const ledgerFile = path.join(migDir, 'migrate.json');
    const ledgerText = await readFile(ledgerFile, 'utf8').catch(() => `{\n  "migrations": []\n}\n`);
    const rows = appended.map((a) => ({ file: a.file, tables: a.tables.sort(), baseline: false, ...(o.proven ? { proven_on_populated_data: o.proven } : {}) }));
    await stage.write(ledgerFile, appendJsonArray(ledgerText, 'migrations', rows));
  }

  // Unpack, read-only.
  const rel = path.join(PACKAGES_DIR, `nep-${slug}`);
  const dir = path.join(root, rel);
  await stage.replaceDir(dir);
  const files = unpackFiles(bytes, bundle);
  const hashes: Record<string, string> = {};
  for (const [f, b] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), b, { mode: 0o444 });
    await chmod(path.join(dir, f), 0o444);
    hashes[f] = sha256Tagged(b);
  }

  const locked: LockedPackage = {
    key,
    version,
    artifact_hash: entry.artifact_hash,
    content_hash: entry.content_hash,
    signature,
    dir: rel.split(path.sep).join('/'),
    files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
    role: packageRole(host, key),
    tables: [...(m.tables ?? [])],
    migrations,
  };
  const newLock: PackagesLock = { ...lock, packages: [...lock.packages.filter((p) => p.key !== key), locked] };
  await stage.write(lockFile, renderLock(newLock));
  const pins = [
    ...(manifest.packages ?? []).filter((p) => p.key !== key),
    {
      key,
      version,
      artifact_hash: entry.artifact_hash,
      content_hash: entry.content_hash,
      requires: packageRequires(m),
      abilities: m.abilities.map((a): ManifestAbility => ({ ...a })),
      doors: [...(m.doors ?? [])],
      skills: m.skills.map((s) => ({ key: s.key, requires: s.requires })),
    },
  ].sort((a, b) => a.key.localeCompare(b.key));
  await stage.write(manifestFile, setJsonArray(await readText(manifestFile), 'packages', pins));

  // Its tests, inside the host.
  let selftest: InstallResult['selftest'] = 'skipped';
  try {
    if (o.tests !== false) selftest = await testInsideHost(root, bundle, o.tests?.adminUrl, log);
  } catch (e) {
    await stage.rollback();
    throw e instanceof InstallError ? e : new InstallError(`${key}@${version} was not installed: ${(e as Error).message}`, 'tests_failed');
  }
  await stage.commit();
  log(`${host}: installed ${key}@${version} (${entry.artifact_hash}); migrations ${appended.map((a) => a.file).join(', ') || '(none new)'}; self-test ${selftest}`);
  return { key, version, kind: 'package', artifact_hash: entry.artifact_hash, migrations: appended.map((a) => a.file), selftest };
}

/** The host's whole migration set (template, app, the package's new files) in a scratch database, then the package's self-test there. */
async function testInsideHost(root: string, bundle: PackageBundle, adminUrl: string | undefined, log: (m: string) => void): Promise<'passed' | 'none'> {
  const { migrateApp } = await import('../app.ts');
  const manifest = JSON.parse(await readText(path.join(root, 'manifest.json'))) as Manifest;
  const prevEnv = process.env.NEOS_ADMIN_URL;
  if (adminUrl) process.env.NEOS_ADMIN_URL = adminUrl;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  try {
    db = await createTestDatabase('neos_install');
  } finally {
    if (adminUrl) process.env.NEOS_ADMIN_URL = prevEnv;
    if (adminUrl && prevEnv === undefined) delete process.env.NEOS_ADMIN_URL;
  }
  try {
    await migrateApp(db.adminUrl, { manifest, migrationsDir: path.join(root, 'migrations'), packages: { root }, abilities: {}, prompt: {} as any, skills: [] });
    if (!hasSelftest(bundle)) {
      log(`${bundle.manifest.key}@${bundle.manifest.version} has no self-test (reported as none, never as passed); its migrations ran inside the host`);
      return 'none';
    }
    await selftestPackage(db.adminUrl, manifest.app, bundle);
    return 'passed';
  } finally {
    await db.drop().catch(() => {});
  }
}

// ── remove ──

export interface RemoveResult {
  key: string;
  kind: 'skill' | 'package';
  /** Host migration files that stay: they ran (forward only); the tables stay until a contract migration drops them. */
  kept_migrations: string[];
}

/**
 * `neos install --remove`: the package's files, its lock entry and its manifest lines go; its migrations stay in
 * the host's set (they ran, and migrations are forward only), so its tables are kept. Dropping them is a contract
 * migration in the host's own set, reviewed by the DBA like any other.
 */
export async function removeEntry(o: { root: string; key: string; log?: (m: string) => void }): Promise<RemoveResult> {
  const root = path.resolve(o.root);
  const manifestFile = path.join(root, 'manifest.json');
  const lockFile = path.join(root, LOCK_FILE);
  const lock = await readLock(lockFile);
  const manifestText = await readText(manifestFile);
  const manifest = JSON.parse(manifestText) as Manifest;
  const stage = new Staging();
  const skill = lock.skills.find((s) => s.key === o.key);
  if (skill) {
    await stage.write(lockFile, renderLock({ ...lock, skills: lock.skills.filter((s) => s.key !== o.key) }));
    await stage.write(manifestFile, setJsonArray(manifestText, 'registry_skills', (manifest.registry_skills ?? []).filter((s) => s.key !== o.key), 'packages'));
    await stage.commit();
    o.log?.(`${manifest.app}: unpinned skill ${o.key}`);
    return { key: o.key, kind: 'skill', kept_migrations: [] };
  }
  const p = lock.packages.find((x) => x.key === o.key);
  if (!p) throw new InstallError(`${o.key} is not installed in ${manifest.app}`, 'not_installed');
  const dir = path.join(root, p.dir);
  await makeWritable(dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await stage.write(lockFile, renderLock({ ...lock, packages: lock.packages.filter((x) => x.key !== o.key) }));
  await stage.write(manifestFile, setJsonArray(manifestText, 'packages', (manifest.packages ?? []).filter((x) => x.key !== o.key)));
  await stage.commit();
  const kept = p.migrations.map((x) => x.host_file);
  o.log?.(`${manifest.app}: removed ${o.key}@${p.version}; its migrations stay (${kept.join(', ') || 'none'}) and its tables are kept`);
  return { key: o.key, kind: 'package', kept_migrations: kept };
}

type LockedMigration = LockedPackage['migrations'][number];
