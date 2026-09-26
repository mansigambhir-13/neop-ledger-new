// THE REGISTRY (Phase 5). Four ways to share, one decision rule (plan §Registry).
// This module holds the skill and package entries: publish → a person reviews
// the diff → platform co-signs → hosts pin a version → hosts verify offline.

import { registryContentHash, sha256Tagged, type ManifestAbility } from '@neop/contracts';
import { tx, type PoolClient } from '@neop/pgkit';
import { jwtVerify, createLocalJWKSet, SignJWT } from 'jose';
import type { KeyRing } from './keys.ts';
import { PlatformError, type Platform } from './platform.ts';

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
  async submit(publishedBy: string, e: { kind: 'skill' | 'package'; key: string; version: string; owner_app?: string | null; body?: string; requires?: string[]; bundle?: PackageBundle }) {
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
    return tx(this.p.db, async (c) => {
      const exists = await c.query('select 1 from neos.registry_entries where key = $1 and version = $2', [e.key, e.version]);
      if (exists.rowCount) throw new PlatformError(409, 'version_exists', `${e.key}@${e.version} exists; versions are immutable`);
      await c.query(
        `insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, offers, body, artifact_hash, content_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [e.key, e.version, e.kind, e.owner_app ?? null, publishedBy, JSON.stringify(requires), JSON.stringify(offers), body, artifactHash, ch],
      );
      const prev = (
        await c.query<{ body: string | null; artifact_hash: string | null; requires: string[] }>(
          `select body, artifact_hash, requires from neos.registry_entries where key = $1 and status in ('published', 'deprecated') order by published_at desc limit 1`,
          [e.key],
        )
      ).rows[0];
      const shown = e.kind === 'skill' ? body! : JSON.stringify({ ...e.bundle!.manifest, handlers_sha256: sha256Bytes(e.bundle!.handlers) }, null, 2);
      const before = prev ? (prev.body ?? `(package ${prev.artifact_hash})`) : '';
      const diff = [`requires: ${JSON.stringify(requires)}${prev ? ` (was ${JSON.stringify(prev.requires)})` : ''}`, lineDiff(before, shown), e.kind === 'package' ? `\nhandlers:\n${e.bundle!.handlers}` : ''].join('\n');
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
  async install(user: { id: string; company_id: string; role: string }, req: { host_app: string; entry_key: string; version?: string }) {
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
      await this.grantRequires(c, user, req.host_app, e.requires, e.offers);
      let status = 'active';
      if (e.kind === 'package') {
        const m = await c.query('select 1 from neos.package_migrations where host_app = $1 and entry_key = $2 and version = $3', [req.host_app, e.key, e.version]);
        if (!m.rowCount) status = 'pending_migration';
      }
      await c.query(
        `insert into neos.registry_installs (company_id, host_app, entry_key, pinned_version, status, granted_by) values ($1,$2,$3,$4,$5,$6)
         on conflict (company_id, host_app, entry_key) do update set pinned_version = excluded.pinned_version, status = excluded.status, granted_by = excluded.granted_by, installed_at = now()`,
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
    });
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
