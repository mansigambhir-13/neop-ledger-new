// v3 S2 DRAIN · hand what the retired approvals worker had in hand to the apps, once (packages/platform/src/drain.ts).
// Every neos.approvals row still RECORDED (a person answered; the app had not heard it) or RESOLVED (the app holds
// the yes; nothing carried it out yet) is answered again through <app>.answer_proposal() — same person, same
// fingerprint, same decision — and the app's runner carries a yes out. neos.approvals is frozen (platform 020) and
// is never written.
//
//   NEOS_ADMIN_URL=… tsx scripts/v3/drain-approvals.ts [--app ledger] [--json]
//
// Idempotent: run it as often as you like (an answer the app already holds is reported `already`). scripts/migrate.ts
// runs it after the apps' migrations (t011). The connection must be able to SET ROLE neos_desk: the admin link, or
// NEOS_DB_URL (the platform's neos_app link, a member of neos_desk). Exit 1 when a row could not be handed over
// (result `error` or `no_schema`); `closed` / `refused` / `not_found` are reported and left as they are.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminUrlFromEnv, createPool } from '@neop/pgkit';
import { drainApprovals, type DrainReport } from '@neop/platform';

export async function runDrain(opts: { url: string; app?: string; log?: (m: string) => void }): Promise<DrainReport[]> {
  const pool = createPool(opts.url, 2);
  try {
    return await drainApprovals(pool, { app: opts.app, log: (m, e) => opts.log?.(`${m}${e ? ' ' + JSON.stringify(e) : ''}`) });
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
  const rows = await runDrain({ url, app: arg('app') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('APP'.padEnd(12) + 'PROPOSAL'.padEnd(38) + 'DECISION'.padEnd(10) + 'RESULT'.padEnd(11) + 'STATUS');
    for (const r of rows) console.log(r.app.padEnd(12) + r.proposal_id.padEnd(38) + r.decision.padEnd(10) + r.result.padEnd(11) + (r.status ?? r.detail ?? ''));
    console.log(`${rows.length} approval(s) in hand; ${rows.filter((r) => r.result === 'answered').length} handed over, ${rows.filter((r) => r.result === 'already').length} already held.`);
  }
  if (rows.some((r) => r.result === 'error' || r.result === 'no_schema')) process.exitCode = 1;
}
