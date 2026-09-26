// Operator CLI · the bootstrap steps with no HTTP route (there is no admin yet to call one),
// plus operator actions on a running platform.
// Runs where the platform's database role is reachable (the platform container).
//   tsx scripts/ops.ts register-app ledger http://ledger-l3:4101 --conformance conformance/ledger.json [--author-key author.pub.jwk]
//                                                                        (secret: NEOP_SERVICE_SECRET[_FILE]; production refuses without a green attestation)
//   tsx scripts/ops.ts create-company "Acme Traders" [Asia/Kolkata]
//   tsx scripts/ops.ts create-user <company_id> <name> <email> <admin|member|operator>
//   tsx scripts/ops.ts install <company_id> <app>
//   tsx scripts/ops.ts rotate-service-secret <app>                     (new secret: NEOP_SERVICE_SECRET[_FILE])
// Gateway signing keys (R10), through the running platform (it holds the keyring); NEOS_PLATFORM_URL + NEOS_OPERATOR_TOKEN[_FILE]:
//   tsx scripts/ops.ts keys-status
//   tsx scripts/ops.ts keys-rotate [activate_after_ms]                  (publish now; activation is stored and survives restarts)
//   tsx scripts/ops.ts keys-retire-previous [--force]                   (after 2× token TTL)
// Registry (needs NEOS_ADMIN_URL[_FILE], the migration runner's connection):
//   tsx scripts/ops.ts drop-package-tables <operator_user_id> <host_app> <package_key>   (audited; refused while installed anywhere)
import { readFile } from 'node:fs/promises';
import { generateSigningKeys, Platform } from '@neop/platform';
import { env } from '../apps/ledger/scripts/env.ts';

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
const conformanceFile = flag('--conformance');
const authorKeyFile = flag('--author-key');
const force = bool('--force');
const [cmd, ...args] = argv;
const usage = () => {
  console.error(
    'usage: ops.ts register-app <app> <l3_url> [--conformance <file>] [--author-key <jwk file>] | create-company <name> [tz] | create-user <company_id> <name> <email> <role> | install <company_id> <app> | rotate-service-secret <app> | keys-status | keys-rotate [ms] | keys-retire-previous [--force] | drop-package-tables <operator_id> <host> <package>',
  );
  process.exit(64);
};
const need = (n: number) => (args.length < n || args.slice(0, n).some((a) => !a) ? usage() : undefined);
const secret = () => {
  const s = env('NEOP_SERVICE_SECRET');
  if (s.length < 32) throw new Error('service secret must be at least 32 characters');
  return s;
};

/** Operator calls on the running platform (the process that holds the gateway keyring). */
async function operatorCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(env('NEOS_PLATFORM_URL', 'http://127.0.0.1:4700').replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${env('NEOS_OPERATOR_TOKEN')}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(out)}`);
  return out;
}

if (cmd === 'keys-status' || cmd === 'keys-rotate' || cmd === 'keys-retire-previous') {
  if (cmd === 'keys-status') console.log(JSON.stringify(await operatorCall('GET', '/api/ops/keys')));
  if (cmd === 'keys-rotate') console.log(JSON.stringify(await operatorCall('POST', '/api/ops/keys/rotate', { activate_after_ms: args[0] ? Number(args[0]) : 120_000 })));
  if (cmd === 'keys-retire-previous') console.log(JSON.stringify(await operatorCall('POST', '/api/ops/keys/retire-previous', { force })));
  process.exit(0);
}

const p = new Platform({ dbUrl: env('NEOS_DB_URL'), keys: await generateSigningKeys(), dbPoolSize: 2 });
try {
  switch (cmd) {
    case 'register-app': {
      need(2);
      const load = apps[args[0]!];
      if (!load) throw new Error(`unknown app: ${args[0]}`);
      const def = await load();
      const conformance = conformanceFile ? JSON.parse(await readFile(conformanceFile, 'utf8')) : undefined;
      const author_public_key = authorKeyFile ? JSON.parse(await readFile(authorKeyFile, 'utf8')) : undefined;
      await p.registerApp({ key: args[0]!, l3_url: args[1]!, manifest: def.manifest, service_secret: secret(), blocks: def.blocks, conformance, author_public_key });
      console.log(JSON.stringify({ registered: args[0], l3_url: args[1], blocks: Object.keys(def.blocks ?? {}).length, attested: !!conformance, author_key: !!author_public_key }));
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
    case 'drop-package-tables': {
      need(3);
      const op = (await p.db.query<{ id: string; role: string }>('select id, role from neos.users where id = $1', [args[0]])).rows[0];
      if (!op) throw new Error('no such user');
      const reg = await p.ensureRegistry();
      console.log(JSON.stringify(await reg.dropPackageTables(env('NEOS_ADMIN_URL'), op, args[1]!, args[2]!)));
      break;
    }
    default:
      usage();
  }
} finally {
  await p.stop();
}
