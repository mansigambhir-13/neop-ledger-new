// Ops migration runner — the only process with the admin connection. Runs the
// platform's migrations, every app's (template stream + app stream), then any
// package migrations that company installs are waiting on. Apps never run DDL.
//   NEOS_ADMIN_URL=... [NEOS_APPS=ledger] tsx scripts/migrate.ts
// NEOS_APPS names the apps this install runs (default: ledger). Marketing is a
// test fixture and is migrated only when listed.
// D2 dedicated-DB tier: NEOS_ADMIN_URL_<APP> (or _FILE) sends that app's family (roles, schema,
// package migrations) to its own cluster; every other app stays on NEOS_ADMIN_URL.
import { readFileSync } from 'node:fs';
import { adminUrlFromEnv, roleUrl } from '@neop/pgkit';
import { backfillBoards, drainApprovals, migratePlatform, Platform, generateSigningKeys } from '@neop/platform';
import { migrateApp, migratePackage } from '@neop/template';

const admin = adminUrlFromEnv();
const appAdmin = (app: string): string => {
  const k = `NEOS_ADMIN_URL_${app.toUpperCase()}`;
  const file = process.env[`${k}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : (process.env[k] ?? admin);
};
const log = (m: string) => console.log(m);
await migratePlatform(admin, log);
const loaders: Record<string, () => Promise<Parameters<typeof migrateApp>[1]>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};
for (const name of (process.env.NEOS_APPS ?? 'ledger').split(',').map((s) => s.trim()).filter(Boolean)) {
  const load = loaders[name];
  if (!load) throw new Error(`unknown app in NEOS_APPS: ${name} (known: ${Object.keys(loaders).join(', ')})`);
  if (appAdmin(name) !== admin) log(`[${name}] dedicated cluster ${new URL(appAdmin(name)).host}`);
  await migrateApp(appAdmin(name), await load(), log);
}

const platform = new Platform({ dbUrl: roleUrl(admin, 'neos_app'), keys: await generateSigningKeys() });
await platform.ensureRegistry();
let failedPackages = 0;
for (const p of await platform.pendingPackageMigrations()) {
  try {
    // Migrations, then the package's self-test; a failure undoes the run and settles the install.
    for (const name of await platform.applyPackageMigration(p, () => migratePackage(appAdmin(p.host_app), p.host_app, p.bundle))) log(`[${p.host_app}] applied ${name}`);
  } catch (e) {
    failedPackages++;
    log(`[${p.host_app}] ${p.entry_key}@${p.version} NOT installed: ${(e as Error).message}`);
  }
}
if (failedPackages) process.exitCode = 1;
// v3 S1 (t010): the data half — what the platform held (installs, boards, grants) into each app's own schema,
// in the same window (idempotent; scripts/v3/backfill-boards.ts runs it on its own).
const filled = await backfillBoards(platform.db, { log: (m, e) => log(`[boards] ${m} ${e ? JSON.stringify(e) : ''}`) });
log(`[boards] ${filled.length} install(s) checked, ${filled.filter((r) => r.install === 'written' || r.board === 'written' || r.grants > 0).length} written`);
// v3 S2 (t011 + platform 020): the retired approvals worker's work in hand, answered through each app's
// answer_proposal() (idempotent; scripts/v3/drain-approvals.ts runs it on its own).
const drained = await drainApprovals(platform.db, { log: (m, e) => log(`[approvals] ${m} ${e ? JSON.stringify(e) : ''}`) });
log(`[approvals] ${drained.length} in hand, ${drained.filter((r) => r.result === 'answered').length} handed over, ${drained.filter((r) => r.result === 'already').length} already held`);
if (drained.some((r) => r.result === 'error' || r.result === 'no_schema')) process.exitCode = 1;
await platform.stop();
log('migrations complete');
