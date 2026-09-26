// Ops backups (plan §Backups): nightly per-schema logical exports with retention, per-company
// export/import, and a one-schema restore. Runs with the admin connection (compose `backup` service).
//   tsx scripts/backup.ts nightly [--dir /backups] [--keep 14] [--companies] [--schemas neos,ledger]
//   tsx scripts/backup.ts schedule [--at 02:00] [same options]   (the compose service: waits, runs, repeats)
//   tsx scripts/backup.ts restore-schema <run-dir>/<schema>.dump <schema>
//   tsx scripts/backup.ts export <schema> <company_id> > dump.json
//   tsx scripts/backup.ts import dump.json
import { readFile } from 'node:fs/promises';
import { adminUrlFromEnv, exportCompany, importCompany, nightlyBackup, restoreSchema } from '@neop/pgkit';

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
  log('backup complete', { stamp: m.stamp, schemas: m.schemas.map((s) => `${s.schema}:${s.bytes}`), companies: m.companies.length, removed: m.removed });
  return m;
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
else {
  console.error('usage: backup.ts nightly|schedule [--dir d] [--keep n] [--companies] [--schemas a,b] [--at HH:MM] | restore-schema <file> <schema> | export <schema> <company_id> | import <file>');
  process.exit(2);
}
