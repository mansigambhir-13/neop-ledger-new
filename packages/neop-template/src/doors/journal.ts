import type { Pool } from '@neop/pgkit';
import { withCompany } from '@neop/pgkit';

export interface JournalEntry {
  provider: string;
  payload: any;
  provider_ref: string | null;
  status: 'sending' | 'accepted' | 'rejected';
  /** Milliseconds since the first attempt (database clock). */
  age_ms: number;
}

/** Write-ahead record of every door call, per company (RLS), keyed by the proposal's idempotency key. */
export interface DoorJournal {
  /** Record the payload before sending; returns the existing entry if this key was seen before. */
  begin(door: string, key: string, provider: string, payload: unknown): Promise<JournalEntry>;
  accept(door: string, key: string, ref: string): Promise<void>;
  reject(door: string, key: string, error: string): Promise<void>;
  get(door: string, key: string): Promise<JournalEntry | null>;
}

export class PgDoorJournal implements DoorJournal {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly companyId: string;
  constructor(pool: Pool, schema: string, companyId: string) {
    this.pool = pool;
    this.schema = schema;
    this.companyId = companyId;
  }

  begin(door: string, key: string, provider: string, payload: unknown): Promise<JournalEntry> {
    return withCompany(this.pool, this.companyId, async (c) => {
      await c.query(
        `insert into ${this.schema}.door_journal (company_id, door, idempotency_key, provider, payload) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [this.companyId, door, key, provider, JSON.stringify(payload)],
      );
      const r = await c.query<JournalEntry>(`select provider, payload, provider_ref, status, (extract(epoch from now() - created_at) * 1000)::bigint as age_ms from ${this.schema}.door_journal where door = $1 and idempotency_key = $2`, [door, key]);
      return r.rows[0]!;
    });
  }

  async accept(door: string, key: string, ref: string): Promise<void> {
    await withCompany(this.pool, this.companyId, (c) =>
      c.query(`update ${this.schema}.door_journal set provider_ref = $3, status = 'accepted', updated_at = now() where door = $1 and idempotency_key = $2`, [door, key, ref]),
    );
  }

  async reject(door: string, key: string, error: string): Promise<void> {
    await withCompany(this.pool, this.companyId, (c) =>
      c.query(`update ${this.schema}.door_journal set status = 'rejected', error = $3, updated_at = now() where door = $1 and idempotency_key = $2`, [door, key, error.slice(0, 500)]),
    );
  }

  get(door: string, key: string): Promise<JournalEntry | null> {
    return withCompany(this.pool, this.companyId, async (c) => {
      const r = await c.query<JournalEntry>(`select provider, payload, provider_ref, status, (extract(epoch from now() - created_at) * 1000)::bigint as age_ms from ${this.schema}.door_journal where door = $1 and idempotency_key = $2`, [door, key]);
      return r.rows[0] ?? null;
    });
  }
}

/** For doors used outside an app (tests, tools): an in-memory journal. */
export class MemoryDoorJournal implements DoorJournal {
  private m = new Map<string, JournalEntry>();
  async begin(door: string, key: string, provider: string, payload: unknown) {
    const k = `${door}:${key}`;
    if (!this.m.has(k)) this.m.set(k, { provider, payload, provider_ref: null, status: 'sending', age_ms: 0 });
    return this.m.get(k)!;
  }
  async accept(door: string, key: string, ref: string) {
    const e = this.m.get(`${door}:${key}`);
    if (e) Object.assign(e, { provider_ref: ref, status: 'accepted' });
  }
  async reject(door: string, key: string) {
    const e = this.m.get(`${door}:${key}`);
    if (e) e.status = 'rejected';
  }
  async get(door: string, key: string) {
    return this.m.get(`${door}:${key}`) ?? null;
  }
}
