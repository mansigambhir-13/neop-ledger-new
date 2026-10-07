import {sqlIdent} from '@neop/pgkit';
// The package host (v3 §10, S7). What runs is what the build installed: packages.lock.json names each package
// (unpacked by `neos install` into src/packages/nep-<name>/, read-only) and each pinned skill-only registry entry.
// Before a package is offered — at every spawn and again before every call — its files are re-verified against the
// lock and the registry's co-signature; a hand-edited package is skipped, with the reason in the job's book. A
// pinned skill's text is read from neos_registry.skills at spawn (the app role's SELECT) and must still be the
// exact version and content the lock pinned. Nothing is fetched from the platform at run time, and no code is
// ever run from a row: a package's handlers run in the sandbox, from the verified bundle on disk, with a narrow
// ctx (its own tables, the book, its granted doors, the host reads it requires).

import path from 'node:path';
import { canonicalize, sha256, type ManifestAbility } from '@neop/contracts';
import { createPool, roleUrl, withCompany, type Pool } from '@neop/pgkit';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { Core } from '../core.ts';
import { DoorError } from '../doors/errors.ts';
import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '../types.ts';
import { LOCK_FILE, readLockSync, skillContentHash, verifyInstalledPackage, verifyLockSignature, type LockedPackage, type LockedSkill, type PackagesLock } from './lock.ts';
import { packageRole } from './migrate.ts';
import { Sandbox, SandboxError } from './sandbox.ts';
import type { PackageBundle } from './types.ts';

const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;
const IDENT = /^[a-z_][a-z0-9_]*$/;
/** How long a pinned skill's registry row is trusted before it is read again (a board NOTIFY drops it sooner). */
const SKILL_TTL_MS = 5_000;

export interface LoadedPackage {
  key: string;
  version: string;
  bundle: PackageBundle;
  entry: LockedPackage;
  handlers: Record<string, ReadAbility | WriteAbility>;
}

export interface ResolvedAbility {
  meta: ManifestAbility;
  handler: ReadAbility | WriteAbility;
  checkInput(v: unknown): string | null;
  checkOutput(v: unknown): string | null;
  fromPackage: string | null;
}

export interface InstalledForCompany {
  abilities: ResolvedAbility[];
  skills: { key: string; requires: string[]; body: string; from: string }[];
  /** What the lock names but is not offered, and why (a failed verification, a changed registry row). */
  skipped: { key: string; version: string; reason: string }[];
}

export class PackageHost {
  readonly core: Core;
  /** The app's folder (packages.lock.json and src/packages/), or null when it installs nothing. */
  readonly root: string | null;
  readonly lock: PackagesLock;
  private loaded = new Map<string, LoadedPackage>(); // key@version (verified bundle, parsed once)
  private sandboxes = new Map<string, Sandbox>();
  private pools = new Map<string, Pool>();
  private skillRows: { at: number; rows: Map<string, any> } | null = null;
  private ajv = new Ajv({ allErrors: true, strict: false });
  private compiled = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();

  constructor(core: Core) {
    this.core = core;
    this.root = core.app.packages?.root ?? null;
    // Loaded at boot: the lock is part of the build (a new pin is a new build).
    this.lock = this.root ? readLockSync(path.join(this.root, LOCK_FILE)) : { lock_version: 1, packages: [], skills: [] };
    addFormats(this.ajv);
  }

  /** Drop what was read from the registry (a board change may turn a skill on or off; the lock never changes at run time). */
  invalidate(_companyId?: string): void {
    this.skillRows = null;
  }

  /** What the pinned entries require from outside the packages themselves (the host's reads, borrowed abilities). */
  requires(): string[] {
    const pins = this.core.manifest.packages ?? [];
    const own = new Set(pins.flatMap((p) => (p.abilities ?? []).map((a) => a.key)));
    const all = [...this.lock.skills.flatMap((s) => s.requires), ...pins.flatMap((p) => p.requires ?? [])];
    return [...new Set(all)].filter((k) => !own.has(k));
  }

  /** Verify a locked package on disk (every time) and return it parsed; a failure stops its sandboxes. */
  async load(entry: LockedPackage): Promise<LoadedPackage> {
    const id = `${entry.key}@${entry.version}`;
    const v = this.root ? await verifyInstalledPackage(this.root, entry, this.core.cfg.registryJwks ?? null) : { ok: false as const, reason: 'no packages folder' };
    if (!v.ok) {
      this.loaded.delete(id);
      for (const [k, sb] of this.sandboxes) if (k.startsWith(`${id}:`)) (sb.stop(), this.sandboxes.delete(k));
      throw new Error(`package ${id} failed verification: ${v.reason}`);
    }
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const pkg: LoadedPackage = { key: entry.key, version: entry.version, bundle: v.bundle, entry, handlers: {} };
    for (const a of v.bundle.manifest.abilities) pkg.handlers[a.key] = this.adapter(pkg, a);
    this.loaded.set(id, pkg);
    return pkg;
  }

  /** The pinned skills' rows from neos_registry.skills (read-only to this app's role), cached briefly. */
  private async registrySkills(): Promise<Map<string, any>> {
    if (!this.lock.skills.length) return new Map();
    if (this.skillRows && Date.now() - this.skillRows.at < SKILL_TTL_MS) return this.skillRows.rows;
    const r = await this.core.appPool.query(
      `select key, version, owner_app, requires, offers, body, content_hash, platform_sig, status
         from neos_registry.skills where key = any($1::text[])`,
      [this.lock.skills.map((s) => s.key)],
    );
    const rows = new Map<string, any>();
    for (const row of r.rows) rows.set(`${row.key}@${row.version}`, row);
    this.skillRows = { at: Date.now(), rows };
    return rows;
  }

  /** A pinned skill as the registry holds it now, or why it does not load. */
  private async pinnedSkill(pin: LockedSkill, rows: Map<string, any>): Promise<{ body: string } | { reason: string }> {
    const row = rows.get(`${pin.key}@${pin.version}`);
    if (!row) return { reason: `${pin.key}@${pin.version} is not published in the registry` };
    const requires = Array.isArray(row.requires) ? row.requires : [];
    const ch = skillContentHash({ key: row.key, version: row.version, body: row.body, requires, offers: row.offers ?? [] });
    if (ch !== row.content_hash || ch !== pin.content_hash) return { reason: `${pin.key}@${pin.version} in the registry is not the text that was pinned (its content hash differs)` };
    const bad = await verifyLockSignature({ ...pin.signature, platform_sig: row.platform_sig }, { key: pin.key, version: pin.version, content_hash: pin.content_hash }, this.core.cfg.registryJwks ?? null);
    if (bad) return { reason: `${pin.key}@${pin.version}: ${bad}` };
    return { body: String(row.body) };
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
      return `${sqlIdent(this.core.key)}.${t}`;
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
          const door = this.core.doors(base.company_id, pkg.bundle.manifest.doors)[params.door];
          if (!door) throw new Error(`the host has no ${params.door} door`);
          return op === 'doors.send' ? door.send(params.record, base.idempotency_key) : door.lookup(base.idempotency_key, params.query ?? undefined);
        }
        case 'reads.run':
          return this.hostRead(pkg, base, String(params.key), params.args ?? {});
        default:
          throw new Error(`unknown ctx op ${op}`);
      }
    };
  }

  /**
   * A host read on the package's behalf (ctx.reads). Only reads the manifest
   * `requires`, only the host's own reads, never while the company has switched
   * them off; input and output are checked like the gate checks them, and the
   * read is a step in the job's book with its basis, so a report can cite it.
   */
  private async hostRead(pkg: LoadedPackage, base: { company_id: string; job_id: string | null }, key: string, args: unknown): Promise<unknown> {
    if (!(pkg.bundle.manifest.requires ?? []).includes(key)) throw new Error(`${pkg.key} does not require ${key}; a package may only call the host reads its manifest requires`);
    const own = this.core.ability(key);
    if (!own || own.kind !== 'read') throw new Error(`${key} is not a read of ${this.core.key}`);
    const board = await this.core.board.get(base.company_id);
    if (board.setting(own) === 'off') throw new Error(`${key} is switched off for this company`);
    const resolved = await this.core.resolve(base.company_id, key);
    if (!resolved || resolved.handler.kind !== 'read') throw new Error(`${key} is not available`);
    const bad = resolved.checkInput(args);
    if (bad) throw new Error(`${key}: ${bad}`);
    const handler = resolved.handler;
    const output = await this.core.company(base.company_id, (db) =>
      handler.run(args, { company_id: base.company_id, caller: `package:${pkg.key}`, job_id: base.job_id, now: new Date(), db }),
    );
    const badOut = resolved.checkOutput(output);
    if (badOut) throw new Error(`${key} result failed its schema: ${badOut}`);
    if (base.job_id) {
      await this.core.company(base.company_id, (c) =>
        this.core.book.addStep(c, {
          company_id: base.company_id,
          job_id: base.job_id!,
          kind: 'ability',
          summary: `[${pkg.key}] Read ${own.title}`,
          ability_key: key,
          input_hash: sha256(canonicalize(args)),
          output_ref: { basis: (output as any)?.sources?.basis ?? null, entries: (output as any)?.sources?.entries ?? null, generatedAt: (output as any)?.generatedAt ?? null },
        }),
      );
    }
    return output;
  }

  private adapter(pkg: LoadedPackage, a: ManifestAbility): ReadAbility | WriteAbility {
    const call = async (method: 'run' | 'execute' | 'readBack' | 'normalize' | 'validate', args: unknown, base: { company_id: string; job_id: string | null; idempotency_key?: string }) => {
      await this.load(pkg.entry); // re-verify on disk before every call: a file edited since spawn does not run
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
      // Runs at the gate before anything is proposed (no doors: there is no idempotency key yet).
      normalize: (args, ctx: ReadCtx) => call('normalize', args, { company_id: ctx.company_id, job_id: ctx.job_id }),
      validate: async (args, ctx: ReadCtx) => ((await call('validate', args, { company_id: ctx.company_id, job_id: ctx.job_id })) as string | null) ?? null,
      execute: async (args, ctx: ExecCtx) => (await call('execute', args, { company_id: ctx.company_id, job_id: ctx.job_id, idempotency_key: ctx.idempotencyKey })) as { external_ref: string | null },
      readBack: async (args, ctx: ExecCtx, ref) =>
        (await call('readBack', { args, external_ref: ref }, { company_id: ctx.company_id, job_id: ctx.job_id, idempotency_key: ctx.idempotencyKey })) as { found: boolean; data: unknown },
    };
  }

  /**
   * What this app's build installed, verified now: each locked package's abilities and skills (skipped, with the
   * reason, when its files or signature do not verify) and each pinned registry skill whose row is still the exact
   * pinned text. Whether a line or skill is on for the company is the board's (the gate and the spawn decide).
   */
  async forCompany(_companyId: string): Promise<InstalledForCompany> {
    const abilities: ResolvedAbility[] = [];
    const skills: InstalledForCompany['skills'] = [];
    const skipped: InstalledForCompany['skipped'] = [];
    for (const e of this.lock.packages) {
      let pkg: LoadedPackage;
      try {
        pkg = await this.load(e);
      } catch (err) {
        const reason = (err as Error).message;
        this.core.log('package not loaded', { key: e.key, version: e.version, reason });
        skipped.push({ key: e.key, version: e.version, reason });
        continue;
      }
      for (const a of pkg.bundle.manifest.abilities) abilities.push(this.resolved(pkg, a));
      for (const s of pkg.bundle.manifest.skills) skills.push({ key: `${pkg.key}/${s.key}`, requires: s.requires, body: s.body, from: `${pkg.key}@${pkg.version}` });
    }
    if (this.lock.skills.length) {
      let rows: Map<string, any>;
      try {
        rows = await this.registrySkills();
      } catch (err) {
        rows = new Map();
        this.core.log('registry skills unreadable; pinned skills skipped', { err: String(err) });
      }
      for (const pin of this.lock.skills) {
        const got = await this.pinnedSkill(pin, rows);
        if ('reason' in got) {
          this.core.log('pinned skill not loaded', { key: pin.key, version: pin.version, reason: got.reason });
          skipped.push({ key: pin.key, version: pin.version, reason: got.reason });
          continue;
        }
        skills.push({ key: pin.key, requires: pin.requires, body: got.body, from: `${pin.owner_app ?? 'registry'} v${pin.version} (reviewed by NEOS)` });
      }
    }
    return { abilities, skills, skipped };
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
