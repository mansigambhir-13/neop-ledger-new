// registry-v3.test · v3 §10 sharing, in the registry.test style but on the platform alone.
//   B9  an app may not re-register in a way that drops or breaks an ability an installed skill/package requires
//       (v3 S7: what is installed is what each build pinned — its manifest's packages and registry_skills);
//       and (S7) a package version may not retire what a pinned entry requires; 022 proven on populated data.
//   B10 package format: nep.json {name, version, author, signature?} is an alias of the manifest; new packages name
//       their tables nep_<name>__* (already-published ones, e.g. nep-gst, keep nep_<name>_*); metrics.json and
//       references/ travel inside the signed bundle (verified by the artifact hash, their hashes shown for review).
import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate, roleUrl } from '@neop/pgkit';
import { buildPackage, type PackageBundle } from '@neop/template';
import { contentHash, generateSigningKeys, migratePlatform, Platform, PLATFORM_MIGRATIONS, sha256Bytes } from '../src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let db: { adminUrl: string; drop: () => Promise<void> };
let p: Platform;
let c: pg.Client;
let co = '';
let tmp = '';

const ability = (key: string, version = '1.0.0', kind: 'read' | 'write' = 'read') => ({ key, version, title: key, description: key, kind, floor: kind === 'write' ? 'ask_first' : 'on', input: { type: 'object' }, output: { type: 'object' } });
const manifest = (abilities: any[]) => ({ app: 'owner', name: 'Owner', subject: 's', description: 'd', version: '1.0.0', contract_version: '1', abilities, doors: [], uses: [], skills: [], packages: [], blocks: [] }) as any;

function bundle(key: string, version: string, tables: string[]): PackageBundle {
  const name = key.replace(/^nep-/, '');
  return {
    manifest: { key, version, name, description: 'fixture', doors: [], tables, skills: [], migrations: {}, abilities: [ability(`${name}.count`, version) as any] },
    handlers: 'export const abilities = {};',
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  await migratePlatform(db.adminUrl);
  p = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: await generateSigningKeys(), dbPoolSize: 3 });
  await p.ensureRegistry();
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
  co = (await p.createCompany('Acme')).id;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'neos-reg-v3-'));
});
afterAll(async () => {
  await p?.stop();
  await c?.end();
  await db?.drop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('B9 · registerApp keeps what installed registry entries require', () => {
  it('refuses 409 breaks_installed to drop, retype or move the major of a required ability; other changes pass', async () => {
    await p.registerApp({ key: 'owner', l3_url: 'http://o', manifest: manifest([ability('owner.stock.read'), ability('owner.other')]), service_secret: 's' });
    await p.registerApp({ key: 'host', l3_url: 'http://h', manifest: { ...manifest([]), app: 'host' }, service_secret: 's' });
    await p.installApp(co, 'host');
    await c.query(`insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, body, content_hash, platform_sig, status)
                   values ('owner/stock-check', '1.0.0', 'skill', 'owner', 'app:owner', '["owner.stock.read"]', 'check stock', 'sha256:x', 'sig', 'published')`);
    // v3 S7: the host's build pins it (`neos install host owner/stock-check@1.0.0` wrote it into the host's manifest).
    const pin = { key: 'owner/stock-check', version: '1.0.0', owner_app: 'owner', content_hash: 'sha256:x', requires: ['owner.stock.read'] };
    await p.registerApp({ key: 'host', l3_url: 'http://h', manifest: { ...manifest([]), app: 'host', registry_skills: [pin] }, service_secret: 's' });

    const reg = (abilities: any[]) => p.registerApp({ key: 'owner', l3_url: 'http://o', manifest: manifest(abilities), service_secret: 's' });
    await expect(reg([ability('owner.other')])).rejects.toMatchObject({ status: 409, code: 'breaks_installed' });
    await expect(reg([ability('owner.stock.read', '1.0.0', 'write'), ability('owner.other')])).rejects.toMatchObject({ code: 'breaks_installed' });
    await expect(reg([ability('owner.stock.read', '2.0.0'), ability('owner.other')])).rejects.toMatchObject({ code: 'breaks_installed', message: /owner\/stock-check@1\.0\.0.*host.*owner\.stock\.read/ });
    // A minor version and dropping an ability nothing requires are fine.
    await reg([ability('owner.stock.read', '1.1.0')]);
    expect((await c.query("select manifest->'abilities'->0->>'version' v from neos.apps where key = 'owner'")).rows[0].v).toBe('1.1.0');
    // Once the host's next build no longer pins it (`neos install --remove`, re-registered), nothing pins it any more.
    await p.registerApp({ key: 'host', l3_url: 'http://h', manifest: { ...manifest([]), app: 'host', registry_skills: [] }, service_secret: 's' });
    await reg([ability('owner.other')]);
  });

  it('an installed package pins what its skills require the same way; the host itself may not break its own package', async () => {
    const pkgPin = { key: 'nep-tally', version: '1.0.0', requires: ['self.books.read'], abilities: [ability('tally.count')], doors: [], skills: [{ key: 'tally', requires: ['self.books.read', 'tally.count'] }] };
    await p.registerApp({ key: 'self', l3_url: 'http://s', manifest: { ...manifest([ability('self.books.read')]), app: 'self', packages: [pkgPin] }, service_secret: 's' });
    const again = (abilities: any[], packages: any[]) => p.registerApp({ key: 'self', l3_url: 'http://s', manifest: { ...manifest(abilities), app: 'self', packages }, service_secret: 's' });
    await expect(again([], [pkgPin])).rejects.toMatchObject({ code: 'breaks_installed', message: /nep-tally@1\.0\.0 \(installed in self\) requires self\.books\.read/ });
    // The same build that removes the package may drop what only it needed.
    await again([], []);
  });
});

describe('v3 S7 · publish keeps what pinned entries require', () => {
  it('a new package version may not drop, recast or major-bump an ability a pinned skill requires until the old version has been deprecated 30 days', async () => {
    const v1 = bundle('nep-gauge', '1.0.0', ['nep_gauge__items']);
    v1.manifest.abilities = [ability('gauge.count') as any, ability('gauge.level') as any];
    const r1 = await p.registry.submit('user:op', { kind: 'package', key: 'nep-gauge', version: '1.0.0', bundle: v1 });
    await c.query(`update neos.registry_entries set status = 'published', platform_sig = 'sig', published_at = now() where key = 'nep-gauge' and version = '1.0.0'`);
    void r1;
    // A skill pinned by the app 'user1' needs gauge.count (the package's own ability).
    const skill = { key: 'owner/gauge-check', version: '1.0.0', owner_app: 'owner', content_hash: 'sha256:y', requires: ['gauge.count'] };
    await p.registerApp({ key: 'user1', l3_url: 'http://u', manifest: { ...manifest([]), app: 'user1', registry_skills: [skill] }, service_secret: 's' });
    const next = (version: string, abilities: any[]) => {
      const b = bundle('nep-gauge', version, ['nep_gauge__items']);
      b.manifest.abilities = abilities;
      return p.registry.submit('user:op', { kind: 'package', key: 'nep-gauge', version, bundle: b });
    };
    await expect(next('1.1.0', [ability('gauge.level', '1.1.0')])).rejects.toMatchObject({ status: 409, code: 'breaks_pinned', message: /owner\/gauge-check@1\.0\.0 \(pinned by user1\) requires gauge\.count; this version drops it/ });
    await expect(next('1.1.0', [ability('gauge.count', '1.1.0', 'write'), ability('gauge.level', '1.1.0')])).rejects.toMatchObject({ code: 'breaks_pinned', message: /turns it from a read into a write/ });
    await expect(next('2.0.0', [ability('gauge.count', '2.0.0'), ability('gauge.level', '2.0.0')])).rejects.toMatchObject({ code: 'breaks_pinned', message: /moves it from 1\.0\.0 to 2\.0\.0/ });
    // Dropping what nothing pinned needs is fine.
    await next('1.1.0', [ability('gauge.count', '1.1.0')]);
    await c.query(`update neos.registry_entries set status = 'published', platform_sig = 'sig', published_at = now() where key = 'nep-gauge' and version = '1.1.0'`);
    // Deprecated, but inside the window: still refused. Past 30 days: the owner may move on.
    await p.registry.deprecate({ role: 'operator' }, 'nep-gauge', '1.1.0');
    await expect(next('2.0.0', [ability('gauge.level', '2.0.0')])).rejects.toMatchObject({ code: 'breaks_pinned' });
    await c.query("update neos.registry_entries set deprecated_at = now() - interval '31 days' where key = 'nep-gauge' and version = '1.1.0'");
    await next('2.0.0', [ability('gauge.level', '2.0.0')]);
  });

  it('a version a build pins is retired only 30 days after its deprecation; pins are read from the registered manifests', async () => {
    await c.query(`insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, body, content_hash, platform_sig, status)
                   values ('owner/old-skill', '1.0.0', 'skill', 'owner', 'app:owner', '[]', 'old', 'sha256:z', 'sig', 'published')`);
    const pin = { key: 'owner/old-skill', version: '1.0.0', owner_app: 'owner', content_hash: 'sha256:z', requires: [] };
    await p.registerApp({ key: 'user2', l3_url: 'http://u2', manifest: { ...manifest([]), app: 'user2', registry_skills: [pin] }, service_secret: 's' });
    const op = { role: 'operator' };
    await expect(p.registry.retire(op, 'owner/old-skill', '1.0.0')).rejects.toMatchObject({ code: 'pinned', message: /user2 still pins owner\/old-skill@1\.0\.0/ });
    await p.registry.deprecate(op, 'owner/old-skill', '1.0.0');
    await expect(p.registry.retire(op, 'owner/old-skill', '1.0.0')).rejects.toMatchObject({ code: 'pinned' });
    await c.query("update neos.registry_entries set deprecated_at = now() - interval '31 days' where key = 'owner/old-skill'");
    await p.registry.retire(op, 'owner/old-skill', '1.0.0');
    expect((await c.query("select status from neos.registry_entries where key = 'owner/old-skill'")).rows[0].status).toBe('retired');
    // What the registry schema says each app pinned (v3 §10 "uses: what each app has pinned").
    const pins = (await c.query("select app, key, version, kind from neos_registry.pins where app in ('user1', 'user2') order by app")).rows;
    expect(pins).toEqual([
      { app: 'user1', key: 'owner/gauge-check', version: '1.0.0', kind: 'skill' },
      { app: 'user2', key: 'owner/old-skill', version: '1.0.0', kind: 'skill' },
    ]);
  });
});

describe('022 on a populated platform database', () => {
  it('022 applies forward on a populated platform database (entries, installs and apps kept; skills carry their text and signature; pins from manifests)', async () => {
    const d = await createTestDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-021-'));
    const admin = new pg.Client({ connectionString: d.adminUrl });
    try {
      await cp(PLATFORM_MIGRATIONS, dir, { recursive: true });
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      for (const m of led.migrations.filter((x: { file: string }) => x.file >= '022')) await rm(path.join(dir, m.file));
      led.migrations = led.migrations.filter((m: { file: string }) => m.file < '022');
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
      await bootstrapFamily(d.adminUrl, 'neos', { runner: false });
      const first = await migrate({ adminUrl: d.adminUrl, schema: 'neos', sources: { dir }, tenantLint: false });
      expect(first.at(-1)!.name < '022').toBe(true);
      await admin.connect();
      const co = (await admin.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
      const m = { ...manifest([ability('owner.stock.read')]), packages: [{ key: 'nep-gst', version: '2.0.0', content_hash: 'sha256:c', requires: ['owner.stock.read'] }], registry_skills: [{ key: 'owner/check', version: '1.0.0', owner_app: 'owner', content_hash: 'sha256:s', requires: [] }] };
      await admin.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('owner', 'http://o', $1, '1', 'h')", [JSON.stringify(m)]);
      await admin.query(`insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, body, content_hash, platform_sig, status)
                         values ('owner/check', '1.0.0', 'skill', 'owner', 'app:owner', '[]', 'check the stock', 'sha256:s', 'sig-s', 'published')`);
      await admin.query("insert into neos.registry_artifacts (hash, bytes, size) values ('sha256:a', 'x', 1)");
      await admin.query(`insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, offers, artifact_hash, content_hash, platform_sig, status)
                         values ('nep-gst', '2.0.0', 'package', null, 'user:x', '[]', '[]', 'sha256:a', 'sha256:c', 'sig-p', 'published')`);
      await admin.query(`insert into neos.registry_installs (company_id, host_app, entry_key, pinned_version, status) values ($1, 'owner', 'nep-gst', '2.0.0', 'active')`, [co]);
      const counts = async () => (await admin.query("select (select count(*) from neos.registry_entries)::int e, (select count(*) from neos.registry_installs)::int i, (select count(*) from neos.apps)::int a")).rows[0];
      const before = await counts();
      const rest = await migrate({ adminUrl: d.adminUrl, schema: 'neos', sources: { dir: PLATFORM_MIGRATIONS }, tenantLint: false });
      expect(rest.map((x) => x.name)).toContain('022_registry_pins.sql');
      expect(await counts()).toEqual(before);
      expect((await admin.query('select key, body, platform_sig from neos_registry.skills')).rows).toEqual([{ key: 'owner/check', body: 'check the stock', platform_sig: 'sig-s' }]);
      expect((await admin.query('select key, platform_sig from neos_registry.packages')).rows).toEqual([{ key: 'nep-gst', platform_sig: 'sig-p' }]);
      expect((await admin.query('select app, key, version, kind from neos_registry.pins order by kind')).rows).toEqual([
        { app: 'owner', key: 'nep-gst', version: '2.0.0', kind: 'package' },
        { app: 'owner', key: 'owner/check', version: '1.0.0', kind: 'skill' },
      ]);
    } finally {
      await admin.end().catch(() => {});
      await d.drop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('B10 · package tables', () => {
  it('a new package must name its tables nep_<name>__*', async () => {
    await expect(p.registry.submit('user:op', { kind: 'package', key: 'nep-stock', version: '1.0.0', bundle: bundle('nep-stock', '1.0.0', ['nep_stock_items']) })).rejects.toMatchObject({
      code: 'bad_manifest',
      message: /nep_stock__\*/,
    });
    await expect(p.registry.submit('user:op', { kind: 'package', key: 'nep-stock', version: '1.0.0', bundle: bundle('nep-stock', '1.0.0', ['nep_other__items']) })).rejects.toMatchObject({ code: 'bad_manifest' });
    const ok = await p.registry.submit('user:op', { kind: 'package', key: 'nep-stock', version: '1.0.0', bundle: bundle('nep-stock', '1.0.0', ['nep_stock__items']) });
    expect(ok.artifact_hash).toMatch(/^sha256:/);
  });

  it('already-published packages keep the single-underscore prefix: nep-gst as shipped, and any key already in the registry', async () => {
    const gst = await buildPackage(path.join(ROOT, 'registry/nep-gst'));
    expect(gst.manifest.tables.every((t) => t.startsWith('nep_gst_') && !t.startsWith('nep_gst__'))).toBe(true);
    await p.registry.submit('user:op', { kind: 'package', key: 'nep-gst', version: gst.manifest.version, bundle: gst });
    // A key published before v3 (its old row is here) may publish its next version with the same prefix.
    await c.query("insert into neos.registry_artifacts (hash, bytes, size) values ('sha256:old', '\\x00', 1) on conflict do nothing");
    await c.query(`insert into neos.registry_entries (key, version, kind, published_by, artifact_hash, content_hash, platform_sig, status) values ('nep-tds', '1.0.0', 'package', 'user:x', 'sha256:old', 'sha256:c', 'sig', 'published')`);
    await p.registry.submit('user:op', { kind: 'package', key: 'nep-tds', version: '1.1.0', bundle: bundle('nep-tds', '1.1.0', ['nep_tds_returns']) });
  });
});

describe('B10 · nep.json, metrics.json and references/', () => {
  it('nep.json is the manifest; its signature is the author’s over the content hash; metrics and references ride in the signed bytes', async () => {
    const dir = path.join(tmp, 'count');
    await mkdir(path.join(dir, 'references', 'forms'), { recursive: true });
    await writeFile(path.join(dir, 'handlers.js'), 'export const abilities = {};');
    await writeFile(path.join(dir, 'metrics.json'), JSON.stringify({ counts: { unit: 'items' } }));
    await writeFile(path.join(dir, 'references', 'rules.md'), '# How we count\n');
    await writeFile(path.join(dir, 'references', 'forms', 'f1.txt'), 'form one');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const author = { name: 'Acme Tools', public_key: publicKey.export({ format: 'jwk' }) };
    const nep = { name: 'count', title: 'Counter', version: '1.0.0', author, description: 'counts', doors: [], tables: ['nep_count__items'], abilities: [ability('count.total')] };
    await writeFile(path.join(dir, 'nep.json'), JSON.stringify(nep));

    const unsigned = await buildPackage(dir);
    expect(unsigned.manifest).toMatchObject({ key: 'nep-count', name: 'Counter', version: '1.0.0', author: { name: 'Acme Tools' } });
    expect(unsigned.metrics).toEqual({ counts: { unit: 'items' } });
    expect(unsigned.references).toEqual({ 'forms/f1.txt': 'form one', 'rules.md': '# How we count\n' });

    // The author signs the content hash of exactly the bundle without its signature.
    const artifact = sha256Bytes(Buffer.from(JSON.stringify(unsigned)));
    const ch = contentHash({ key: 'nep-count', version: '1.0.0', kind: 'package', body: null, requires: [], offers: [{ key: 'count.total', kind: 'read', floor: 'on', version: '1.0.0' }], artifact_hash: artifact });
    await writeFile(path.join(dir, 'nep.json'), JSON.stringify({ ...nep, signature: sign(null, Buffer.from('sha256:other'), privateKey).toString('base64url') }));
    await expect(p.registry.submit('user:op', { kind: 'package', key: 'nep-count', version: '1.0.0', bundle: await buildPackage(dir) })).rejects.toMatchObject({ code: 'bad_author_sig' });
    await writeFile(path.join(dir, 'nep.json'), JSON.stringify({ ...nep, signature: sign(null, Buffer.from(ch), privateKey).toString('base64url') }));
    const out = await p.registry.submit('user:op', { kind: 'package', key: 'nep-count', version: '1.0.0', bundle: await buildPackage(dir) });
    expect(out).toMatchObject({ content_hash: ch, artifact_hash: artifact });

    // Verified by hash: the stored artifact holds metrics and references, and never the signature.
    const stored = JSON.parse((await p.registry.artifact(artifact))!.toString('utf8'));
    expect(stored.metrics).toEqual({ counts: { unit: 'items' } });
    expect(stored.references['rules.md']).toBe('# How we count\n');
    expect(stored.manifest.signature).toBeUndefined();
    const diff = (await c.query("select diff from neos.registry_reviews where key = 'nep-count'")).rows[0].diff as string;
    expect(diff).toContain('author signature: verified');
    expect(diff).toContain(sha256Bytes('form one'));
    expect(diff).toContain('metrics_sha256');
  });

  it('nep.json and manifest.json must agree; references must be plain relative paths; metrics must be an object', async () => {
    const dir = path.join(tmp, 'both');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'handlers.js'), '');
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ key: 'nep-both', version: '1.0.0' }));
    await writeFile(path.join(dir, 'nep.json'), JSON.stringify({ name: 'both', version: '2.0.0' }));
    await expect(buildPackage(dir)).rejects.toThrow(/disagree/);
    const b = bundle('nep-refs', '1.0.0', ['nep_refs__x']);
    await expect(p.registry.submit('user:op', { kind: 'package', key: 'nep-refs', version: '1.0.0', bundle: { ...b, references: { '../etc/passwd': 'x' } } })).rejects.toMatchObject({ code: 'bad_manifest' });
    await expect(p.registry.submit('user:op', { kind: 'package', key: 'nep-refs', version: '1.0.0', bundle: { ...b, metrics: [] as any } })).rejects.toMatchObject({ code: 'bad_manifest' });
  });
});
