// The one reviewable file a DBA applies (WP v3 §11 "the DBA path"): an app's roles and grants, its
// schema, and every shipped migration — the template stream, then the app's — with {{schema}}
// substituted and each file's sha256. Read-only: it prints (or writes --out), it never connects.
//   tsx scripts/dba-bundle.ts ledger [--out ledger-dba.sql]
import { writeFile } from 'node:fs/promises';
import { renderDbaBundle } from '@neop/pgkit';
import path from 'node:path';
import { appMigrationSources, LOCK_FILE, packageBootstrapSql, readLock } from '@neop/template';

const loaders: Record<string, () => Promise<Parameters<typeof appMigrationSources>[0]>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
if (!name || !loaders[name] || (outAt >= 0 && !out)) {
  console.error(`usage: tsx scripts/dba-bundle.ts <${Object.keys(loaders).join('|')}> [--out file.sql]`);
  process.exit(2);
}
const app = await loaders[name]!();
// v3 S7: the packages installed into this build — their migrations are in the set above; their roles and grants here.
const lock = app.packages ? await readLock(path.join(app.packages.root, LOCK_FILE)) : null;
const extra = lock?.packages.length ? [{ title: 'installed packages (v3 §10): each package role writes only its own tables; the app role reads them', sql: packageBootstrapSql(app.manifest.app, lock) }] : [];
const bundle = await renderDbaBundle({ schema: app.manifest.app, sources: await appMigrationSources(app), title: `${app.manifest.name} ${app.manifest.version}`, extra });
if (out) {
  await writeFile(out, bundle.sql);
  console.error(`wrote ${out}: ${bundle.migrations.length} migrations for schema ${bundle.schema}`);
} else {
  process.stdout.write(bundle.sql);
}
