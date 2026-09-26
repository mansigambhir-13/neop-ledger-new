// Ops migration runner — the only process with the admin connection. Runs the
// platform's migrations, every app's (template stream + app stream), then any
// package migrations that company installs are waiting on. Apps never run DDL.
//   NEOS_ADMIN_URL=... [NEOS_APPS=ledger] tsx scripts/migrate.ts
// NEOS_APPS names the apps this install runs (default: ledger). Marketing is a
// test fixture and is migrated only when listed.
import { adminUrlFromEnv, roleUrl } from '@neop/pgkit';
import { migratePlatform, Platform, generateSigningKeys } from '@neop/platform';
import { migrateApp, migratePackage } from '@neop/template';

const admin = adminUrlFromEnv();
const log = (m: string) => console.log(m);
await migratePlatform(admin, log);
const loaders: Record<string, () => Promise<Parameters<typeof migrateApp>[1]>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};
for (const name of (process.env.NEOS_APPS ?? 'ledger').split(',').map((s) => s.trim()).filter(Boolean)) {
  const load = loaders[name];
  if (!load) throw new Error(`unknown app in NEOS_APPS: ${name} (known: ${Object.keys(loaders).join(', ')})`);
  await migrateApp(admin, await load(), log);
}

const platform = new Platform({ dbUrl: roleUrl(admin, 'neos_app'), keys: await generateSigningKeys() });
await platform.ensureRegistry();
for (const p of await platform.pendingPackageMigrations()) {
  for (const name of await migratePackage(admin, p.host_app, p.bundle)) log(`[${p.host_app}] applied ${name}`);
  await platform.markPackageMigrated(p.host_app, p.entry_key, p.version);
}
await platform.stop();
log('migrations complete');
