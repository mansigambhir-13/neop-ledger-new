// v3 (S8): move door credentials out of the platform vault into the secret store the NEOP backends read.
// Reads neos.vault_secrets, opens each sealed row exactly as the platform does (VaultCipher + the (company, app,
// door) AAD of migration 015; company-wide rows keep the pre-015 binding), and writes one 0600 file per row:
//   app_key '*'   → <target>/<company_id>/<door>.json          (company-wide)
//   app_key <app> → <target>/<company_id>/<app>/<door>.json    (that app's own)
// It never prints a secret value: only company, app, door, the path, and whether it was written or kept.
//
//   tsx scripts/v3/export-door-secrets.ts <target dir> [--company <id>] [--overwrite] [--dry-run]
//     NEOS_DB_URL[_FILE]      a platform database link that can read neos.vault_secrets (the platform's own role)
//     NEOS_VAULT_KEYS[_FILE]  the vault keyring ({"active":"k1","keys":{"k1":"<base64>"}})
// Existing files are kept unless --overwrite (the store may already hold a newer credential). Then mount the
// target as $NEOS_SECRETS_DIR/doors (docs/RUNBOOK.md "Door secrets").
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@neop/pgkit';
import { isEnvelope, vaultAad, VaultCipher } from '@neop/platform';
import { doorSecretPaths } from '@neop/template';
import { writeDoorSecret } from './door-secrets.ts';

type Queryable = { query: <R = any>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export interface ExportedRow {
  company_id: string;
  app: string | null;
  door: string;
  path: string;
  result: 'written' | 'kept' | 'would_write' | 'unsealed_skipped' | 'unreadable_skipped';
}

export async function exportDoorSecrets(o: { db: Queryable; cipher: VaultCipher; target: string; company?: string; overwrite?: boolean; dryRun?: boolean }): Promise<ExportedRow[]> {
  const rows = (
    await o.db.query<{ company_id: string; app_key: string; door: string; secret: unknown }>(
      `select company_id::text as company_id, app_key, door, secret from neos.vault_secrets ${o.company ? 'where company_id = $1' : ''} order by company_id, app_key, door`,
      o.company ? [o.company] : [],
    )
  ).rows;
  const out: ExportedRow[] = [];
  for (const r of rows) {
    const p = doorSecretPaths(o.target, r.company_id, r.app_key === '*' ? 'x' : r.app_key, r.door);
    const file = r.app_key === '*' ? p.company : p.own;
    const base = { company_id: r.company_id, app: r.app_key === '*' ? null : r.app_key, door: r.door, path: path.relative(o.target, file) };
    // The platform only ever lends sealed rows (rekeyVault seals legacy ones); do the same.
    if (!isEnvelope(r.secret)) {
      out.push({ ...base, result: 'unsealed_skipped' });
      continue;
    }
    let plain: Record<string, unknown>;
    try {
      plain = o.cipher.open(r.secret, vaultAad(r.company_id, r.app_key, r.door));
    } catch {
      out.push({ ...base, result: 'unreadable_skipped' }); // wrong keyring, or a row moved between slots
      continue;
    }
    if (existsSync(file) && !o.overwrite) out.push({ ...base, result: 'kept' });
    else if (o.dryRun) out.push({ ...base, result: 'would_write' });
    else {
      await writeDoorSecret(o.target, r.company_id, r.door, plain, r.app_key);
      out.push({ ...base, result: 'written' });
    }
  }
  return out;
}

function envOf(name: string): string | undefined {
  const f = process.env[`${name}_FILE`];
  return f ? readFileSync(f, 'utf8').trim() : process.env[name] || undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(`--${n}`);
  const opt = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--company');
  const dbUrl = envOf('NEOS_DB_URL');
  const keys = envOf('NEOS_VAULT_KEYS');
  if (!target || !dbUrl || !keys) {
    console.error('usage: NEOS_DB_URL[_FILE]=… NEOS_VAULT_KEYS[_FILE]=… tsx scripts/v3/export-door-secrets.ts <target dir> [--company <id>] [--overwrite] [--dry-run]');
    process.exit(64);
  }
  const pool = createPool(dbUrl, 1);
  try {
    const rows = await exportDoorSecrets({ db: pool, cipher: new VaultCipher(JSON.parse(keys)), target: path.resolve(target), company: opt('company'), overwrite: flag('overwrite'), dryRun: flag('dry-run') });
    for (const r of rows) console.log(JSON.stringify(r));
    const skipped = rows.filter((r) => r.result.endsWith('_skipped'));
    console.error(`${rows.filter((r) => r.result === 'written').length} written, ${rows.filter((r) => r.result === 'kept').length} kept, ${skipped.length} skipped${flag('dry-run') ? ' (dry run)' : ''}`);
    process.exitCode = skipped.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}
