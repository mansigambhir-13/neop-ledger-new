// Operator CLI · the bootstrap steps with no HTTP route (there is no admin yet to call one),
// plus operator actions on a running platform.
// Runs where the platform's database role is reachable (the platform container).
//   tsx scripts/ops.ts register-app ledger --conformance conformance/ledger.json [--author-key author.pub.jwk]
//                                                                        (secret: NEOP_SERVICE_SECRET[_FILE]; production refuses without a green attestation)
//   tsx scripts/ops.ts create-company "Acme Traders" [Asia/Kolkata]
//   tsx scripts/ops.ts create-user <company_id> <name> <email> <admin|member|operator>
//   tsx scripts/ops.ts install <company_id> <app>
//   tsx scripts/ops.ts rotate-service-secret <app>                     (new secret: NEOP_SERVICE_SECRET[_FILE])
//   (v3 S7: a package's tables are the host's; dropping them is a contract migration in the host's own set, not an ops command)
// Uninstall for one company (WP §11: a company-scoped delete the DBA runs from one script). NEOS_DB_URL, and for --purge NEOS_ADMIN_URL:
//   tsx scripts/ops.ts uninstall <company_id> <app> [--purge] [--yes] [--backup-dir /backups]
//     without --yes: a dry run — what would change, and with --purge the rows per table that would go.
//     --yes: the install is marked removed (no Matrix routing and no offering for that company).
//     --yes --purge: first a backup (that company's rows as JSON, restorable with backup.ts import, plus a
//       pg_dump of the schema when pg_dump is on PATH), then every table in the app's schema loses that
//       company's rows, children first, in one transaction. Kept files under NEOP_DOCUMENTS_DIR/<app>/<company>/ go too.
// Personal data (manifest personal_data tags; NEOS_ADMIN_URL): the same as scripts/erase.ts
//   tsx scripts/ops.ts personal-find|personal-export|personal-erase <company_id> <app> <text|subject> [--by who] [--out f] [--yes]
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminUrlFromEnv, backupStamp, exportCompany, nightlyBackup, purgeCompany } from '@neop/pgkit';
import { generateSigningKeys, Platform } from '@neop/platform';
import { env } from '../apps/ledger/scripts/env.ts';
import { eraseCli } from './erase.ts';

const apps: Record<string, () => Promise<{ manifest: any; blocks?: Record<string, unknown> }>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name: string): boolean => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
if (argv[0]?.startsWith('personal-')) {
  // Before anything else parses flags: erase.ts owns --by/--out/--yes for these.
  process.exit(await eraseCli([argv[0].slice('personal-'.length), ...argv.slice(1)]).catch((e: unknown) => (console.error(String((e as Error).message ?? e)), 1)));
}
const conformanceFile = flag('--conformance');
const backupDir = flag('--backup-dir');
const purge = bool('--purge');
const yes = bool('--yes');
const authorKeyFile = flag('--author-key');
const [cmd, ...args] = argv;
const usage = () => {
  console.error(
    'usage: ops.ts register-app <app> [--conformance <file>] [--author-key <jwk file>] | create-company <name> [tz] | create-user <company_id> <name> <email> <role> | install <company_id> <app> | rotate-service-secret <app> | uninstall <company_id> <app> [--purge] [--yes] [--backup-dir d] | personal-find|personal-export|personal-erase <company_id> <app> <subject> …',
  );
  process.exit(64);
};
const need = (n: number) => (args.length < n || args.slice(0, n).some((a) => !a) ? usage() : undefined);
const secret = () => {
  const s = env('NEOP_SERVICE_SECRET');
  if (s.length < 32) throw new Error('service secret must be at least 32 characters');
  return s;
};

const p = new Platform({ dbUrl: env('NEOS_DB_URL'), keys: await generateSigningKeys(), dbPoolSize: 2 });
try {
  switch (cmd) {
    case 'register-app': {
      need(1);
      const load = apps[args[0]!];
      if (!load) throw new Error(`unknown app: ${args[0]}`);
      const def = await load();
      const conformance = conformanceFile ? JSON.parse(await readFile(conformanceFile, 'utf8')) : undefined;
      const author_public_key = authorKeyFile ? JSON.parse(await readFile(authorKeyFile, 'utf8')) : undefined;
      await p.registerApp({ key: args[0]!, manifest: def.manifest, service_secret: secret(), blocks: def.blocks, conformance, author_public_key });
      console.log(JSON.stringify({ registered: args[0], blocks: Object.keys(def.blocks ?? {}).length, attested: !!conformance, author_key: !!author_public_key }));
      break;
    }
    case 'create-company': {
      need(1);
      console.log(JSON.stringify(await p.createCompany(args[0]!, args[1] ?? 'Asia/Kolkata')));
      break;
    }
    case 'create-user': {
      need(4);
      if (!['admin', 'member', 'operator'].includes(args[3]!)) usage();
      const u = await p.createUser(args[0]!, { name: args[1]!, email: args[2]!, role: args[3] as 'admin' });
      // Shown once: only its hash is stored.
      console.log(JSON.stringify({ user_id: u.id, token: u.token, note: 'shown once; only a hash is stored' }));
      break;
    }
    case 'install': {
      need(2);
      await p.installApp(args[0]!, args[1]!); // installed_by is a user id; an operator install has none
      console.log(JSON.stringify({ installed: args[1], company_id: args[0] }));
      break;
    }
    case 'rotate-service-secret': {
      need(1);
      await p.rotateServiceSecret(args[0]!, secret());
      console.log(JSON.stringify({ rotated: args[0], previous_valid_for: '24h' }));
      break;
    }
    case 'uninstall': {
      need(2);
      const [companyId, app] = args as [string, string];
      if (!apps[app]) throw new Error(`unknown app: ${app}`);
      const install = (await p.db.query<{ status: string }>('select status from neos.installs where company_id = $1 and app_key = $2', [companyId, app])).rows[0];
      if (!install) throw new Error(`${app} was never installed for company ${companyId}`);
      const admin = purge ? adminUrlFromEnv() : null;
      if (!yes) {
        const would = admin ? await purgeCompany(admin, app, companyId, { dryRun: true }) : null;
        console.log(JSON.stringify({ dry_run: true, company_id: companyId, app, install_status: install.status, would: { mark: 'removed', purge: would && { counts: would.counts, total: would.total } } }, null, 2));
        console.error('dry run: nothing changed. Re-run with --yes' + (purge ? ' (a backup is taken before any row is deleted).' : '.'));
        break;
      }
      await p.uninstallApp(companyId, app, 'operator:ops');
      const out: Record<string, unknown> = { company_id: companyId, app, install_status: 'removed', previous: install.status };
      if (admin) {
        // Backup first: that company's rows (restorable alone), and the whole schema when pg_dump is here.
        const dir = path.join(backupDir ?? process.env.NEOS_BACKUP_DIR ?? '/backups', 'uninstall', `${backupStamp(new Date())}-${app}-${companyId}`);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const dump = await exportCompany(admin, app, companyId);
        const file = path.join(dir, `${app}-${companyId}.json`);
        await writeFile(file, JSON.stringify(dump), { mode: 0o600 });
        let schemaDump: string | null = null;
        try {
          const m = await nightlyBackup({ adminUrl: admin, dir, keep: 1, schemas: [app] });
          schemaDump = path.join(dir, m.stamp, m.schemas[0]!.file);
        } catch (e) {
          console.error(`no schema dump (${(e as Error).message.slice(0, 120)}); the company export is the backup`);
        }
        const purged = await purgeCompany(admin, app, companyId, { dryRun: false });
        let files: string | null = null;
        if (process.env.NEOP_DOCUMENTS_DIR && /^[0-9a-f-]{36}$/i.test(companyId)) {
          files = path.join(process.env.NEOP_DOCUMENTS_DIR, app, companyId.toLowerCase());
          await rm(files, { recursive: true, force: true });
        }
        await p.audit({ company_id: companyId, actor: 'operator:ops', app_key: app, action: 'app.purge', outcome: String(purged.total), detail: { counts: purged.counts, backup: file, schema_dump: schemaDump, files_removed: files } });
        Object.assign(out, { backup: { company_export: file, schema_dump: schemaDump }, purged: { counts: purged.counts, total: purged.total }, files_removed: files ?? 'kept files are on the backend volume: remove <NEOP_DOCUMENTS_DIR>/' + `${app}/${companyId}` });
      }
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    default:
      usage();
  }
} finally {
  await p.stop();
}
