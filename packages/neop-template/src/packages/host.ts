// The package host (Phase 5). For each company it loads what the company pinned
// in the registry — borrowed skills and packages — verifies the platform's
// co-signature offline, unpacks package artifacts by hash into a read-only
// cache, re-verifies them before any sandbox starts, and serves the sandbox's
// narrow ctx (its own tables, the book, granted doors) over RPC.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registryContentHash, sha256Tagged, type ManifestAbility } from '@neop/contracts';
import { createPool, roleUrl, withCompany, type Pool } from '@neop/pgkit';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Core } from '../core.ts';
import { DoorError } from '../doors/errors.ts';
import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '../types.ts';
import { packageRole } from './migrate.ts';
import { Sandbox, SandboxError } from './sandbox.ts';
import type { PackageBundle, RegistryEntryRow } from './types.ts';

const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;
const IDENT = /^[a-z_][a-z0-9_]*$/;

export interface LoadedPackage {
  key: string;
  version: string;
  bundle: PackageBundle;
  dir: string;
  artifactHash: string;
  handlers: Record<string, ReadAbility | WriteAbility>;
}

export interface ResolvedAbility {
  meta: ManifestAbility;
  handler: ReadAbility | WriteAbility;
  checkInput(v: unknown): string | null;
  checkOutput(v: unknown): string | null;
  fromPackage: string | null;
}

export class PackageHost {
  readonly core: Core;
  private readonly cacheDir: string;
  private entries = new Map<string, { at: number; list: RegistryEntryRow[] }>();
  private loaded = new Map<string, LoadedPackage>(); // key@version
  private sandboxes = new Map<string, Sandbox>();
  private pools = new Map<string, Pool>();
  private jwks: { keys: any[] } | null = null;
  private ajv = new Ajv({ allErrors: true, strict: false });
  private compiled = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();

  constructor(core: Core, cacheDir?: string) {
    this.core = core;
    this.cacheDir = cacheDir ?? path.join(process.cwd(), 'var', 'packages', core.key);
    addFormats(this.ajv);
  }

  invalidate(companyId?: string): void {
    if (companyId) this.entries.delete(companyId);
    else this.entries.clear();
  }

  private async registryJwks(): Promise<{ keys: any[] }> {
    if (!this.jwks) {
      const res = await fetch(`${this.core.cfg.platformUrl.replace(/\/$/, '')}/.well-known/registry-jwks.json`, { signal: AbortSignal.timeout(10_000) });
      this.jwks = (await res.json()) as { keys: any[] };
      setTimeout(() => (this.jwks = null), 60_000).unref?.();
    }
    return this.jwks;
  }

  /** Verified entries this company pinned for this app. An unverifiable entry is dropped, never loaded. */
  async entriesFor(companyId: string): Promise<RegistryEntryRow[]> {
    const hit = this.entries.get(companyId);
    if (hit && Date.now() - hit.at < 30_000) return hit.list;
    const r = await this.core.platform.registryEntries(companyId);
    const jwks = await this.registryJwks();
    const ok: RegistryEntryRow[] = [];
    for (const e of r) {
      const expect = registryContentHash({ key: e.key, version: e.version, kind: e.kind, body: e.body, requires: e.requires, offers: e.offers, artifact_hash: e.artifact_hash });
      if (expect !== e.content_hash) {
        this.core.log('registry entry content does not match its hash; ignored', { key: e.key });
        continue;
      }
      try {
        const { payload } = await jwtVerify(e.platform_sig, createLocalJWKSet(jwks), { issuer: 'neos-registry', algorithms: ['EdDSA'] });
        if (payload.key !== e.key || payload.version !== e.version || payload.content_hash !== e.content_hash) throw new Error('signature is for something else');
        ok.push(e);
      } catch (err) {
        this.core.log('registry signature invalid; ignored', { key: e.key, err: String(err) });
      }
    }
    this.entries.set(companyId, { at: Date.now(), list: ok });
    return ok;
  }

  /** Unpack by hash (once), and verify the bytes on disk every time before use. */
  async load(e: RegistryEntryRow): Promise<LoadedPackage> {
    const id = `${e.key}@${e.version}`;
    const dir = path.join(this.cacheDir, id);
    const file = path.join(dir, 'bundle.json');
    let bytes = await readFile(file).catch(() => null);
    if (!bytes) {
      const b64 = await this.core.platform.registryArtifact(e.artifact_hash!);
      bytes = Buffer.from(b64, 'base64');
      if (sha256Tagged(bytes) !== e.artifact_hash) throw new Error(`artifact for ${id} does not match its hash`);
      await mkdir(dir, { recursive: true });
      await writeFile(file, bytes, { mode: 0o444 });
      await chmod(file, 0o444).catch(() => {});
    }
    // Verified at spawn: a hand-edited package does not run.
    if (sha256Tagged(bytes) !== e.artifact_hash) {
      this.loaded.delete(id);
      for (const [k, sb] of this.sandboxes) if (k.startsWith(`${id}:`)) (sb.stop(), this.sandboxes.delete(k));
      throw new Error(`package ${id} failed verification: its files no longer match the signed artifact`);
    }
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const bundle = JSON.parse(bytes.toString('utf8')) as PackageBundle;
    const pkg: LoadedPackage = { key: e.key, version: e.version, bundle, dir, artifactHash: e.artifact_hash!, handlers: {} };
    for (const a of bundle.manifest.abilities) pkg.handlers[a.key] = this.adapter(pkg, a);
    this.loaded.set(id, pkg);
    return pkg;
  }

  /** One sandbox per company and package version: no module state is ever shared across tenants (H5). */
  private sandbox(pkg: LoadedPackage, companyId: string): Sandbox {
    const id = `${pkg.key}@${pkg.version}:${companyId}`;
    let s = this.sandboxes.get(id);
    if (s) {
      this.sandboxes.delete(id); // refresh LRU position
    } else {
      s = new Sandbox({ name: id, handlersSource: pkg.bundle.handlers });
      while (this.sandboxes.size >= 32) {
        const [oldest, sb] = this.sandboxes.entries().next().value as [string, Sandbox];
        sb.stop();
        this.sandboxes.delete(oldest);
      }
    }
    this.sandboxes.set(id, s);
    return s;
  }

  private pool(pkg: LoadedPackage): Pool {
    const role = packageRole(this.core.key, pkg.key);
    let p = this.pools.get(role);
    if (!p) {
      p = createPool(roleUrl(this.core.cfg.appDbUrl, role), 3);
      this.pools.set(role, p);
    }
    return p;
  }

  /** The narrow ctx: only this package's tables, the job's book, the doors it declared. */
  private ctxHandler(pkg: LoadedPackage, base: { company_id: string; job_id: string | null; idempotency_key?: string }) {
    const prefix = `nep_${pkg.key.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_')}_`;
    const table = (t: unknown) => {
      if (typeof t !== 'string' || !t.startsWith(prefix) || !pkg.bundle.manifest.tables.includes(t) || !IDENT.test(t)) throw new Error(`table ${String(t)} is not this package's`);
      return `${this.core.key}.${t}`;
    };
    const cols = (o: Record<string, unknown>) => {
      const ks = Object.keys(o ?? {});
      for (const k of ks) if (!IDENT.test(k) || k === 'company_id') throw new Error(`column ${k} not allowed`);
      return ks;
    };
    return async (op: string, params: any): Promise<unknown> => {
      switch (op) {
        case 'tables.select': {
          const t = table(params.table);
          const ks = cols(params.where);
          const where = ks.map((k, i) => `${k} = $${i + 1}`).join(' and ') || 'true';
          return withCompany(this.pool(pkg), base.company_id, async (c) => (await c.query(`select * from ${t} where ${where} limit ${Math.min(Number(params.limit) || 100, 500)}`, ks.map((k) => params.where[k]))).rows);
        }
        case 'tables.insert': {
          const t = table(params.table);
          const ks = cols(params.row);
          return withCompany(this.pool(pkg), base.company_id, async (c) =>
            (await c.query(`insert into ${t} (company_id, ${ks.join(', ')}) values ($1, ${ks.map((_, i) => `$${i + 2}`).join(', ')}) returning *`, [base.company_id, ...ks.map((k) => params.row[k])])).rows[0],
          );
        }
        case 'tables.update': {
          const t = table(params.table);
          const w = cols(params.where);
          const s = cols(params.set);
          if (!w.length || !s.length) throw new Error('update needs where and set');
          return withCompany(this.pool(pkg), base.company_id, async (c) =>
            (await c.query(`update ${t} set ${s.map((k, i) => `${k} = $${i + 1}`).join(', ')} where ${w.map((k, i) => `${k} = $${s.length + i + 1}`).join(' and ')} returning *`, [...s.map((k) => params.set[k]), ...w.map((k) => params.where[k])])).rows,
          );
        }
        case 'book.step':
          if (!base.job_id) return null;
          return this.core.company(base.company_id, (c) => this.core.book.addStep(c, { company_id: base.company_id, job_id: base.job_id!, kind: 'note', summary: `[${pkg.key}] ${String(params.summary).slice(0, 500)}` }));
        case 'book.fact':
          return this.core.company(base.company_id, (c) => this.core.book.addFact(c, { company_id: base.company_id, job_id: base.job_id, subject: String(params.subject), value: params.value ?? null, source: `${pkg.key}: ${String(params.source ?? 'package')}` }));
        case 'doors.send':
        case 'doors.lookup': {
          if (!pkg.bundle.manifest.doors.includes(params.door)) throw new Error(`door ${params.door} is not granted to ${pkg.key}`);
          if (!base.idempotency_key) throw new Error('doors are only open on the approved path');
          const door = this.core.doors(base.company_id, [params.door])[params.door];
          if (!door) throw new Error(`the host has no ${params.door} door`);
          return op === 'doors.send' ? door.send(params.record, base.idempotency_key) : door.lookup(base.idempotency_key);
        }
        default:
          throw new Error(`unknown ctx op ${op}`);
      }
    };
  }

  private adapter(pkg: LoadedPackage, a: ManifestAbility): ReadAbility | WriteAbility {
    const call = async (method: 'run' | 'execute' | 'readBack', args: unknown, base: { company_id: string; job_id: string | null; idempotency_key?: string }) => {
      await this.load({ key: pkg.key, version: pkg.version, artifact_hash: pkg.artifactHash } as RegistryEntryRow); // re-verify on disk
      try {
        return await this.sandbox(pkg, base.company_id).call(a.key, method, args, base, this.ctxHandler(pkg, base));
      } catch (e) {
        if (e instanceof SandboxError && e.definite) throw new DoorError(e.message, { definite: true });
        throw e;
      }
    };
    if (a.kind === 'read') {
      return { kind: 'read', run: (args, ctx: ReadCtx) => call('run', args, { company_id: ctx.company_id, job_id: ctx.job_id }) };
    }
    return {
      kind: 'write',
      execute: async (args, ctx: ExecCtx) => (await call('execute', args, { company_id: ctx.company_id, job_id: ctx.job_id, idempotency_key: ctx.idempotencyKey })) as { external_ref: string | null },
      readBack: async (args, ctx: ExecCtx, ref) =>
        (await call('readBack', { args, external_ref: ref }, { company_id: ctx.company_id, job_id: ctx.job_id, idempotency_key: ctx.idempotencyKey })) as { found: boolean; data: unknown },
    };
  }

  /** Package abilities and borrowed/package skills for one company. */
  async forCompany(companyId: string): Promise<{ abilities: ResolvedAbility[]; skills: { key: string; requires: string[]; body: string; from: string }[] }> {
    const entries = await this.entriesFor(companyId);
    const abilities: ResolvedAbility[] = [];
    const skills: { key: string; requires: string[]; body: string; from: string }[] = [];
    for (const e of entries) {
      if (e.kind === 'skill') {
        skills.push({ key: e.key, requires: e.requires, body: e.body!, from: `${e.owner_app ?? 'registry'} (reviewed by NEOS)` });
        continue;
      }
      let pkg: LoadedPackage;
      try {
        pkg = await this.load(e);
      } catch (err) {
        this.core.log('package not loaded', { key: e.key, err: String(err) });
        continue;
      }
      for (const a of pkg.bundle.manifest.abilities) abilities.push(this.resolved(pkg, a));
      for (const s of pkg.bundle.manifest.skills) skills.push({ key: `${pkg.key}/${s.key}`, requires: s.requires, body: s.body, from: `${pkg.key}@${pkg.version}` });
    }
    return { abilities, skills };
  }

  private resolved(pkg: LoadedPackage, a: ManifestAbility): ResolvedAbility {
    const k = `${pkg.key}@${pkg.version}:${a.key}`;
    let v = this.compiled.get(k);
    if (!v) {
      v = { input: this.ajv.compile(a.input), output: this.ajv.compile(a.output) };
      this.compiled.set(k, v);
    }
    const vv = v;
    return {
      meta: a,
      handler: pkg.handlers[a.key]!,
      checkInput: (x) => (vv.input(x) ? null : this.ajv.errorsText(vv.input.errors)),
      checkOutput: (x) => (vv.output(x) ? null : this.ajv.errorsText(vv.output.errors)),
      fromPackage: `${pkg.key}@${pkg.version}`,
    };
  }

  async close(): Promise<void> {
    for (const s of this.sandboxes.values()) s.stop();
    await Promise.allSettled([...this.pools.values()].map((p) => p.end()));
  }
}
