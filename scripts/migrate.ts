// Ops migration runner — the only process with the admin connection. Runs the
// platform's migrations, then every app's (template stream + app stream, which carries the
// migrations of the packages installed into it at build time). Apps never run DDL.
//   NEOS_ADMIN_URL=... [NEOS_APPS=ledger] tsx scripts/migrate.ts
// NEOS_APPS names the apps this install runs (default: ledger). Marketing is a
// test fixture and is migrated only when listed.
// D2 dedicated-DB tier: NEOS_ADMIN_URL_<APP> (or _FILE) sends that app's family (roles, schema,
// package migrations) to its own cluster; every other app stays on NEOS_ADMIN_URL.
import { readFileSync } from 'node:fs';
import { adminUrlFromEnv } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { migrateApp } from '@neop/template';

const admin = adminUrlFromEnv();
const appAdmin = (app: string): string => {
  const k = `NEOS_ADMIN_URL_${app.toUpperCase()}`;
  const file = process.env[`${k}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : (process.env[k] ?? admin);
};
const log = (m: string) => console.log(m);
// 025 is the destructive S9 contraction. The normal deploy path remains
// expand-only until the populated-data proof and explicit cutover command are
// green; this prevents an ordinary migration run from dropping legacy tables.
await migratePlatform(admin, log, { through: '024' });
const loaders: Record<string, () => Promise<Parameters<typeof migrateApp>[1]>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
  wage: async () => (await import('@neop/wage')).wageApp(),
  pay: async () => (await import('@neop/pay')).payApp(),
  buy: async () => (await import('@neop/buy')).buyApp(),
  renew: async () => (await import('@neop/renew')).renewApp(),
  deal: async () => (await import('@neop/deal')).dealApp(),
  quote: async () => (await import('@neop/quote')).quoteApp(),
  hire: async () => (await import('@neop/hire')).hireApp(),
  desk: async () => (await import('@neop/desk')).deskApp(),
  reach: async () => (await import('@neop/reach')).reachApp(),
  roster: async () => (await import('@neop/roster')).rosterApp(),
  grant: async () => (await import('@neop/grant')).grantApp(),
  shift: async () => (await import('@neop/shift')).shiftApp(),
  sync: async () => (await import('@neop/sync')).syncApp(),
  post: async () => (await import('@neop/post')).postApp(),
  sign: async () => (await import('@neop/sign')).signApp(),
  guard: async () => (await import('@neop/guard')).guardApp(),
  vet: async () => (await import('@neop/vet')).vetApp(),
  asset: async () => (await import('@neop/asset')).assetApp(),
  clear: async () => (await import('@neop/clear')).clearApp(),
};
for (const name of (process.env.NEOS_APPS ?? 'ledger').split(',').map((s) => s.trim()).filter(Boolean)) {
  const load = loaders[name];
  if (!load) throw new Error(`unknown app in NEOS_APPS: ${name} (known: ${Object.keys(loaders).join(', ')})`);
  if (appAdmin(name) !== admin) log(`[${name}] dedicated cluster ${new URL(appAdmin(name)).host}`);
  await migrateApp(appAdmin(name), await load(), log);
}
log('expand migrations complete through platform 024; S9 contract 025 was not applied');
