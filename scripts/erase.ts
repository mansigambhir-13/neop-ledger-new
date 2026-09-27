// Personal data, for the DBA (WP §11: "personal-data columns are tagged in the manifest so deletion
// can find them"). Reads the app's manifest `personal_data` tags and touches only those columns,
// only for one company. Runs with the admin connection (NEOS_ADMIN_URL[_FILE]); every export and
// erase is written to neos.audit in the same transaction.
//   tsx scripts/erase.ts find   <company_id> <app> <text>                         who is this? (matches in tagged columns)
//   tsx scripts/erase.ts export <company_id> <app> <subject> [--by <who>] [--out file]   subject access request
//   tsx scripts/erase.ts erase  <company_id> <app> <subject> [--by <who>] [--yes]        dry run unless --yes
// <subject> is the value of the tag's subject_key (for Ledger: the party's id). Erasing
// pseudonymises in place: rows (and the money and journal entries that point at them) stay.
// Also available as `tsx scripts/ops.ts personal-find|personal-export|personal-erase …`.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { adminUrlFromEnv, eraseSubject, exportSubject, findSubjects, type PersonalDataTag } from '@neop/pgkit';

const apps: Record<string, () => Promise<{ manifest: { app: string; personal_data?: PersonalDataTag[] } }>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};

const USAGE = 'usage: erase.ts find <company_id> <app> <text> | export <company_id> <app> <subject> [--by who] [--out file] | erase <company_id> <app> <subject> [--by who] [--yes]';

/** Returns the process exit code. Output is one JSON document on stdout. */
export async function eraseCli(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const yes = args.includes('--yes') ? (args.splice(args.indexOf('--yes'), 1), true) : false;
  const by = flag('--by') ?? `dba:${process.env.USER ?? 'unknown'}`;
  const out = flag('--out');
  const [cmd, companyId, appKey, subject] = args;
  if (!cmd || !companyId || !appKey || !subject || !['find', 'export', 'erase'].includes(cmd)) {
    console.error(USAGE);
    return 64;
  }
  const load = apps[appKey];
  if (!load) {
    console.error(`unknown app: ${appKey}`);
    return 64;
  }
  const { manifest } = await load();
  const tags = manifest.personal_data ?? [];
  if (!tags.length) {
    console.error(`${appKey} tags no personal data in its manifest; nothing to find, export or erase`);
    return 65;
  }
  const admin = adminUrlFromEnv();
  if (cmd === 'find') {
    console.log(JSON.stringify({ app: appKey, company_id: companyId, matches: await findSubjects(admin, manifest.app, companyId, tags, subject) }, null, 2));
  } else if (cmd === 'export') {
    const dump = await exportSubject(admin, manifest.app, companyId, tags, subject, by);
    if (out) await writeFile(out, JSON.stringify(dump, null, 2), { mode: 0o600 });
    console.log(out ? JSON.stringify({ exported: out, tables: Object.fromEntries(Object.entries(dump.tables).map(([k, v]) => [k, v.length])) }) : JSON.stringify(dump, null, 2));
  } else {
    const r = await eraseSubject(admin, manifest.app, companyId, tags, subject, { by, dryRun: !yes });
    console.log(JSON.stringify(r, null, 2));
    if (!yes) console.error('dry run: nothing changed. Re-run with --yes to erase.');
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await eraseCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(String((e as Error).message ?? e));
    return 1;
  });
}
