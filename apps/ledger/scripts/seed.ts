// Load the demo books (Jul–Sep 2026, a small Indian trading company) into ONE company.
// Runs where the Ledger app role is reachable (the backend container), under RLS as that company.
// Demo data in a real company's books would be wrong, so it asks for an explicit flag.
//   tsx apps/ledger/scripts/seed.ts <company_id> --demo-data       (demo books)
//   tsx apps/ledger/scripts/seed.ts <company_id> --starter-chart   (a real new company: the chart of accounts only)
import { createPool } from '@neop/pgkit';
import { applyStarterChart, seedLedger } from '../src/index.ts';
import { env, log } from './env.ts';

const [companyId, flag] = process.argv.slice(2);
if (!companyId || !/^[0-9a-f-]{36}$/.test(companyId) || !['--demo-data', '--starter-chart'].includes(flag ?? '')) {
  console.error('usage: seed.ts <company_id> --demo-data | --starter-chart');
  process.exit(64);
}
const pool = createPool(env('NEOP_APP_DB_URL'), 2);
try {
  if (flag === '--starter-chart') {
    const r = await applyStarterChart(pool, companyId);
    log('info', 'starter chart of accounts', { company_id: companyId, added: r.added, of: r.total });
  } else {
    const r = await seedLedger(pool, companyId);
    log('info', 'demo books loaded', { company_id: companyId, entries: r.entries });
  }
} finally {
  await pool.end();
}
