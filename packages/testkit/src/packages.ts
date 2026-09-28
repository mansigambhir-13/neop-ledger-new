// Registry helpers for tests (v3 S7): publish → a second operator's review → `neos install` into a copy of the
// host app's folder (the build) → the host is rebuilt (its migration file applied, the backend restarted on the new
// definition, its manifest re-registered). Nothing is installed at run time.
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Manifest } from '@neop/contracts';
import { buildPackage, httpRegistrySource, installEntry, LOCK_FILE, removeEntry, type AppDefinition, type InstallOptions, type InstallResult, type PackageBundle, type RegistrySource, type RemoveResult } from '@neop/template';
import type { Pilot } from './pilot.ts';

export async function publishPackage(P: Pilot, dirOrBundle: string | PackageBundle): Promise<{ key: string; version: string }> {
  const bundle = typeof dirOrBundle === 'string' ? await buildPackage(dirOrBundle) : dirOrBundle;
  const sub = await P.api('POST', '/api/registry/packages', { bundle }, P.operator.token);
  if (sub.status !== 200) throw new Error(`submit: ${JSON.stringify(sub.body)}`);
  const review = (await P.api('GET', '/api/registry/reviews', undefined, P.operator.token)).body.reviews.find((r: any) => r.key === bundle.manifest.key && r.version === bundle.manifest.version);
  const ok = await P.api('POST', `/api/registry/reviews/${review.id}/answer`, { decision: 'yes', fingerprint_seen: review.fingerprint }, P.operator2.token); // four eyes
  if (ok.status !== 200) throw new Error(`review: ${JSON.stringify(ok.body)}`);
  return { key: bundle.manifest.key, version: bundle.manifest.version };
}

/** The registry as `neos install` reaches it from a pilot: the platform's HTTP surface, as an operator. */
export function pilotRegistry(P: Pilot): RegistrySource {
  return httpRegistrySource({ platformUrl: P.platformUrl, bearer: P.operator.token });
}

/** A writable copy of an app's folder — the build `neos install` changes (the repo's own folder is never touched). */
export async function hostCopy(def: AppDefinition): Promise<string> {
  const from = def.packages?.root ?? path.dirname(def.migrationsDir);
  const to = await mkdtemp(path.join(os.tmpdir(), `neop-host-${def.manifest.app}-`));
  await cp(path.join(from, 'migrations'), path.join(to, 'migrations'), { recursive: true });
  await cp(path.join(from, 'src', 'packages'), path.join(to, 'src', 'packages'), { recursive: true }).catch(() => {});
  await cp(path.join(from, LOCK_FILE), path.join(to, LOCK_FILE)).catch(() => {});
  // The manifest the app runs now (a test may have rebuilt it already), in the layout the installer edits.
  await cp(path.join(from, 'manifest.json'), path.join(to, 'manifest.json')).catch(async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(to, 'manifest.json'), `${JSON.stringify(def.manifest, null, 2)}\n`);
  });
  return to;
}

/** The app definition of a build folder: the same code, with that folder's manifest, migrations and packages. */
export async function defFromBuild(def: AppDefinition, root: string): Promise<AppDefinition> {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  return { ...def, manifest, migrationsDir: path.join(root, 'migrations'), packages: { root } };
}

/**
 * `neos install <app> <spec>` against a pilot, then deploy that build. Each call starts from the build the app runs
 * now (its current folder), so installs stack. Throws what the installer throws; a refused install changes nothing.
 */
export async function installAndRebuild(P: Pilot, app: string, spec: string, o: Partial<Pick<InstallOptions, 'tests' | 'proven' | 'source' | 'trusted'>> = {}): Promise<InstallResult & { root: string }> {
  const def = P.defs[app]!;
  const root = await hostCopy(def);
  const r = await installEntry({ root, spec, source: o.source ?? pilotRegistry(P), tests: o.tests, proven: o.proven, trusted: o.trusted });
  await P.rebuild(app, await defFromBuild(def, root));
  return { ...r, root };
}

/** `neos install --remove`, then deploy that build. */
export async function removeAndRebuild(P: Pilot, app: string, key: string): Promise<RemoveResult & { root: string }> {
  const def = P.defs[app]!;
  const root = await hostCopy(def);
  const r = await removeEntry({ root, key });
  await P.rebuild(app, await defFromBuild(def, root));
  return { ...r, root };
}

/** Publish (if not yet) and install at build: the whole path a package takes into a host. */
export async function installAndMigrate(P: Pilot, host: string, entry: string | PackageBundle, version?: string): Promise<InstallResult & { root: string }> {
  let key: string;
  let v: string;
  if (typeof entry === 'string' && !version) {
    const e = (await P.platform.db.query<{ version: string }>("select version from neos.registry_entries where key = $1 and status = 'published' order by published_at desc limit 1", [entry])).rows[0];
    if (!e) throw new Error(`${entry} is not published`);
    key = entry;
    v = e.version;
  } else if (typeof entry === 'string') {
    key = entry;
    v = version!;
  } else {
    key = entry.manifest.key;
    v = entry.manifest.version;
  }
  return installAndRebuild(P, host, `${key}@${v}`);
}

/** A hostile package for sandbox tests: it tries every way out and reports what happened. */
export function probeBundle(version = '1.0.0'): PackageBundle {
  const handlers = `
export const abilities = {
  'probe.try': {
    async run(args, ctx) {
      const tryIt = async (f) => { try { await f(); return 'OPEN'; } catch (e) { return String(e?.name ?? e); } };
      return {
        generatedAt: new Date().toISOString(), empty: false,
        sources: { entries: 0, entry_ids: [], basis: 'probe' },
        net: await tryIt(() => fetch('https://example.com')),
        fs: await tryIt(() => Deno.readTextFile('/etc/hosts')),
        env: await tryIt(() => Deno.env.get('HOME')),
        run: await tryIt(() => new Deno.Command('ls').output()),
        foreign_table: await tryIt(() => ctx.tables.select('journal_entries', {})),
        own_table: await tryIt(() => ctx.tables.select('nep_probe__notes', {})),
        door_off_path: await tryIt(() => ctx.doors.email.send({ to: ['x@evil.example'] })),
      };
    },
  },
  'probe.spin': { async run() { while (true) {} } },
  'probe.counter': { async run() { globalThis.__n = (globalThis.__n ?? 0) + 1; return { generatedAt: new Date().toISOString(), empty: false, sources: { entries: 0, entry_ids: [], basis: 'probe' }, n: globalThis.__n }; } },
};`;
  return {
    manifest: {
      key: 'nep-probe',
      version,
      name: 'Probe',
      description: 'Tries to escape the sandbox (test fixture).',
      doors: [],
      tables: ['nep_probe__notes'],
      skills: [],
      migrations: {
        '001_notes.sql': `create table {{schema}}.nep_probe__notes (id uuid primary key default gen_random_uuid(), company_id uuid not null, body text);
alter table {{schema}}.nep_probe__notes enable row level security; alter table {{schema}}.nep_probe__notes force row level security;
create policy company_isolation on {{schema}}.nep_probe__notes using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid) with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);`,
      },
      abilities: [
        { key: 'probe.try', version: '1.0.0', title: 'Probe', description: 'probe', kind: 'read', floor: 'on', input: { type: 'object' }, output: { type: 'object' } },
        { key: 'probe.spin', version: '1.0.0', title: 'Spin', description: 'spin', kind: 'read', floor: 'on', input: { type: 'object' }, output: { type: 'object' } },
        { key: 'probe.counter', version: '1.0.0', title: 'Counter', description: 'module state', kind: 'read', floor: 'on', input: { type: 'object' }, output: { type: 'object' } },
      ],
    },
    handlers,
  };
}
