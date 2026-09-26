// Ops: per-company export/import, and a per-schema pg_dump command.
//   tsx scripts/backup.ts export <schema> <company_id> > dump.json
//   tsx scripts/backup.ts import dump.json
//   tsx scripts/backup.ts schema <schema>      (prints the pg_dump command for a nightly per-schema dump)
import { readFile } from 'node:fs/promises';
import { adminUrlFromEnv, exportCompany, importCompany } from '@neop/pgkit';

const [cmd, a, b] = process.argv.slice(2);
const url = adminUrlFromEnv();
if (cmd === 'export' && a && b) process.stdout.write(JSON.stringify(await exportCompany(url, a, b)));
else if (cmd === 'import' && a) console.log(await importCompany(url, JSON.parse(await readFile(a, 'utf8'))));
else if (cmd === 'schema' && a) console.log(`pg_dump --format=custom --schema=${a} --file=${a}-$(date +%F).dump "${url}"`);
else {
  console.error('usage: backup.ts export <schema> <company_id> | import <file> | schema <schema>');
  process.exit(2);
}
