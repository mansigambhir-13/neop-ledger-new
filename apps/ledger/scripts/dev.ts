// One-command local Ledger pilot: migrates, seeds a demo company, and starts the
// platform (:4700), the Ledger backend (L3 :4701, gate :4702) and the agent
// pool (:4703) in one process (base port: NEOP_DEV_PORT_BASE).
//   NEOP_LLM_UPSTREAM_KEY=sk-ant-...  keyless agent through the platform LLM proxy (recommended)
//   NEOP_LLM_VIRTUAL_KEY=...          direct model access from the agent (quick local only)
//   NEOP_DEV_PACKAGES=nep-gst         publish, review, install and migrate the GST package
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminUrlFromEnv, roleUrl } from '@neop/pgkit';
import { hashSecret, loadOrCreateSigningKeys, migratePlatform, startPlatform, VaultCipher } from '@neop/platform';
import { buildPackage, migrateApp, migratePackage, startBackend } from '@neop/template';
import { modelFromEnv, proxyModel, startAgentWorker } from '@neop/template/agent';
import { ledgerApp, LEDGER_ROOT, manifest, seedLedger } from '../src/index.ts';

const root = path.resolve(LEDGER_ROOT, '../..');
const varDir = path.join(root, 'var');
await mkdir(varDir, { recursive: true });
const adminUrl = adminUrlFromEnv();
const log = (m: string, e?: unknown) => console.log(m, e ?? '');
const BASE = Number(process.env.NEOP_DEV_PORT_BASE ?? 4700);

const upstreamKey = process.env.NEOP_LLM_UPSTREAM_KEY;
if (!upstreamKey && !process.env.NEOP_LLM_VIRTUAL_KEY) {
  console.error('Set NEOP_LLM_UPSTREAM_KEY (keyless agent via the LLM proxy) or NEOP_LLM_VIRTUAL_KEY (direct).');
  process.exit(1);
}

async function persistent(name: string): Promise<string> {
  const f = path.join(varDir, name);
  const v = await readFile(f, 'utf8').catch(() => null);
  if (v) return v.trim();
  const s = randomBytes(32).toString('hex');
  await writeFile(f, s, { mode: 0o600 });
  return s;
}

await migratePlatform(adminUrl, log);
const app = await ledgerApp();
await migrateApp(adminUrl, app, log);

const keys = await loadOrCreateSigningKeys(path.join(varDir, 'gateway-key.json'));
const vaultFile = path.join(varDir, 'vault-keys.json');
const vaultKeys = await readFile(vaultFile, 'utf8').then(JSON.parse).catch(async () => {
  const k = VaultCipher.generate();
  await writeFile(vaultFile, JSON.stringify(k), { mode: 0o600 });
  return k;
});
const plat = await startPlatform({
  dbUrl: roleUrl(adminUrl, 'neos_app'),
  keys,
  vaultKeys,
  registryKeys: await loadOrCreateSigningKeys(path.join(varDir, 'registry-key.json')),
  llm: upstreamKey ? { upstream: { baseUrl: process.env.NEOP_LLM_UPSTREAM_URL ?? 'https://api.anthropic.com', apiKey: upstreamKey } } : undefined,
  port: BASE,
  log,
});
const p = plat.platform;
await p.rekeyVault();

const worker = await startAgentWorker({
  poolSize: 5,
  model: upstreamKey ? proxyModel() : modelFromEnv(),
  port: BASE + 3,
  allowedGates: [`http://127.0.0.1:${BASE + 2}`],
  onEnd: (j, r) => log(`session ${j.slice(0, 8)} ended: ${r}`),
});
const serviceSecret = await persistent('ledger-service-secret');
const backend = await startBackend(
  app,
  {
    appDbUrl: roleUrl(adminUrl, 'ledger_app'),
    runnerDbUrl: roleUrl(adminUrl, 'ledger_runner'),
    platformUrl: plat.url,
    serviceSecret,
    jobTokenSecret: await persistent('ledger-job-token-secret'),
    agentUrl: `http://127.0.0.1:${worker.port}`,
    gateUrl: `http://127.0.0.1:${BASE + 2}`,
    poolSize: 5,
    runnerId: 'dev-runner',
    log,
  },
  { l3Port: BASE + 1, gatePort: BASE + 2 },
);
await p.registerApp({ key: 'ledger', l3_url: `http://127.0.0.1:${backend.ports.l3}`, manifest, service_secret: serviceSecret });

// Demo company (idempotent).
let co = (await p.db.query<{ id: string }>("select id from neos.companies where name = 'Acme Traders'")).rows[0];
if (!co) {
  co = await p.createCompany('Acme Traders', 'Asia/Kolkata');
  await p.createUser(co.id, { name: 'Priya (admin)', email: 'priya@acme.example', role: 'admin', token: 'dev_admin' });
  await p.createUser(co.id, { name: 'Rahul (member)', email: 'rahul@acme.example', role: 'member', token: 'dev_member' });
}
if (!(await p.db.query("select 1 from neos.users where token_hash = $1", [hashSecret('dev_operator')])).rowCount) {
  await p.createUser(co.id, { name: 'Ops (operator)', email: 'ops@neos.example', role: 'operator', token: 'dev_operator' });
}
await p.installApp(co.id, 'ledger');
await p.setVaultSecret(co.id, 'email', { provider: 'dev-mailbox', dir: path.join(varDir, 'mailbox') });
await p.setVaultSecret(co.id, 'gst_portal', { provider: 'dev-file', dir: path.join(varDir, 'gst-portal') });
const seeded = await seedLedger(backend.core.appPool, co.id);

// Optional: the GST package, end to end (operator review -> admin install -> migration runner).
if ((process.env.NEOP_DEV_PACKAGES ?? '').split(',').includes('nep-gst')) {
  const entry = (await p.db.query("select status from neos.registry_entries where key = 'nep-gst' and version = '1.0.0'")).rows[0];
  if (!entry) await p.registry.submit('user:dev', { kind: 'package', key: 'nep-gst', version: '1.0.0', bundle: await buildPackage(path.join(root, 'registry', 'nep-gst')) });
  const pending = (await p.db.query("select id, fingerprint from neos.registry_reviews where key = 'nep-gst' and version = '1.0.0' and status = 'PENDING'")).rows[0];
  if (pending) {
    const op = (await p.db.query("select id from neos.users where token_hash = $1", [hashSecret('dev_operator')])).rows[0];
    await p.registry.review({ id: op.id, role: 'operator' }, pending.id, { decision: 'yes', fingerprint_seen: pending.fingerprint });
  }
  const admin = (await p.db.query("select id, company_id from neos.users where token_hash = $1", [hashSecret('dev_admin')])).rows[0];
  await p.registry.install({ ...admin, role: 'admin' }, { host_app: 'ledger', entry_key: 'nep-gst' });
  for (const pk of await p.pendingPackageMigrations()) {
    await migratePackage(adminUrl, pk.host_app, pk.bundle);
    await p.markPackageMigrated(pk.host_app, pk.entry_key, pk.version);
  }
  log('nep-gst installed for Acme Traders');
}

console.log(`
NEOP pilot is up.
  Desk + ask:   ${plat.url}/        (token: dev_admin, or dev_member)
  Seeded:       ${seeded.entries} new journal entries for Acme Traders (Jul–Sep 2026)
  Sent email:   ${path.join(varDir, 'mailbox')}
Model:        ${upstreamKey ? "keyless agent via the LLM proxy (metered, capped)" : "direct key (dev only)"}
Try: "File the September GST return"  ·  "What was our net profit in August 2026?"  ·  "Email the September close pack to cfo@acme.example"
`);
