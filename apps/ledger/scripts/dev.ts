// One-command local Ledger pilot: migrates, seeds a demo company, and starts the
// platform (:4700), the Ledger backend (files :4701, gate :4702) and the agent
// pool (:4703) in one process (base port: NEOP_DEV_PORT_BASE).
//   NEOP_LLM_UPSTREAM_KEY=sk-ant-...  keyless agent through the platform LLM proxy (recommended)
//   NEOP_LLM_VIRTUAL_KEY=...          direct model access from the agent (quick local only)
//   (nep-gst is built into Ledger: apps/ledger/src/packages, installed with scripts/neos-install.ts)
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminUrlFromEnv, roleUrl } from '@neop/pgkit';
import { hashSecret, loadOrCreateSigningKeys, migratePlatform, neuralChatConfigFromEnv, startPlatform } from '@neop/platform';
import { doorSecretPaths, FileSecretStore, generateLlmSigningKey, migrateApp, presenceConfigFromEnv, startBackend } from '@neop/template';
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

const keys = await loadOrCreateSigningKeys(path.join(varDir, 'platform-signing-key.json'));
// v3 (S8): the runner mints its assistants' LLM session tokens with this key; the proxy trusts its public half.
const llmKeyFile = path.join(varDir, 'ledger-llm-signing-key.json');
const llmKey = await readFile(llmKeyFile, 'utf8').then(JSON.parse).catch(async () => {
  const k = await generateLlmSigningKey('llm-ledger');
  await writeFile(llmKeyFile, JSON.stringify(k), { mode: 0o600 });
  return k;
});
// Door credentials (v3 §12): the secret store, one file per (company, door), read by the backend per call.
const doorsDir = path.join(varDir, 'doors');
const plat = await startPlatform({
  dbUrl: roleUrl(adminUrl, 'neos_app'),
  keys,
  neuralchat: neuralChatConfigFromEnv(process.env),
  registryKeys: await loadOrCreateSigningKeys(path.join(varDir, 'registry-key.json')),
  llm: upstreamKey ? { upstream: { baseUrl: process.env.NEOP_LLM_UPSTREAM_URL ?? 'https://api.anthropic.com', apiKey: upstreamKey }, runnerKeys: { ledger: [llmKey.publicJwk] } } : undefined,
  port: BASE,
  log,
});
const p = plat.platform;

const worker = await startAgentWorker({
  poolSize: 5,
  model: upstreamKey ? proxyModel() : modelFromEnv(),
  port: BASE + 3,
  allowedGates: [`http://127.0.0.1:${BASE + 2}`],
  onEnd: (j, r) => log(`session ${j.slice(0, 8)} ended: ${r}`),
});
const backend = await startBackend(
  app,
  {
    appDbUrl: roleUrl(adminUrl, 'ledger_app'),
    runnerDbUrl: roleUrl(adminUrl, 'ledger_runner'),
    jobTokenSecret: await persistent('ledger-job-token-secret'),
    agentUrl: `http://127.0.0.1:${worker.port}`,
    gateUrl: `http://127.0.0.1:${BASE + 2}`,
    poolSize: 5,
    runnerId: 'dev-runner',
    secrets: new FileSecretStore({ root: doorsDir, app: 'ledger' }),
    llm: upstreamKey ? { proxyUrl: `${plat.url}/llm`, signingKey: llmKey.privateJwk } : undefined,
    presence: presenceConfigFromEnv(process.env),
    files: { publicUrl: process.env.NEOP_FILES_PUBLIC_URL ?? `http://127.0.0.1:${BASE + 1}` },
    log,
  },
  { filesPort: BASE + 1, gatePort: BASE + 2 },
);
await p.registerApp({ key: 'ledger', manifest, blocks: app.blocks });

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
for (const [door, secret] of [
  ['email', { provider: 'dev-mailbox', dir: path.join(varDir, 'mailbox') }],
  ['gst_portal', { provider: 'dev-file', dir: path.join(varDir, 'gst-portal') }],
] as const) {
  const f = doorSecretPaths(doorsDir, co.id, 'ledger', door).company;
  await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  if (!(await readFile(f, 'utf8').catch(() => null))) await writeFile(f, JSON.stringify(secret), { mode: 0o600 });
}
const seeded = await seedLedger(backend.core.appPool, co.id);
// v3 S7: the GST package is installed into Ledger at build time (apps/ledger/src/packages/nep-gst, pinned in
// packages.lock.json); its migrations ran above with Ledger's own. GSTR-3B needs a GSP credential (provider 'gsp').
if (manifest.packages?.some((x) => x.key === 'nep-gst')) {
  log(`nep-gst is built into Ledger (connect a GSP: write ${path.join(doorsDir, co.id, 'gst_portal.json')}, see docs/RUNBOOK.md)`);
}
console.log(`
NEOP pilot is up.
  Desk + ask:   ${plat.url}/        (token: dev_admin, or dev_member)
  Seeded:       ${seeded.entries} new journal entries for Acme Traders (Jul–Sep 2026)
  Sent email:   ${path.join(varDir, 'mailbox')}
Model:        ${upstreamKey ? "keyless agent via the LLM proxy (metered, capped)" : "direct key (dev only)"}
Try: "File the September GST return"  ·  "What was our net profit in August 2026?"  ·  "Email the September close pack to cfo@acme.example"
`);
