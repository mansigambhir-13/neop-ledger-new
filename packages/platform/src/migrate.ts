import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapFamily, migrate } from '@neop/pgkit';

export const PLATFORM_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migratePlatform(adminUrl: string, log?: (m: string) => void) {
  // The platform never needs a BYPASSRLS runner role (it reads no tenant rows as a runner).
  await bootstrapFamily(adminUrl, 'neos', { runner: false });
  return migrate({ adminUrl, schema: 'neos', sources: { dir: PLATFORM_MIGRATIONS }, tenantLint: false, log });
}
