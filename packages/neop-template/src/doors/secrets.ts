// Door credentials (v3 §12): the secret store, per (app, company), read by the
// backend at the moment of a call and then forgotten. Ops provisions it; the
// assistant never sees it (the agent container has no mount and no route to it).
//
// File layout (the default store; one JSON object per file, 0600):
//   <root>/<company_id>/<app>/<door>.json   this app's own credential for the door
//   <root>/<company_id>/<door>.json         company-wide: any app that declares the door
// The app's own file wins; another app's file and another company's directory are
// never read (the paths are built from this backend's app key and the job's
// company, and every segment is checked). Root: NEOP_DOOR_SECRETS_DIR, default
// /run/secrets/doors (mounted read-only into the backend only).
//
// Same binding as the platform vault's 015 (company_id, app_key, door) with
// app_key '*' for company-wide, so scripts/v3/export-door-secrets.ts is a 1:1 move.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DoorError } from './errors.ts';

export type Secret = Record<string, unknown>;

export interface SecretStore {
  /** The credential for this door at this company, read now (no cache beyond the call); null when none is provisioned. */
  get(company: string, door: string): Promise<Secret | null>;
}

export const DEFAULT_DOOR_SECRETS_DIR = '/run/secrets/doors';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A path segment that cannot climb out of the store (no '/', no '..', no leading dot). */
export function safeSegment(what: string, v: string): string {
  if (!SEGMENT.test(v) || v.includes('..')) throw new DoorError(`${what} ${JSON.stringify(v).slice(0, 60)} is not a valid secret-store name`, { definite: true, code: 'bad_name' });
  return v;
}

/** Where the store looks, in order: the app's own file, then the company-wide one. */
export function doorSecretPaths(root: string, company: string, app: string, door: string): { own: string; company: string } {
  const co = safeSegment('company', company);
  const d = safeSegment('door', door);
  return { own: path.join(root, co, safeSegment('app', app), `${d}.json`), company: path.join(root, co, `${d}.json`) };
}

export interface FileSecretStoreOptions {
  /** Default: NEOP_DOOR_SECRETS_DIR, else /run/secrets/doors. */
  root?: string;
  /** This backend's app key: its own files are `<company>/<app>/<door>.json`. */
  app: string;
  /** Called (once per file) when a credential file is readable by group or others. Never given the contents. */
  warn?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class FileSecretStore implements SecretStore {
  readonly root: string;
  readonly app: string;
  private readonly warn: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly warned = new Set<string>();

  constructor(o: FileSecretStoreOptions) {
    this.root = path.resolve(o.root ?? process.env.NEOP_DOOR_SECRETS_DIR ?? DEFAULT_DOOR_SECRETS_DIR);
    this.app = safeSegment('app', o.app);
    this.warn = o.warn ?? ((m, e) => console.warn(m, e ?? ''));
  }

  async get(company: string, door: string): Promise<Secret | null> {
    const p = doorSecretPaths(this.root, company, this.app, door);
    return (await this.read(p.own, door)) ?? (await this.read(p.company, door));
  }

  private async read(file: string, door: string): Promise<Secret | null> {
    let st;
    try {
      st = await stat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw new DoorError(`${door}: the secret store could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, { definite: true, code: 'secret_store' });
    }
    if (!st.isFile()) throw new DoorError(`${door}: the credential in the secret store is not a file`, { definite: true, code: 'secret_store' });
    // Anyone could have planted a world-writable credential: refuse it. Readable by others: say so, once.
    if (st.mode & 0o002) throw new DoorError(`${door}: the credential file is world-writable; refused (chmod 600 it)`, { definite: true, code: 'secret_store' });
    if (st.mode & 0o077 && !this.warned.has(file)) {
      this.warned.add(file);
      this.warn('door credential file is readable by group or others; it should be 0600', { door, file: path.relative(this.root, file), mode: (st.mode & 0o777).toString(8) });
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // removed between stat and read
      throw new DoorError(`${door}: the secret store could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, { definite: true, code: 'secret_store' });
    }
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      // Never echo the file: it is a credential.
      throw new DoorError(`${door}: the credential in the secret store is not valid JSON`, { definite: true, code: 'secret_store' });
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DoorError(`${door}: the credential in the secret store is not a JSON object`, { definite: true, code: 'secret_store' });
    return v as Secret;
  }
}

/** For tests: the same (app, company) binding, in memory. `reads` counts every lookup (to prove "never read"). */
export class MemorySecretStore implements SecretStore {
  readonly app: string;
  private readonly map = new Map<string, Secret>();
  readonly reads: { company: string; door: string }[] = [];
  constructor(app: string) {
    this.app = app;
  }
  /** `app` '*' (default) is the company-wide credential. */
  set(company: string, door: string, secret: Secret, app = '*'): void {
    this.map.set(`${company}\u0000${app}\u0000${door}`, structuredClone(secret));
  }
  delete(company: string, door: string, app = '*'): void {
    this.map.delete(`${company}\u0000${app}\u0000${door}`);
  }
  async get(company: string, door: string): Promise<Secret | null> {
    this.reads.push({ company, door });
    const v = this.map.get(`${company}\u0000${this.app}\u0000${door}`) ?? this.map.get(`${company}\u0000*\u0000${door}`);
    return v ? structuredClone(v) : null;
  }
}
