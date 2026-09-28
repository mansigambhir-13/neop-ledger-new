// Ops backups (plan §Backups): nightly per-schema logical exports with retention, per-company
// export/import, and a one-schema restore. Runs with the admin connection (compose `backup` service).
//   tsx scripts/backup.ts nightly [--dir /backups] [--keep 14] [--companies] [--schemas neos,ledger]
//   tsx scripts/backup.ts schedule [--at 02:00] [same options]   (the compose service: waits, runs, repeats)
//   tsx scripts/backup.ts restore-schema <run-dir>/<schema>.dump <schema>
//   tsx scripts/backup.ts export <schema> <company_id> > dump.json
//   tsx scripts/backup.ts import dump.json
//   tsx scripts/backup.ts restore-doors <run-dir>/doors.enc <target doors dir>
// Door credentials (v3 §12): with NEOS_BACKUP_DOORS_DIR set, each nightly run also holds doors.enc — the whole
// secret store sealed with NEOS_BACKUP_DOORS_KEY[_FILE] (AES-256-GCM). Without a key it is skipped, never copied
// in clear. Keep the key apart from the backups (docs/RUNBOOK.md "Door secrets").
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminUrlFromEnv, exportCompany, importCompany, nightlyBackup, restoreSchema } from '@neop/pgkit';
import { restoreDoors, sealDoors } from './v3/door-secrets.ts';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const has = (name: string) => rest.includes(`--${name}`);
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'backup', msg, ...extra }));

async function nightly() {
  const m = await nightlyBackup({
    adminUrl: adminUrlFromEnv(),
    dir: opt('dir', process.env.NEOS_BACKUP_DIR ?? '/backups')!,
    keep: Number(opt('keep', process.env.NEOS_BACKUP_KEEP ?? '14')),
    companies: has('companies') || process.env.NEOS_BACKUP_COMPANIES === '1',
    schemas: opt('schemas')?.split(',').map((s) => s.trim()).filter(Boolean),
    log: (msg) => log(msg),
  });
  const dir = opt('dir', process.env.NEOS_BACKUP_DIR ?? '/backups')!;
  const doors = await backupDoors(path.join(dir, m.stamp));
  log('backup complete', { stamp: m.stamp, schemas: m.schemas.map((s) => `${s.schema}:${s.bytes}`), companies: m.companies.length, removed: m.removed, doors });
  return m;
}

function doorsKey(): Buffer | null {
  const file = process.env.NEOS_BACKUP_DOORS_KEY_FILE;
  const b64 = file ? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') : (process.env.NEOS_BACKUP_DOORS_KEY ?? '');
  return b64 ? Buffer.from(b64, 'base64') : null;
}

/** The door secret store into this run, sealed. Returns how many credentials went in (never their contents). */
async function backupDoors(runDir: string): Promise<number | string> {
  const root = process.env.NEOS_BACKUP_DOORS_DIR;
  if (!root) return 'not configured';
  const key = doorsKey();
  if (!key) {
    log('door secrets NOT backed up: no NEOS_BACKUP_DOORS_KEY[_FILE] — they are never copied in clear');
    return 'skipped: no key';
  }
  const { blob, files } = await sealDoors(root, key);
  await writeFile(path.join(runDir, 'doors.enc'), blob, { mode: 0o600 });
  return files;
}

/** Milliseconds from `now` until the next HH:MM (local time of the container, TZ env). */
function msUntil(hhmm: string, now = new Date()): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

if (cmd === 'nightly') await nightly();
else if (cmd === 'schedule') {
  const at = opt('at', process.env.NEOS_BACKUP_AT ?? '02:00')!;
  if (!/^\d{2}:\d{2}$/.test(at)) throw new Error(`--at ${at}: expected HH:MM`);
  let stop = false;
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => ((stop = true), process.exit(0)));
  if (process.env.NEOS_BACKUP_ON_START === '1') await nightly().catch((e) => log('backup failed', { error: String(e) }));
  while (!stop) {
    const wait = msUntil(at);
    log('next backup scheduled', { at, in_s: Math.round(wait / 1000) });
    await new Promise((r) => setTimeout(r, wait));
    // A failed night is logged loudly and retried the next night; the service never exits on it.
    await nightly().catch((e) => log('backup failed', { error: String(e) }));
  }
} else if (cmd === 'restore-schema' && rest[0] && rest[1]) {
  await restoreSchema(adminUrlFromEnv(), rest[0], rest[1]);
  log('schema restored', { schema: rest[1], from: rest[0] });
} else if (cmd === 'export' && rest[0] && rest[1]) process.stdout.write(JSON.stringify(await exportCompany(adminUrlFromEnv(), rest[0], rest[1])));
else if (cmd === 'import' && rest[0]) console.log(await importCompany(adminUrlFromEnv(), JSON.parse(await readFile(rest[0], 'utf8'))));
else if (cmd === 'restore-doors' && rest[0] && rest[1]) {
  const key = doorsKey();
  if (!key) throw new Error('NEOS_BACKUP_DOORS_KEY[_FILE] is required to open a doors backup');
  const files = await restoreDoors(await readFile(rest[0]), key, rest[1]);
  log('door secrets restored', { to: rest[1], files: files.length });
}
else {
  console.error('usage: backup.ts nightly|schedule [--dir d] [--keep n] [--companies] [--schemas a,b] [--at HH:MM] | restore-schema <file> <schema> | export <schema> <company_id> | import <file> | restore-doors <doors.enc> <dir>');
  process.exit(2);
}
