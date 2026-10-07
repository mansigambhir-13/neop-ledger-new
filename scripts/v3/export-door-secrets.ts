// v3 (S8): move door credentials out of the platform vault into the secret store the NEOP backends read.
// Reads neos.vault_secrets, opens each sealed row exactly as the platform does (VaultCipher + the (company, app,
// door) AAD of migration 015; company-wide rows keep the pre-015 binding), and writes one 0600 file per row:
//   app_key '*'   → <target>/<company_id>/<door>.json          (company-wide)
//   app_key <app> → <target>/<company_id>/<app>/<door>.json    (that app's own)
// It never prints a secret value: only company, app, door, the path, and whether it was written or kept.
//
//   tsx scripts/v3/export-door-secrets.ts <target dir> [--company <id>] [--overwrite] [--dry-run]
//     NEOS_ADMIN_URL[_FILE]   DBA link; required after S9 because the archive is intentionally private
//     NEOS_DB_URL[_FILE]      accepted before S9 while neos.vault_secrets is still live
//     NEOS_VAULT_KEYS[_FILE]  the vault keyring ({"active":"k1","keys":{"k1":"<base64>"}})
// Existing files are kept unless --overwrite (the store may already hold a newer credential). Then mount the
// target as $NEOS_SECRETS_DIR/doors (docs/RUNBOOK.md "Door secrets").
import { existsSync, readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@neop/pgkit';
import { doorSecretPaths } from '@neop/template';
import { writeDoorSecret } from './door-secrets.ts';

type Queryable = { query: <R = any>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

// Kept only in this one-way migration utility. The runtime platform has no
// vault in S9, but operators still need to open the archived pre-S9 envelopes
// while moving credentials into the per-app secret store.
export interface VaultKeys {
  active: string;
  keys: Record<string, string>;
}
export interface Envelope {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}
export const vaultAad = (companyId: string, app: string, door: string): string => (app === '*' ? `${companyId}:${door}` : `${companyId}:${app}:${door}`);
export const isEnvelope = (x: unknown): x is Envelope => !!x && typeof x === 'object' && (x as Envelope).v === 1 && typeof (x as Envelope).ct === 'string';
export class VaultCipher {
  private readonly keys: Map<string, Buffer>;
  readonly active: string;
  constructor(cfg: VaultKeys) {
    this.keys = new Map(Object.entries(cfg.keys).map(([kid, b64]) => [kid, Buffer.from(b64, 'base64')]));
    for (const [kid, key] of this.keys) if (key.length !== 32) throw new Error(`vault key ${kid} must be 32 bytes`);
    if (!this.keys.has(cfg.active)) throw new Error('active vault key missing');
    this.active = cfg.active;
  }
  static generate(kid = 'k1'): VaultKeys {
    return { active: kid, keys: { [kid]: randomBytes(32).toString('base64') } };
  }
  seal(plain: unknown, aad: string): Envelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.active)!, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    return { v: 1, kid: this.active, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }
  open(envelope: Envelope, aad: string): Record<string, unknown> {
    const key = this.keys.get(envelope.kid);
    if (!key) throw new Error(`vault key ${envelope.kid} is not in the keyring`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8'));
  }
}

export interface ExportedRow {
  company_id: string;
  app: string | null;
  door: string;
  path: string;
  result: 'written' | 'kept' | 'would_write' | 'unsealed_skipped' | 'unreadable_skipped';
}

export async function exportDoorSecrets(o: { db: Queryable; cipher: VaultCipher; target: string; company?: string; overwrite?: boolean; dryRun?: boolean }): Promise<ExportedRow[]> {
  const source = (
    await o.db.query<{ name: string | null }>(
      `select case
         when to_regclass('neos.vault_secrets') is not null then 'neos.vault_secrets'
         when to_regclass('neos_s9_archive.vault_secrets') is not null then 'neos_s9_archive.vault_secrets'
         else null end as name`,
    )
  ).rows[0]?.name;
  if (!source) throw new Error('no pre-S9 vault table or S9 vault archive exists');
  const rows = (
    await o.db.query<{ company_id: string; app_key: string; door: string; secret: unknown }>(
      `select company_id::text as company_id, app_key, door, secret from ${source} ${o.company ? 'where company_id = $1' : ''} order by company_id, app_key, door`,
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
  const dbUrl = envOf('NEOS_ADMIN_URL') ?? envOf('NEOS_DB_URL');
  const keys = envOf('NEOS_VAULT_KEYS');
  if (!target || !dbUrl || !keys) {
    console.error('usage: NEOS_ADMIN_URL[_FILE]=… NEOS_VAULT_KEYS[_FILE]=… tsx scripts/v3/export-door-secrets.ts <target dir> [--company <id>] [--overwrite] [--dry-run]');
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
