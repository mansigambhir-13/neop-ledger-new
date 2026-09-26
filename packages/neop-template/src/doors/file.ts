import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DoorError } from './errors.ts';
import { providerCall, providerError } from './http.ts';
import type { DoorJournal } from './journal.ts';

/**
 * A generic door with the contract every door must meet (S1): an effect sent
 * with a door-level idempotency key, and a lookup by that key for read-back.
 * Providers, chosen by the credential the vault lends per call:
 *   { provider: 'http', base_url, token, send_path, lookup_path }   an HTTP provider (e.g. a GST Suvidha
 *       Provider for GSTR-3B filing): POST send_path with Idempotency-Key → { id };
 *       GET lookup_path ({key} substituted) → the record, 404 when absent
 *   { provider: 'dev-file', dir }                                   records effects to a directory (dev/tests)
 */
export class FileDoor {
  readonly name: string;
  private readonly borrow: () => Promise<Record<string, unknown>>;
  private readonly journal: DoorJournal | null;
  constructor(name: string, borrow: () => Promise<Record<string, unknown>>, journal: DoorJournal | null = null) {
    this.name = name;
    this.borrow = borrow;
    this.journal = journal;
  }

  async send(record: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string }> {
    const cred = await this.borrow();
    if (cred.provider === 'http') return this.httpSend(cred, record, idempotencyKey);
    if (cred.provider === 'dev-file') return this.fileSend(cred, record, idempotencyKey);
    throw new DoorError(`${this.name} provider ${String(cred.provider)} is not supported`, { definite: true });
  }

  async lookup(idempotencyKey: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const cred = await this.borrow();
    if (cred.provider === 'http') return this.httpLookup(cred, idempotencyKey);
    if (cred.provider === 'dev-file') return this.fileLookup(cred, idempotencyKey);
    throw new DoorError(`${this.name} provider ${String(cred.provider)} is not supported`, { definite: true });
  }

  // ── HTTP provider ───────────────────────────────────────────────────────
  private url(cred: Record<string, unknown>, p: string, key?: string): string {
    if (typeof cred.base_url !== 'string' || typeof p !== 'string') throw new DoorError(`${this.name} credential needs base_url, send_path and lookup_path`, { definite: true });
    return cred.base_url.replace(/\/$/, '') + (key ? p.replace('{key}', encodeURIComponent(key)) : p);
  }

  private headers(cred: Record<string, unknown>, key?: string): Record<string, string> {
    return { 'content-type': 'application/json', ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) };
  }

  private async httpSend(cred: Record<string, unknown>, record: Record<string, unknown>, key: string): Promise<{ id: string }> {
    const j = this.journal ? await this.journal.begin(this.name, key, 'http', record) : null;
    if (j?.provider_ref) return { id: j.provider_ref };
    const r = await providerCall(this.url(cred, cred.send_path as string), { method: 'POST', headers: this.headers(cred, key), body: JSON.stringify(j?.payload ?? record) });
    if (r.status >= 200 && r.status < 300 && (typeof r.body?.id === 'string' || typeof r.body?.reference === 'string')) {
      const id = String(r.body.id ?? r.body.reference);
      await this.journal?.accept(this.name, key, id);
      return { id };
    }
    const err = providerError(`${this.name} send`, r);
    if (err.definite) await this.journal?.reject(this.name, key, err.message);
    throw err;
  }

  private async httpLookup(cred: Record<string, unknown>, key: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const j = this.journal ? await this.journal.get(this.name, key) : null;
    if (j?.status === 'rejected') return null;
    const r = await providerCall(this.url(cred, cred.lookup_path as string, key), { method: 'GET', headers: this.headers(cred) });
    if (r.status === 200 && r.body) {
      const id = String(r.body.id ?? r.body.reference ?? j?.provider_ref ?? '');
      if (id && j && !j.provider_ref) await this.journal!.accept(this.name, key, id);
      return { ...r.body, id };
    }
    if (r.status === 404) return null;
    throw providerError(`${this.name} lookup`, r);
  }

  // ── dev file provider ───────────────────────────────────────────────────
  private async dir(cred: Record<string, unknown>): Promise<string> {
    if (typeof cred.dir !== 'string') throw new DoorError(`${this.name} dev-file credential needs dir`, { definite: true });
    await mkdir(cred.dir, { recursive: true });
    return cred.dir;
  }

  private static file(dir: string, key: string): string {
    return path.join(dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
  }

  private async fileSend(cred: Record<string, unknown>, record: Record<string, unknown>, key: string): Promise<{ id: string }> {
    const dir = await this.dir(cred);
    const f = FileDoor.file(dir, key);
    const existing = await readFile(f, 'utf8').catch(() => null);
    if (existing) return { id: JSON.parse(existing).id };
    const id = `${this.name}_${key.slice(-12)}`;
    await writeFile(f, JSON.stringify({ ...record, id, idempotency_key: key, at: new Date().toISOString() }, null, 2), { flag: 'wx' }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    });
    return { id };
  }

  private async fileLookup(cred: Record<string, unknown>, key: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const dir = await this.dir(cred);
    const raw = await readFile(FileDoor.file(dir, key), 'utf8').catch(() => null);
    return raw ? JSON.parse(raw) : null;
  }
}
