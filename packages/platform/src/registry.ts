// THE REGISTRY (Phase 5). Four ways to share, one decision rule (plan §Registry).
// This module holds the skill and package entries: publish → a person reviews
// the diff → platform co-signs → hosts pin a version → hosts verify offline.

import { createPublicKey, verify as verifySig } from 'node:crypto';
import { registryContentHash, sha256Tagged, type ManifestAbility } from '@neop/contracts';
import { assertIdent, tx, type PoolClient } from '@neop/pgkit';
import { jwtVerify, createLocalJWKSet, SignJWT } from 'jose';
import pg from 'pg';
import type { KeyRing } from './keys.ts';
import { isEd25519Jwk, PlatformError, type Platform } from './platform.ts';

/** An author's Ed25519 signature (base64url) over the UTF-8 bytes of the content hash. */
export function verifyAuthorSig(publicJwk: unknown, contentHash: string, sig: unknown): boolean {
  if (!isEd25519Jwk(publicJwk) || typeof sig !== 'string' || !/^[A-Za-z0-9_-]{80,90}$/.test(sig)) return false;
  try {
    return verifySig(null, Buffer.from(contentHash, 'utf8'), createPublicKey({ key: publicJwk as any, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export interface PackageManifest {
  key: string; // nep-<name>
  version: string;
  name: string;
  description: string;
  abilities: ManifestAbility[];
  doors: string[];
  tables: string[];
  skills: { key: string; requires: string[]; body: string }[];
  migrations: Record<string, string>;
}

/** The artifact is exactly these bytes: a JSON bundle {manifest, handlers}. */
export interface PackageBundle {
  manifest: PackageManifest;
  handlers: string;
}

export const sha256Bytes = sha256Tagged;
export const contentHash = registryContentHash;

/** A line diff: good enough for a person to see what changed in a skill. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  const setA = new Set(a);
  const setB = new Set(b);
  for (const l of a) if (!setB.has(l)) out.push(`- ${l}`);
  for (const l of b) if (!setA.has(l)) out.push(`+ ${l}`);
  return out.length ? out.join('\n') : '(no line changes)';
}

export class Registry {
  readonly p: Platform;
  readonly keys: KeyRing;
  constructor(p: Platform, keys: KeyRing) {
    this.p = p;
    this.keys = keys;
  }

  jwks() {
    return this.keys.jwks();
  }

  /** Co-signature: a long-lived JWS over the content hash, verifiable offline against the registry JWKS. */
  private async sign(key: string, version: string, content_hash: string): Promise<string> {
    return new SignJWT({ key, version, content_hash })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.active.kid })
      .setIssuer('neos-registry')
      .setIssuedAt()
      .sign(this.keys.active.privateKey);
  }

  /**
   * Submit a skill or package version. A skill is published by the app that
   * owns it (service-authenticated); a package by a platform operator.
   */
  async submit(
    publishedBy: string,
    e: {
      kind: 'skill' | 'package';
      key: string;
      version: string;
      owner_app?: string | null;
      body?: string;
      requires?: string[];
      bundle?: PackageBundle;
      /** The author's signature over the content hash. A skill is checked against its app's registered author key. */
      author?: { sig?: string; public_key?: unknown } | null;
    },
  ) {
    let artifactHash: string | null = null;
    let offers: unknown = [];
    let requires = e.requires ?? [];
    if (e.kind === 'package') {
      if (!e.bundle) throw new PlatformError(400, 'bad_request', 'a package needs its bundle');
      const bytes = Buffer.from(JSON.stringify(e.bundle));
      artifactHash = sha256Bytes(bytes);
      const m = e.bundle.manifest;
      if (m.key !== e.key || m.version !== e.version) throw new PlatformError(422, 'bad_manifest', 'bundle manifest key/version must match');
      const prefix = e.key.replace(/^nep-/, '');
      for (const t of m.tables) if (!t.startsWith(`nep_${prefix}_`)) throw new PlatformError(422, 'bad_manifest', `package tables must be named nep_${prefix}_*`);
      for (const a of m.abilities) {
        if (!a.key.startsWith(`${prefix}.`)) throw new PlatformError(422, 'bad_manifest', `package abilities must be named ${prefix}.*`);
        if (a.kind === 'read' && a.floor === 'ask_first') throw new PlatformError(422, 'read_cannot_ask_first', a.key);
      }
      offers = m.abilities.map((a) => ({ key: a.key, kind: a.kind, floor: a.floor, version: a.version }));
      requires = [...new Set(m.skills.flatMap((s) => s.requires))];
      await this.p.db.query('insert into neos.registry_artifacts (hash, bytes, size) values ($1, $2, $3) on conflict do nothing', [artifactHash, bytes, bytes.length]);
    } else {
      if (!e.body?.trim()) throw new PlatformError(400, 'bad_request', 'a skill needs its text');
      if (!e.owner_app || !e.key.startsWith(`${e.owner_app}/`)) throw new PlatformError(422, 'bad_key', 'a skill key is <owner_app>/<name>');
    }
    const body = e.kind === 'skill' ? e.body! : null;
    const ch = contentHash({ key: e.key, version: e.version, kind: e.kind, body, requires, offers, artifact_hash: artifactHash });
    // Author signature, verified before anything reaches a reviewer (publishers hold an Ed25519 key).
    let authorKey: unknown = null;
    if (e.kind === 'skill') {
      authorKey = (await this.p.db.query<{ author_key: unknown }>('select author_key from neos.apps where key = $1', [e.owner_app])).rows[0]?.author_key ?? null;
      if (!authorKey) throw new PlatformError(403, 'no_author_key', `${e.owner_app} registered no author key; it cannot publish to the registry`);
    } else if (e.author?.public_key !== undefined) {
      authorKey = e.author.public_key;
    } else if (process.env.NEOS_ENV === 'production') {
      throw new PlatformError(403, 'unsigned', 'a package must carry its author key and signature');
    }
    if (authorKey && !verifyAuthorSig(authorKey, ch, e.author?.sig)) {
      await this.p.gateway.audit({ company_id: null, actor: publishedBy, action: 'registry.publish_refused', outcome: 'bad_author_sig', detail: { key: e.key, version: e.version, content_hash: ch } });
      throw new PlatformError(403, 'bad_author_sig', `the author signature does not verify over ${ch}`);
    }
    return tx(this.p.db, async (c) => {
      const exists = await c.query('select 1 from neos.registry_entries where key = $1 and version = $2', [e.key, e.version]);
      if (exists.rowCount) throw new PlatformError(409, 'version_exists', `${e.key}@${e.version} exists; versions are immutable`);
      await c.query(
        `insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, offers, body, artifact_hash, content_hash, author_key, author_sig)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [e.key, e.version, e.kind, e.owner_app ?? null, publishedBy, JSON.stringify(requires), JSON.stringify(offers), body, artifactHash, ch, authorKey ? JSON.stringify(authorKey) : null, authorKey ? e.author!.sig : null],
      );
      const prev = (
        await c.query<{ body: string | null; artifact_hash: string | null; requires: string[] }>(
          `select body, artifact_hash, requires from neos.registry_entries where key = $1 and status in ('published', 'deprecated') order by published_at desc limit 1`,
          [e.key],
        )
      ).rows[0];
      const shown = e.kind === 'skill' ? body! : JSON.stringify({ ...e.bundle!.manifest, handlers_sha256: sha256Bytes(e.bundle!.handlers) }, null, 2);
      const before = prev ? (prev.body ?? `(package ${prev.artifact_hash})`) : '';
      const signed = authorKey ? `author signature: verified (key ${String((authorKey as { x: string }).x).slice(0, 12)}…)` : 'author signature: NONE (unsigned; dev only)';
      const diff = [signed, `requires: ${JSON.stringify(requires)}${prev ? ` (was ${JSON.stringify(prev.requires)})` : ''}`, lineDiff(before, shown), e.kind === 'package' ? `\nhandlers:\n${e.bundle!.handlers}` : ''].join('\n');
      const r = await c.query<{ id: string }>('insert into neos.registry_reviews (key, version, diff, fingerprint) values ($1,$2,$3,$4) returning id', [e.key, e.version, diff, ch]);
      return { review_id: r.rows[0]!.id, content_hash: ch, artifact_hash: artifactHash };
    });
  }

  /** An operator's yes on the reviewed diff → co-sign and publish. A no rejects the version. */
  async review(user: { id: string; role: string }, reviewId: string, a: { decision: 'yes' | 'no'; fingerprint_seen: string }) {
    if (user.role !== 'operator') throw new PlatformError(403, 'denied', 'registry reviews are for platform operators');
    return tx(this.p.db, async (c) => {
      const r = (await c.query('select * from neos.registry_reviews where id = $1 for update', [reviewId])).rows[0];
      if (!r) throw new PlatformError(404, 'not_found', 'no such review');
      if (r.status !== 'PENDING') throw new PlatformError(409, 'not_open', `review is ${r.status}`);
      if (a.fingerprint_seen !== r.fingerprint) throw new PlatformError(409, 'fingerprint_mismatch', 'the answer was given against a different version');
      // Four eyes: whoever submitted a version cannot also be the one who co-signs it.
      const by = (await c.query<{ published_by: string }>('select published_by from neos.registry_entries where key = $1 and version = $2', [r.key, r.version])).rows[0]?.published_by;
      if (by === `user:${user.id}`) throw new PlatformError(403, 'four_eyes', 'the person who submitted this version cannot also review it');
      await c.query('update neos.registry_reviews set status = $2, decided_by = $3, fingerprint_seen = $4, decided_at = now() where id = $1', [
        reviewId,
        a.decision === 'yes' ? 'APPROVED' : 'REJECTED',
        user.id,
        a.fingerprint_seen,
      ]);
      if (a.decision === 'no') {
        await c.query(`update neos.registry_entries set status = 'rejected' where key = $1 and version = $2`, [r.key, r.version]);
        return { status: 'rejected' };
      }
      const sig = await this.sign(r.key, r.version, r.fingerprint);
      await c.query(`update neos.registry_entries set status = 'published', platform_sig = $3, published_at = now() where key = $1 and version = $2`, [r.key, r.version, sig]);
      await c.query(`insert into neos.audit (actor, action, outcome, detail) values ($1, 'registry.published', 'ok', $2)`, [
        `user:${user.id}`,
        JSON.stringify({ key: r.key, version: r.version, content_hash: r.fingerprint }),
      ]);
      return { status: 'published' };
    });
  }

  /**
   * A company admin pins an entry for a host app. Skills: the ACL rows their
   * requirements need are granted in the same transaction (minutes, no deploy).
   * Packages: activate if the host already carries this version's tables,
   * otherwise wait for the migration runner.
   */
  async install(user: { id: string; company_id: string; role: string }, req: { host_app: string; entry_key: string; version?: string; grant?: string[] }) {
    if (user.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    return tx(this.p.db, async (c) => {
      const inst = await c.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [user.company_id, req.host_app]);
      if (!inst.rowCount) throw new PlatformError(403, 'not_installed', `${req.host_app} is not installed`);
      const e = (
        await c.query(
          `select * from neos.registry_entries where key = $1 and status = 'published' ${req.version ? 'and version = $2' : ''} order by published_at desc limit 1`,
          req.version ? [req.entry_key, req.version] : [req.entry_key],
        )
      ).rows[0];
      if (!e) throw new PlatformError(404, 'not_found', `no published ${req.entry_key}${req.version ? `@${req.version}` : ''}`);
      const cur = (await c.query<{ pinned_version: string; status: string }>('select pinned_version, status from neos.registry_installs where company_id = $1 and host_app = $2 and entry_key = $3 for update', [user.company_id, req.host_app, e.key])).rows[0];
      if (cur && cur.status !== 'disabled' && cur.pinned_version !== e.version) {
        // An update that needs more than the pinned version did moves only once an admin grants the new borrowing.
        const missing = await this.ungranted(c, user.company_id, req.host_app, e.requires, e.offers);
        const granted = new Set(req.grant ?? []);
        const still = missing.filter((k) => !granted.has(k));
        if (still.length) throw new PlatformError(409, 'needs_grant', `${e.key}@${e.version} also requires ${still.join(', ')}; grant it (install with grant: [...]) before the pin moves`);
      }
      await this.grantRequires(c, user, req.host_app, e.requires, e.offers);
      let status = 'active';
      if (e.kind === 'package') {
        const m = await c.query('select 1 from neos.package_migrations where host_app = $1 and entry_key = $2 and version = $3', [req.host_app, e.key, e.version]);
        if (!m.rowCount) status = 'pending_migration';
      }
      await c.query(
        `insert into neos.registry_installs (company_id, host_app, entry_key, pinned_version, status, granted_by) values ($1,$2,$3,$4,$5,$6)
         on conflict (company_id, host_app, entry_key) do update set pinned_version = excluded.pinned_version, status = excluded.status, granted_by = excluded.granted_by, installed_at = now(),
           previous_version = case when neos.registry_installs.status = 'active' and neos.registry_installs.pinned_version <> excluded.pinned_version then neos.registry_installs.pinned_version else neos.registry_installs.previous_version end,
           last_error = null`,
        [user.company_id, req.host_app, e.key, e.version, status, user.id],
      );
      await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1,$2,$3,'registry.installed',$4,$5)`, [
        user.company_id,
        `user:${user.id}`,
        req.host_app,
        status,
        JSON.stringify({ entry: e.key, version: e.version }),
      ]);
      return { entry_key: e.key, version: e.version, status };
    }).then(async (res) => {
      await this.p.notifyApp(req.host_app, user.company_id);
      return res;
    });
  }

  /** Uninstall (plan: "disables the package and keeps its tables; a drop is a separate, audited platform action"). */
  async uninstall(user: { id: string; company_id: string; role: string }, req: { host_app: string; entry_key: string }) {
    if (user.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await this.p.db.query(
      `update neos.registry_installs set status = 'disabled' where company_id = $1 and host_app = $2 and entry_key = $3 and status <> 'disabled' returning pinned_version`,
      [user.company_id, req.host_app, req.entry_key],
    );
    if (!r.rowCount) throw new PlatformError(404, 'not_found', `${req.entry_key} is not installed in ${req.host_app}`);
    await this.p.gateway.audit({ company_id: user.company_id, actor: `user:${user.id}`, app_key: req.host_app, action: 'registry.uninstalled', outcome: 'disabled', detail: { entry: req.entry_key, version: r.rows[0].pinned_version, tables: 'kept' } });
    await this.p.notifyApp(req.host_app, user.company_id);
    return { entry_key: req.entry_key, status: 'disabled' };
  }

  /** Requirements owned by other apps with no ACL row for this host yet. */
  private async ungranted(c: PoolClient, companyId: string, host: string, requires: string[], offers: { key: string }[]): Promise<string[]> {
    const own = new Set((offers ?? []).map((o) => o.key));
    const apps = (await c.query<{ key: string; manifest: { abilities: { key: string }[] } }>("select key, manifest from neos.apps where status = 'active'")).rows;
    const out: string[] = [];
    for (const key of requires ?? []) {
      if (own.has(key)) continue;
      const owner = apps.find((a) => a.manifest.abilities.some((x) => x.key === key));
      if (!owner || owner.key === host) continue;
      const acl = await c.query('select 1 from neos.acl where caller_app = $1 and target_app = $2 and ability_key = $3 and company_id = $4', [host, owner.key, key, companyId]);
      if (!acl.rowCount) out.push(key);
    }
    return out;
  }

  /** Requirements owned by other apps become ACL rows (borrowed abilities); the host's own need nothing. */
  private async grantRequires(c: PoolClient, user: { id: string; company_id: string }, host: string, requires: string[], offers: { key: string }[]) {
    const own = new Set((offers ?? []).map((o) => o.key));
    const apps = (await c.query<{ key: string; manifest: { abilities: { key: string }[] } }>("select key, manifest from neos.apps where status = 'active'")).rows;
    for (const key of requires) {
      if (own.has(key)) continue;
      const owner = apps.find((a) => a.manifest.abilities.some((x) => x.key === key));
      if (!owner) throw new PlatformError(422, 'unmet_requirement', `nothing offers ${key}`);
      if (owner.key === host) continue;
      await c.query(
        `insert into neos.acl (caller_app, target_app, ability_key, company_id, granted_by) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [host, owner.key, key, user.company_id, user.id],
      );
    }
  }

  /** What a host loads for a company: pinned, published (or deprecated) entries with their signatures. */
  async forHost(host: string, companyId: string) {
    const r = await this.p.db.query(
      `select e.key, e.version, e.kind, e.owner_app, e.requires, e.offers, e.body, e.artifact_hash, e.content_hash, e.platform_sig, i.status as install_status
         from neos.registry_installs i join neos.registry_entries e on e.key = i.entry_key and e.version = i.pinned_version
        where i.company_id = $1 and i.host_app = $2 and i.status = 'active' and e.status in ('published', 'deprecated')`,
      [companyId, host],
    );
    return r.rows;
  }

  async artifact(hash: string): Promise<Buffer | null> {
    const r = await this.p.db.query<{ bytes: Buffer }>('select bytes from neos.registry_artifacts where hash = $1', [hash]);
    return r.rows[0]?.bytes ?? null;
  }

  /**
   * Drop a package's tables from a host (plan: "a drop is a separate, audited platform action").
   * Operator only; refused while any company still has the package installed (active or pending).
   * Runs with the admin connection (the migration runner's), never from a request path.
   */
  async dropPackageTables(adminUrl: string, operator: { id: string; role: string }, host: string, key: string): Promise<{ dropped: string[] }> {
    if (operator.role !== 'operator') throw new PlatformError(403, 'denied', 'dropping package tables is for platform operators');
    assertIdent(host);
    const live = (await this.p.db.query<{ n: number }>(`select count(*)::int as n from neos.registry_installs where host_app = $1 and entry_key = $2 and status in ('active', 'pending_migration')`, [host, key])).rows[0]!.n;
    if (live > 0) throw new PlatformError(409, 'still_installed', `${live} compan${live === 1 ? 'y' : 'ies'} still use ${key} in ${host}; uninstall it everywhere first`);
    const versions = (await this.p.db.query<{ version: string; artifact_hash: string }>(
      `select m.version, e.artifact_hash from neos.package_migrations m join neos.registry_entries e on e.key = m.entry_key and e.version = m.version where m.host_app = $1 and m.entry_key = $2`,
      [host, key],
    )).rows;
    const prefix = `nep_${key.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_')}_`;
    const tables = new Set<string>();
    for (const v of versions) {
      const bytes = await this.artifact(v.artifact_hash);
      for (const t of bytes ? ((JSON.parse(bytes.toString('utf8')) as PackageBundle).manifest.tables ?? []) : []) if (t.startsWith(prefix) && /^[a-z_][a-z0-9_]*$/.test(t)) tables.add(t);
    }
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const dropped: string[] = [];
    try {
      await admin.query('select pg_advisory_lock(hashtext($1))', [`migrate:${host}`]);
      await admin.query('begin');
      for (const t of tables) {
        const r = await admin.query('select 1 from pg_tables where schemaname = $1 and tablename = $2', [host, t]);
        if (!r.rowCount) continue;
        await admin.query(`drop table ${host}.${t} cascade`);
        dropped.push(t);
      }
      await admin.query(`delete from ${host}.schema_migrations where name like $1`, [`${key}@%`]);
      await admin.query('commit');
    } catch (e) {
      await admin.query('rollback').catch(() => {});
      throw e;
    } finally {
      await admin.query('select pg_advisory_unlock(hashtext($1))', [`migrate:${host}`]).catch(() => {});
      await admin.end();
    }
    await this.p.db.query('delete from neos.package_migrations where host_app = $1 and entry_key = $2', [host, key]);
    await this.p.gateway.audit({ company_id: null, actor: `user:${operator.id}`, app_key: host, action: 'registry.package_tables_dropped', outcome: String(dropped.length), detail: { entry: key, tables: dropped } });
    return { dropped };
  }

  async deprecate(user: { role: string }, key: string, version: string) {
    if (user.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    await this.p.db.query(`update neos.registry_entries set status = 'deprecated', deprecated_at = now() where key = $1 and version = $2 and status = 'published'`, [key, version]);
  }

  /** The owner must keep serving a version while anything pins it; retirement waits 30 days after deprecation. */
  async retire(user: { role: string }, key: string, version: string) {
    if (user.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const e = (await this.p.db.query('select status, deprecated_at from neos.registry_entries where key = $1 and version = $2', [key, version])).rows[0];
    if (!e) throw new PlatformError(404, 'not_found', 'no such entry');
    const pins = (await this.p.db.query<{ n: number }>("select count(*)::int as n from neos.registry_installs where entry_key = $1 and pinned_version = $2 and status <> 'disabled'", [key, version])).rows[0]!.n;
    const aged = e.deprecated_at && Date.now() - new Date(e.deprecated_at).getTime() > 30 * 86_400_000;
    if (pins > 0 && !aged) throw new PlatformError(409, 'pinned', `${pins} install(s) still pin ${key}@${version}; deprecate and wait 30 days, or re-pin them`);
    await this.p.db.query(`update neos.registry_entries set status = 'retired' where key = $1 and version = $2`, [key, version]);
  }
}

/** Offline verification of a registry co-signature (used by hosts). */
export async function verifyRegistrySig(jwks: { keys: any[] }, sig: string, expect: { key: string; version: string; content_hash: string }): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(sig, createLocalJWKSet(jwks), { issuer: 'neos-registry', algorithms: ['EdDSA'] });
    return payload.key === expect.key && payload.version === expect.version && payload.content_hash === expect.content_hash;
  } catch {
    return false;
  }
}
