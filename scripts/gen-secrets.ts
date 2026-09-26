// Generate every file deploy/compose.pilot.yml reads from deploy/secrets/, consistently
// (each role's password matches the URL that role connects with). Never overwrites:
// an existing file is kept, so re-running only fills gaps. Rotation is deliberate, not this.
//   tsx scripts/gen-secrets.ts [dir=deploy/secrets] [apps=ledger]
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'deploy/secrets');
const apps = (process.argv[3] ?? 'ledger').split(',').map((s) => s.trim()).filter(Boolean);
const db = { host: 'postgres', port: 5432, name: 'neos' };
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
const url = (user: string, pw: string) => `postgres://${user}:${encodeURIComponent(pw)}@${db.host}:${db.port}/${db.name}`;

const adminPw = put('pg_admin', random);
put('pg_admin_url', () => url('neos_admin', adminPw));

for (const family of ['neos', ...apps]) {
  const pw: Record<string, string> = {};
  for (const r of ['migrator', 'app', 'runner']) pw[r] = put(`pw_${family}_${r}`, random);
  put(`${family}_app_url`, () => url(`${family}_app`, pw.app!));
  if (family !== 'neos') {
    put(`${family}_runner_url`, () => url(`${family}_runner`, pw.runner!));
    put(`${family}_service_secret`, () => random(32));
    put(`${family}_job_token_secret`, () => random(32));
    put(`${family}_pkg_pw_key`, () => random(32));
  }
}
put('vault_keys', () => JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }));
put('metrics_token', () => random(24));

console.log(JSON.stringify({ dir, created: made, kept }, null, 2));
if (!existsSync(path.join(dir, 'llm_upstream_key'))) {
  console.log(`\nStill needed: put the model provider key in ${path.join(dir, 'llm_upstream_key')} (only the LLM proxy reads it).`);
}
