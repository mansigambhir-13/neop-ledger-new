import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

export const DEFAULT_ADMIN_URL = 'postgres://neos_admin:neos_admin@localhost:5433/neos';

export function adminUrlFromEnv(): string {
  const file = process.env.NEOS_ADMIN_URL_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  if (process.env.NEOS_ADMIN_URL) return process.env.NEOS_ADMIN_URL;
  if (process.env.NEOS_ENV === 'production') throw new Error('NEOS_ADMIN_URL (or NEOS_ADMIN_URL_FILE) is required when NEOS_ENV=production');
  return DEFAULT_ADMIN_URL;
}

/** A throwaway database on the local cluster. Roles are cluster-wide and shared. */
export async function createTestDatabase(prefix = 'neop_t'): Promise<{ adminUrl: string; drop: () => Promise<void> }> {
  const base = adminUrlFromEnv();
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(base);
  u.pathname = '/' + name;
  return {
    adminUrl: u.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
