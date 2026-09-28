// Generate every file deploy/compose.pilot.yml reads from deploy/secrets/, consistently
// (each role's password matches the URL that role connects with). Never overwrites:
// an existing file is kept, so re-running only fills gaps. Rotation is deliberate, not this.
//   tsx scripts/gen-secrets.ts [dir=deploy/secrets] [apps=ledger] [--db-host postgres] [--db-port 5432]
//                              [--dedicated <app>=<host>[:<port>]]...
// --db-host/--db-port (or NEOS_DB_HOST/NEOS_DB_PORT): where the shared cluster lives.
// --dedicated (or NEOS_DEDICATED_DB="ledger=pg-ledger:5432,…"): D2's dedicated-DB tier. That app's
//   roles, its direct URLs, its PgBouncer entry and its own admin URL (pg_admin_url_<app>, read by the
//   migrate runner as NEOS_ADMIN_URL_<APP>) point at its own cluster. Everything else stays shared.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const positional: string[] = [];
const flags: Record<string, string[]> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    (flags[k] ??= []).push(v);
  } else positional.push(a);
}
const flag = (k: string, envName: string, fallback: string) => flags[k]?.at(-1) || process.env[envName] || fallback;

const dir = path.resolve(positional[0] ?? 'deploy/secrets');
const apps = (positional[1] ?? 'ledger').split(',').map((s) => s.trim()).filter(Boolean);
const db = { host: flag('db-host', 'NEOS_DB_HOST', 'postgres'), port: Number(flag('db-port', 'NEOS_DB_PORT', '5432')), name: 'neos' };
const dedicated = new Map<string, { host: string; port: number }>();
for (const spec of [...(flags.dedicated ?? []), ...(process.env.NEOS_DEDICATED_DB ?? '').split(',')].map((s) => s.trim()).filter(Boolean)) {
  const m = /^([a-z][a-z0-9_]*)=([\w.-]+)(?::(\d+))?$/.exec(spec);
  if (!m) throw new Error(`--dedicated ${spec}: expected <app>=<host>[:<port>]`);
  if (!apps.includes(m[1]!)) throw new Error(`--dedicated ${m[1]}: not one of the apps (${apps.join(', ')})`);
  dedicated.set(m[1]!, { host: m[2]!, port: Number(m[3] ?? 5432) });
}
mkdirSync(dir, { recursive: true, mode: 0o700 });

const made: string[] = [];
const kept: string[] = [];
function put(name: string, make: () => string): string {
  const f = path.join(dir, name);
  if (existsSync(f)) {
    kept.push(name);
    return readFileSync(f, 'utf8').trim();
  }
  const v = make();
  writeFileSync(f, v + '\n', { mode: 0o600 });
  made.push(name);
  return v;
}
const random = (n = 32) => randomBytes(n).toString('base64url');
const where = (family: string) => dedicated.get(family) ?? db;
const url = (family: string, user: string, pw: string) => `postgres://${user}:${encodeURIComponent(pw)}@${where(family).host}:${where(family).port}/${db.name}`;
// Query pools go through PgBouncer (transaction mode); LISTEN and advisory locks go direct (S8).
// A dedicated app gets its own PgBouncer database entry (neos_<app>) pointing at its cluster.
const pgbDb = (family: string) => (dedicated.has(family) ? `${db.name}_${family}` : db.name);
const pooled = (family: string, user: string, pw: string) => `postgres://${user}:${encodeURIComponent(pw)}@pgbouncer:6432/${pgbDb(family)}`;
const userlist: string[] = [];
const runnerKeys: Record<string, unknown[]> = {};

const adminPw = put('pg_admin', random);
put('pg_admin_url', () => url('neos', 'neos_admin', adminPw));
for (const app of dedicated.keys()) {
  const pw = put(`pg_admin_${app}`, random);
  put(`pg_admin_url_${app}`, () => url(app, 'neos_admin', pw));
}

for (const family of ['neos', ...apps]) {
  const pw: Record<string, string> = {};
  for (const r of ['migrator', 'app', 'runner']) pw[r] = put(`pw_${family}_${r}`, random);
  put(`${family}_app_url`, () => pooled(family, `${family}_app`, pw.app!));
  userlist.push(`"${family}_app" "${pw.app}"`);
  if (family !== 'neos') {
    put(`${family}_runner_url`, () => pooled(family, `${family}_runner`, pw.runner!));
    put(`${family}_direct_url`, () => url(family, `${family}_runner`, pw.runner!));
    userlist.push(`"${family}_runner" "${pw.runner}"`);
    put(`${family}_service_secret`, () => random(32));
    put(`${family}_job_token_secret`, () => random(32));
    put(`${family}_pkg_pw_key`, () => random(32));
    // v3 (S8): the runner signs its assistants' LLM session tokens itself. Private half: this app's backend only.
    const jwk = JSON.parse(
      put(`${family}_llm_signing_key`, () => {
        const { privateKey } = generateKeyPairSync('ed25519');
        return JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: `llm-${family}-${random(6)}`, alg: 'EdDSA' });
      }),
    );
    const pub = createPublicKey(createPrivateKey({ key: jwk, format: 'jwk' })).export({ format: 'jwk' });
    runnerKeys[family] = [{ ...pub, kid: jwk.kid, alg: 'EdDSA' }];
  }
}
// The public halves, for the LLM proxy only. Derived from the private keys above, so it is rewritten whenever it
// does not match them (an app added, a key rotated by deleting its file); it holds nothing secret.
{
  const f = path.join(dir, 'llm_runner_keys');
  const v = JSON.stringify(runnerKeys);
  const cur = existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
  if (cur !== v) {
    writeFileSync(f, v + '\n', { mode: 0o600 });
    made.push('llm_runner_keys');
  } else kept.push('llm_runner_keys');
}
// Door credentials (v3 §12) live under doors/<company>/[<app>/]<door>.json, written by `scripts/deploy.sh door set`.
mkdirSync(path.join(dir, 'doors'), { recursive: true, mode: 0o700 });
put('vault_keys', () => JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }));
put('metrics_token', () => random(24));
put('backup_doors_key', () => randomBytes(32).toString('base64')); // seals the doors/ copy in each nightly backup
put('grafana_admin', () => random(18)); // observability profile: Grafana's admin password
put('pgbouncer_userlist', () => userlist.join('\n'));
put('pgbouncer_ini', () =>
  [
    '[databases]',
    `${db.name} = host=${db.host} port=${db.port} dbname=${db.name}`,
    ...[...dedicated].map(([app, d]) => `${pgbDb(app)} = host=${d.host} port=${d.port} dbname=${db.name}`),
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction',
    'max_client_conn = 1000',
    'default_pool_size = 20',
    // Timeouts are role defaults (pgkit bootstrapFamily); the per-connection copies are ignored here.
    'ignore_startup_parameters = extra_float_digits,statement_timeout,lock_timeout,idle_in_transaction_session_timeout,options',
  ].join('\n'),
);

console.log(JSON.stringify({ dir, db: `${db.host}:${db.port}`, dedicated: Object.fromEntries([...dedicated].map(([a, d]) => [a, `${d.host}:${d.port}`])), created: made, kept }, null, 2));
if (kept.length && (flags['db-host'] || flags['db-port'] || dedicated.size)) {
  console.log('\nNote: existing files were kept as they are. To move a database, delete the URL files (and pgbouncer_ini) it should rewrite first.');
}
if (!existsSync(path.join(dir, 'llm_upstream_key'))) {
  console.log(`\nStill needed: put the model provider key in ${path.join(dir, 'llm_upstream_key')} (only the LLM proxy reads it).`);
}
