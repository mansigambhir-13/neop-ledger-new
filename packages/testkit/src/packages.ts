// Registry helpers for tests: publish → review → install → migrate, as an
// operator, a company admin and the migration runner would.
import type { Platform } from '@neop/platform';
import { buildPackage, migratePackage, type PackageBundle } from '@neop/template';
import type { Pilot } from './pilot.ts';

/** The ops migration runner: apply pending package migrations, then activate the installs. */
export async function runPackageMigrations(adminUrl: string, platform: Platform): Promise<string[]> {
  const applied: string[] = [];
  for (const p of await platform.pendingPackageMigrations()) {
    applied.push(...(await migratePackage(adminUrl, p.host_app, p.bundle)));
    await platform.markPackageMigrated(p.host_app, p.entry_key, p.version);
  }
  return applied;
}

export async function publishPackage(P: Pilot, dirOrBundle: string | PackageBundle): Promise<{ key: string; version: string }> {
  const bundle = typeof dirOrBundle === 'string' ? await buildPackage(dirOrBundle) : dirOrBundle;
  const sub = await P.api('POST', '/api/registry/packages', { bundle }, P.operator.token);
  if (sub.status !== 200) throw new Error(`submit: ${JSON.stringify(sub.body)}`);
  const review = (await P.api('GET', '/api/registry/reviews', undefined, P.operator.token)).body.reviews.find((r: any) => r.key === bundle.manifest.key && r.version === bundle.manifest.version);
  const ok = await P.api('POST', `/api/registry/reviews/${review.id}/answer`, { decision: 'yes', fingerprint_seen: review.fingerprint }, P.operator.token);
  if (ok.status !== 200) throw new Error(`review: ${JSON.stringify(ok.body)}`);
  return { key: bundle.manifest.key, version: bundle.manifest.version };
}

export async function installAndMigrate(P: Pilot, host: string, entry: string): Promise<void> {
  const r = await P.api('POST', '/api/registry/installs', { host_app: host, entry_key: entry });
  if (r.status !== 200) throw new Error(`install: ${JSON.stringify(r.body)}`);
  await runPackageMigrations(P.adminUrl, P.platform);
  for (const b of Object.values(P.backends)) b.core.packages.invalidate();
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
        own_table: await tryIt(() => ctx.tables.select('nep_probe_notes', {})),
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
      tables: ['nep_probe_notes'],
      skills: [],
      migrations: {
        '001_notes.sql': `create table {{schema}}.nep_probe_notes (id uuid primary key default gen_random_uuid(), company_id uuid not null, body text);
alter table {{schema}}.nep_probe_notes enable row level security; alter table {{schema}}.nep_probe_notes force row level security;
create policy company_isolation on {{schema}}.nep_probe_notes using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid) with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);`,
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
