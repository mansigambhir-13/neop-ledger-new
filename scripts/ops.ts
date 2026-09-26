// Operator CLI · the bootstrap steps with no HTTP route (there is no admin yet to call one).
// Runs where the platform's database role is reachable (the platform container).
//   tsx scripts/ops.ts register-app ledger http://ledger-backend:4101   (secret: NEOP_SERVICE_SECRET[_FILE])
//   tsx scripts/ops.ts create-company "Acme Traders" [Asia/Kolkata]
//   tsx scripts/ops.ts create-user <company_id> <name> <email> <admin|member|operator>
//   tsx scripts/ops.ts install <company_id> <app>
//   tsx scripts/ops.ts rotate-service-secret <app>                     (new secret: NEOP_SERVICE_SECRET[_FILE])
import { generateSigningKeys, Platform } from '@neop/platform';
import { env } from '../apps/ledger/scripts/env.ts';

const apps: Record<string, () => Promise<{ manifest: any }>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};

const [cmd, ...args] = process.argv.slice(2);
const usage = () => {
  console.error('usage: ops.ts register-app <app> <l3_url> | create-company <name> [tz] | create-user <company_id> <name> <email> <role> | install <company_id> <app> | rotate-service-secret <app>');
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
      need(2);
      const load = apps[args[0]!];
      if (!load) throw new Error(`unknown app: ${args[0]}`);
      await p.registerApp({ key: args[0]!, l3_url: args[1]!, manifest: (await load()).manifest, service_secret: secret() });
      console.log(JSON.stringify({ registered: args[0], l3_url: args[1] }));
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
    default:
      usage();
  }
} finally {
  await p.stop();
}
