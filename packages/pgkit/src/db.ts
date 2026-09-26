import pg from 'pg';

// Money and counts come back as JS numbers; bigint columns hold minor units and
// stay well below 2^53 for any real ledger.
pg.types.setTypeParser(20, (v) => Number(v));
// Dates stay as ISO date strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * A pool that cannot wedge the database: acquisition, statements and lock
 * waits time out, and a session left idle inside a transaction (a process that
 * died mid-transaction) is ended by the server, releasing its locks.
 */
export function createPool(url: string, max = 5): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  } as pg.PoolConfig);
  const clients = new Set<pg.PoolClient>();
  pool.on('connect', (c) => {
    clients.add(c as pg.PoolClient);
    // A connection closed under a checked-out client (forceClose, server restart) must not crash the process.
    c.on('error', () => {});
  });
  pool.on('remove', (c) => clients.delete(c as pg.PoolClient));
  pool.on('error', () => {});
  (pool as unknown as { __clients: Set<pg.PoolClient> }).__clients = clients;
  return pool;
}

/**
 * Close every connection now, including checked-out ones — what a crash does.
 * The server rolls back their transactions and releases their advisory locks.
 */
export function forceClose(pool: pg.Pool): void {
  const clients = (pool as unknown as { __clients?: Set<pg.PoolClient> }).__clients;
  for (const c of clients ?? []) {
    try {
      (c as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch {
      /* already gone */
    }
  }
  clients?.clear();
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * One transaction scoped to one company. The company id comes from a verified
 * gateway or job token, never from a request body; RLS does the rest.
 */
export async function withCompany<T>(pool: pg.Pool, companyId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return tx(pool, async (c) => {
    await c.query("select set_config('neos.company_id', $1, true)", [companyId]);
    return fn(c);
  });
}
