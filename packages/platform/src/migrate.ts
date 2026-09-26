import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapFamily, migrate } from '@neop/pgkit';

export const PLATFORM_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migratePlatform(adminUrl: string, log?: (m: string) => void) {
  await bootstrapFamily(adminUrl, 'neos');
  return migrate({ adminUrl, schema: 'neos', sources: { dir: PLATFORM_MIGRATIONS }, tenantLint: false, log });
}
