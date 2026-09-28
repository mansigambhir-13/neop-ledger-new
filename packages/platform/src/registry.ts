// THE REGISTRY (Phase 5). Four ways to share, one decision rule (plan §Registry).
// This module holds the skill and package entries: publish → a person reviews
// the diff → platform co-signs → hosts pin a version → hosts verify offline.

import { createPublicKey, verify as verifySig } from 'node:crypto';
import { packageOffers, packageRequires, registryContentHash, sha256Tagged, type Manifest, type ManifestAbility } from '@neop/contracts';
import { tx, type PoolClient } from '@neop/pgkit';
import { jwtVerify, createLocalJWKSet, SignJWT } from 'jose';
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
  /** From nep.json (v3 §10): who wrote it; `public_key` (Ed25519 JWK) checks the signature. */
  author?: { name?: string; email?: string; public_key?: unknown } | string;
  abilities: ManifestAbility[];
  doors: string[];
  tables: string[];
  skills: { key: string; requires: string[]; body: string }[];
  migrations: Record<string, string>;
}

/** The artifact is exactly these bytes: a JSON bundle {manifest, handlers, metrics?, references?}. */
export interface PackageBundle {
  manifest: PackageManifest;
  handlers: string;
  /** v3 §10: the package's metrics.json (what it measures), carried in the signed bytes. */
  metrics?: Record<string, unknown>;
  /** v3 §10: references/<path> → text, carried in the signed bytes (each file's hash is shown to the reviewer). */
  references?: Record<string, string>;
}

/**
 * Packages published before v3 named their tables nep_<name>_* (one underscore). They keep that prefix so nothing
 * breaks; every new package names them nep_<name>__* (two), so a table can never be mistaken for another package's.
 */
export const LEGACY_TABLE_PREFIX_PACKAGES: ReadonlySet<string> = new Set(['nep-gst']);

/** v3 §10: `nep.json` {name, version, author, signature?, …} is an alias of the package manifest. */
export function normalizePackageManifest(raw: unknown): PackageManifest & { signature?: string } {
  const m = (raw ?? {}) as Record<string, any>;
  if (!m.key && typeof m.name === 'string') {
    const key = m.name.startsWith('nep-') ? m.name : `nep-${m.name}`;
    return { ...m, key, name: typeof m.title === 'string' ? m.title : key } as any;
  }
  return m as any;
}

const REF_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\-/]{1,200}$/;

/** What a bundle's optional parts must look like (null when well formed). */
export function bundleExtrasProblem(b: Pick<PackageBundle, 'metrics' | 'references'>): string | null {
  if (b.metrics !== undefined && (b.metrics === null || typeof b.metrics !== 'object' || Array.isArray(b.metrics))) return 'metrics must be the object from metrics.json';
  if (b.references !== undefined) {
    if (b.references === null || typeof b.references !== 'object' || Array.isArray(b.references)) return 'references must map a path under references/ to its text';
    for (const [k, v] of Object.entries(b.references)) {
      if (!REF_PATH.test(k)) return `references: ${k} is not a plain relative path`;
      if (typeof v !== 'string') return `references: ${k} must be text`;
    }
  }
  return null;
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
    let bundle = e.bundle;
    let author = e.author;
    if (e.kind === 'package') {
      if (!bundle) throw new PlatformError(400, 'bad_request', 'a package needs its bundle');
      // nep.json's signature is the author's, over the content hash; it cannot be inside the bytes it signs.
      const { signature, ...m } = normalizePackageManifest(bundle.manifest);
      if (signature !== undefined && !author) {
        const pk = m.author && typeof m.author === 'object' ? m.author.public_key : undefined;
        author = { sig: signature, public_key: pk };
      }
      bundle = { ...bundle, manifest: m };
      const extras = bundleExtrasProblem(bundle);
      if (extras) throw new PlatformError(422, 'bad_manifest', extras);
      const bytes = Buffer.from(JSON.stringify(bundle));
      artifactHash = sha256Bytes(bytes);
      if (m.key !== e.key || m.version !== e.version) throw new PlatformError(422, 'bad_manifest', 'bundle manifest key/version must match');
      const prefix = e.key.replace(/^nep-/, '');
      const tp = `nep_${prefix.replace(/[^a-z0-9]/g, '_')}`;
      const legacy =
        LEGACY_TABLE_PREFIX_PACKAGES.has(e.key) || ((await this.p.db.query("select 1 from neos.registry_entries where key = $1 and kind = 'package' limit 1", [e.key])).rowCount ?? 0) > 0;
      for (const t of m.tables ?? []) {
        const ok = /^[a-z_][a-z0-9_]*$/.test(t) && (t.startsWith(`${tp}__`) || (legacy && t.startsWith(`${tp}_`)));
        if (!ok) throw new PlatformError(422, 'bad_manifest', `package tables must be named ${tp}__*${legacy ? ` (or ${tp}_* as published before)` : ''}: ${t}`);
      }
      for (const a of m.abilities) {
        if (!a.key.startsWith(`${prefix}.`)) throw new PlatformError(422, 'bad_manifest', `package abilities must be named ${prefix}.*`);
        if (a.kind === 'read' && a.floor === 'ask_first') throw new PlatformError(422, 'read_cannot_ask_first', a.key);
      }
      offers = packageOffers(m);
      requires = packageRequires(m);
      const breaks = await this.breaksPinned(e.key, offers as { key: string; kind: string; version: string }[]);
      if (breaks) throw new PlatformError(409, 'breaks_pinned', breaks);
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
    } else if (author?.public_key !== undefined) {
      authorKey = author.public_key;
    } else if (process.env.NEOS_ENV === 'production') {
      throw new PlatformError(403, 'unsigned', 'a package must carry its author key and signature');
    }
    if (authorKey && !verifyAuthorSig(authorKey, ch, author?.sig)) {
      await this.p.gateway.audit({ company_id: null, actor: publishedBy, action: 'registry.publish_refused', outcome: 'bad_author_sig', detail: { key: e.key, version: e.version, content_hash: ch } });
      throw new PlatformError(403, 'bad_author_sig', `the author signature does not verify over ${ch}`);
    }
    return tx(this.p.db, async (c) => {
      const exists = await c.query('select 1 from neos.registry_entries where key = $1 and version = $2', [e.key, e.version]);
      if (exists.rowCount) throw new PlatformError(409, 'version_exists', `${e.key}@${e.version} exists; versions are immutable`);
      await c.query(
        `insert into neos.registry_entries (key, version, kind, owner_app, published_by, requires, offers, body, artifact_hash, content_hash, author_key, author_sig)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [e.key, e.version, e.kind, e.owner_app ?? null, publishedBy, JSON.stringify(requires), JSON.stringify(offers), body, artifactHash, ch, authorKey ? JSON.stringify(authorKey) : null, authorKey ? author!.sig : null],
      );
      const prev = (
        await c.query<{ body: string | null; artifact_hash: string | null; requires: string[] }>(
          `select body, artifact_hash, requires from neos.registry_entries where key = $1 and status in ('published', 'deprecated') order by published_at desc limit 1`,
          [e.key],
        )
      ).rows[0];
      const shown =
        e.kind === 'skill'
          ? body!
          : JSON.stringify(
              {
                ...bundle!.manifest,
                handlers_sha256: sha256Bytes(bundle!.handlers),
                ...(bundle!.metrics ? { metrics_sha256: sha256Bytes(JSON.stringify(bundle!.metrics)) } : {}),
                ...(bundle!.references ? { references_sha256: Object.fromEntries(Object.entries(bundle!.references).map(([k, v]) => [k, sha256Bytes(v)])) } : {}),
              },
              null,
              2,
            );
      const before = prev ? (prev.body ?? `(package ${prev.artifact_hash})`) : '';
      const signed = authorKey ? `author signature: verified (key ${String((authorKey as { x: string }).x).slice(0, 12)}…)` : 'author signature: NONE (unsigned; dev only)';
      const diff = [signed, `requires: ${JSON.stringify(requires)}${prev ? ` (was ${JSON.stringify(prev.requires)})` : ''}`, lineDiff(before, shown), e.kind === 'package' ? `\nhandlers:\n${bundle!.handlers}` : ''].join('\n');
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
   * v3 S7: what every registered app pins, from the manifests `neos install` wrote at build time — packages
   * (`packages`) and skill-only entries (`registry_skills`). There is no per-company install any more: a company
   * switches the lines they add. This is what a publish, a retire and a re-registration must keep working.
   */
  async pins(c: { query: PoolClient['query'] } = this.p.db): Promise<Pin[]> {
    return manifestPins(c);
  }

  /** One published (or deprecated) entry, signed, for `neos install` to verify and pin. */
  async entry(key: string, version: string) {
    const r = await this.p.db.query(
      `select key, version, kind, owner_app, requires, offers, body, artifact_hash, content_hash, platform_sig, status
         from neos.registry_entries where key = $1 and version = $2 and status in ('published', 'deprecated')`,
      [key, version],
    );
    if (!r.rows[0]) throw new PlatformError(404, 'not_found', `no published ${key}@${version}`);
    return r.rows[0];
  }

  async artifact(hash: string): Promise<Buffer | null> {
    const r = await this.p.db.query<{ bytes: Buffer }>('select bytes from neos.registry_artifacts where hash = $1', [hash]);
    return r.rows[0]?.bytes ?? null;
  }

  /** A published (or deprecated) package's artifact, by hash: what `neos install` fetches. */
  async publishedArtifact(hash: string): Promise<Buffer> {
    const ok = await this.p.db.query("select 1 from neos.registry_entries where artifact_hash = $1 and status in ('published', 'deprecated') limit 1", [hash]);
    const bytes = ok.rowCount ? await this.artifact(hash) : null;
    if (!bytes) throw new PlatformError(404, 'not_found', 'no published artifact with that hash');
    return bytes;
  }

  /**
   * v3 §10: an owner may not retire an ability a pinned entry still requires. A new version of a package that
   * drops (or recasts, or moves the major version of) an ability some app's pinned skill or package requires is
   * refused until the version that served it has been deprecated for the 30-day window.
   */
  private async breaksPinned(key: string, offers: { key: string; kind: string; version: string }[]): Promise<string | null> {
    const prev = (
      await this.p.db.query<{ version: string; offers: { key: string; kind: string; version: string }[]; status: string; deprecated_at: Date | null }>(
        `select version, offers, status, deprecated_at from neos.registry_entries
          where key = $1 and kind = 'package' and status in ('published', 'deprecated') order by published_at desc nulls last limit 1`,
        [key],
      )
    ).rows[0];
    if (!prev) return null;
    if (prev.deprecated_at && Date.now() - new Date(prev.deprecated_at).getTime() > RETIRE_AFTER_MS) return null;
    const pins = await this.pins();
    for (const was of Array.isArray(prev.offers) ? prev.offers : []) {
      const needers = pins.filter((p) => p.requires.includes(was.key) && !(p.kind === 'package' && p.key === key));
      if (!needers.length) continue;
      const now = offers.find((o) => o.key === was.key);
      const why = !now ? 'drops it' : now.kind !== was.kind ? `turns it from a ${was.kind} into a ${now.kind}` : major(now.version) !== major(was.version) ? `moves it from ${was.version} to ${now.version}` : null;
      if (why) {
        const n = needers[0]!;
        return `${n.key}@${n.version} (pinned by ${n.app}) requires ${was.key}; this version ${why}. Deprecate ${key}@${prev.version} and wait 30 days, or re-pin ${n.app} first`;
      }
    }
    return null;
  }

  async deprecate(user: { role: string }, key: string, version: string) {
    if (user.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    await this.p.db.query(`update neos.registry_entries set status = 'deprecated', deprecated_at = now() where key = $1 and version = $2 and status = 'published'`, [key, version]);
  }

  /** The owner must keep serving a version while any app's build pins it; retirement waits 30 days after deprecation. */
  async retire(user: { role: string }, key: string, version: string) {
    if (user.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const e = (await this.p.db.query('select status, deprecated_at from neos.registry_entries where key = $1 and version = $2', [key, version])).rows[0];
    if (!e) throw new PlatformError(404, 'not_found', 'no such entry');
    const pins = (await this.pins()).filter((p) => p.key === key && p.version === version);
    const aged = e.deprecated_at && Date.now() - new Date(e.deprecated_at).getTime() > RETIRE_AFTER_MS;
    if (pins.length > 0 && !aged) throw new PlatformError(409, 'pinned', `${pins.map((p) => p.app).join(', ')} still pin${pins.length === 1 ? 's' : ''} ${key}@${version}; deprecate and wait 30 days, or re-pin them`);
    await this.p.db.query(`update neos.registry_entries set status = 'retired' where key = $1 and version = $2`, [key, version]);
  }
}

const RETIRE_AFTER_MS = 30 * 86_400_000;

/** What every registered app's build pinned (v3 S7): its manifest's `packages` and `registry_skills`. */
export async function manifestPins(c: { query: PoolClient['query'] }): Promise<Pin[]> {
  const r = await c.query<{ key: string; manifest: Manifest }>('select key, manifest from neos.apps');
  return r.rows.flatMap((a) => pinsOf(a.key, a.manifest));
}

/** One manifest's pins. */
export function pinsOf(app: string, manifest: Manifest | null | undefined): Pin[] {
  const out: Pin[] = [];
  for (const p of manifest?.packages ?? []) {
    out.push({ app, key: p.key, version: p.version, kind: 'package', requires: [...new Set([...(p.requires ?? []), ...(p.skills ?? []).flatMap((s) => s.requires)])], offers: (p.abilities ?? []).map((x) => x.key) });
  }
  for (const s of manifest?.registry_skills ?? []) out.push({ app, key: s.key, version: s.version, kind: 'skill', requires: s.requires ?? [], offers: [] });
  return out;
}

export interface Pin {
  app: string;
  key: string;
  version: string;
  kind: 'package' | 'skill';
  requires: string[];
  offers: string[];
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

function major(v: string): string {
  return String(v ?? '').split('.')[0] ?? '';
}
