// v3 S1 BACKFILL · the data half of template migration t010 (a data migration is a script the DBA runs in the same
// window, WP v3 §11). Copies what the platform held before S1 — neos.installs, the latest neos.switchboards version,
// neos.grants and their uses (neos.audit 'grant.used') — into each installed app's own schema, where they are now
// the truth: <app>.installs, <app>.switchboard (+ switchboard_history), <app>.grants (+ grant_uses).
//
//   NEOS_ADMIN_URL=… tsx scripts/v3/backfill-boards.ts [--app ledger] [--company <uuid>] [--json]
//
// Idempotent: run it as often as you like. It never overwrites newer truth with the platform's stale copy (a board is
// replaced only when the platform's version is newer, or the app's rows are t009 mirrors), and the platform runs the
// same backfill by itself at registerApp and installApp. The connection must be able to SET ROLE neos_desk: the admin
// link, or NEOS_DB_URL (the platform's neos_app link, a member of neos_desk). Prints one line per (app, company).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminUrlFromEnv, createPool } from '@neop/pgkit';
import { backfillBoards, type BackfillReport } from '@neop/platform';

export async function runBackfill(opts: { url: string; app?: string; company?: string; log?: (m: string) => void }): Promise<BackfillReport[]> {
  const pool = createPool(opts.url, 2);
  try {
    return await backfillBoards(pool, { app: opts.app, company: opts.company, log: (m, e) => opts.log?.(`${m} ${e ? JSON.stringify(e) : ''}`) });
  } finally {
    await pool.end();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.env.NEOS_DB_URL_FILE;
  const url = file ? readFileSync(file, 'utf8').trim() : (process.env.NEOS_DB_URL ?? adminUrlFromEnv());
  const rows = await runBackfill({ url, app: arg('app'), company: arg('company') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('APP'.padEnd(14) + 'COMPANY'.padEnd(38) + 'INSTALL'.padEnd(10) + 'BOARD'.padEnd(10) + 'VERSION'.padEnd(9) + 'GRANTS');
    for (const r of rows) console.log(r.app.padEnd(14) + r.company_id.padEnd(38) + r.install.padEnd(10) + r.board.padEnd(10) + String(r.board_version).padEnd(9) + r.grants);
    console.log(`${rows.length} install(s) checked; ${rows.filter((r) => r.install === 'written' || r.board === 'written' || r.grants > 0).length} written.`);
  }
}
