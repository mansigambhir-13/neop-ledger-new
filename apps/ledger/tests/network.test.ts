// network.test · the deploy topology keeps every model away from data and keys.
// Static check of deploy/compose.pilot.yml; the runtime probe (scripts/netcheck.sh: containers
// up, the agent cannot open a socket to Postgres, the platform or the internet; the egress proxy
// passes allowed hosts and refuses others) runs against built images in CI (job `netcheck`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LEDGER_ROOT } from '../src/index.ts';

const ROOT = path.join(LEDGER_ROOT, '../..');
const compose = parse(readFileSync(path.join(ROOT, 'deploy/compose.pilot.yml'), 'utf8'), { merge: true });
const raw = compose.services as Record<string, { networks: string[] | Record<string, unknown>; environment?: Record<string, string>; secrets?: string[] }>;
// Networks may be a list or a map (with per-network aliases); compare by name.
const svc = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { ...v, networks: Array.isArray(v.networks) ? v.networks : Object.keys(v.networks ?? {}) }])) as Record<string, { networks: string[]; environment?: Record<string, string>; secrets?: string[]; profiles?: string[] }>;
const envKeys = (s: string) => Object.keys(svc[s]!.environment ?? {}).join(' ') + ' ' + (svc[s]!.secrets ?? []).join(' ');
const agents = Object.keys(svc).filter((k) => k.endsWith('-agent'));
const backends = Object.keys(svc).filter((k) => k.endsWith('-backend'));
const members = (net: string) => Object.entries(svc).filter(([, s]) => s.networks.includes(net)).map(([k]) => k).sort();

describe('network policy', () => {
  it('there is an agent per app, each on internal networks only, never with the DB, the platform, chat or the internet', () => {
    expect(agents.sort()).toEqual(['ledger-agent']);
    for (const a of agents) {
      for (const n of svc[a]!.networks) expect(compose.networks[n].internal, `${a} on ${n}`).toBe(true);
      for (const bad of ['db', 'l3', 'ctl', 'chat', 'egress', 'outbound', 'edge', 'telemetry', 'obs']) expect(svc[a]!.networks).not.toContain(bad);
    }
  });

  it('each agent reaches only its own backend', () => {
    for (const a of agents) {
      const app = a.replace('-agent', '');
      const agentNets = svc[a]!.networks.filter((n) => n.startsWith('agent-'));
      expect(agentNets).toEqual([`agent-${app}`]);
      expect(members(`agent-${app}`)).toEqual([`${app}-agent`, `${app}-backend`].sort());
    }
  });

  it('agents hold no database credential, service secret, job-token secret or provider key', () => {
    for (const a of agents) expect(envKeys(a)).not.toMatch(/DB_URL|SERVICE_SECRET|JOB_TOKEN|app_url|runner_url|UPSTREAM|VIRTUAL_KEY|llm_upstream/i);
  });

  it('backends hold no model key; only the LLM proxy holds the provider key', () => {
    // v3 (S8): a backend's only LLM settings are where the proxy is and its runner's session-signing key.
    for (const b of backends) {
      const llmKeys = envKeys(b).split(' ').filter((k) => /LLM|llm/.test(k)).sort();
      const app = b.replace('-backend', '');
      expect(llmKeys, b).toEqual(['NEOP_LLM_PROXY_URL', 'NEOP_LLM_SIGNING_KEY_FILE', `${app}_llm_signing_key`].sort());
      expect(envKeys(b)).not.toMatch(/UPSTREAM|llm_upstream|VIRTUAL_KEY|llm_runner_keys/);
    }
    const holders = Object.keys(svc).filter((k) => /llm_upstream_key/.test(envKeys(k)));
    expect(holders).toEqual(['llm-proxy']);
    // The signing keys stay with their backends; the proxy holds only the public halves.
    expect(Object.keys(svc).filter((k) => /_llm_signing_key/.test(envKeys(k))).sort()).toEqual(backends.sort());
    expect(Object.keys(svc).filter((k) => /llm_runner_keys/.test(envKeys(k)))).toEqual(['llm-proxy']);
    expect(svc['llm-proxy']!.environment).toMatchObject({ NEOP_LLM_RUNNER_KEYS_FILE: '/run/secrets/llm_runner_keys' });
  });

  it('door credentials (v3 §12): the secret store is mounted read-only into the backend only — never an agent, never web', () => {
    const mounts = (s: string) => (((raw as any)[s].volumes ?? []) as string[]).filter((v) => /\/doors(:|$)/.test(v));
    for (const b of backends) {
      expect(mounts(b), b).toEqual(['${NEOS_SECRETS_DIR:-./secrets}/doors:/run/secrets/doors:ro']);
      expect(svc[b]!.environment).toMatchObject({ NEOP_DOOR_SECRETS_DIR: '/run/secrets/doors' });
    }
    for (const a of agents) {
      expect(mounts(a), a).toEqual([]);
      expect(JSON.stringify((raw as any)[a]), a).not.toMatch(/doors|DOOR_SECRETS/);
    }
    for (const s of ['web', 'platform', 'llm-proxy', 'egress-proxy', 'grafana', 'prometheus']) expect(mounts(s), s).toEqual([]);
    // Only the nightly backup also reads it (read-only), and seals what it copies with its own key.
    const holders = Object.keys(raw).filter((k) => mounts(k).length).sort();
    expect(holders).toEqual(['backup', ...backends].sort());
    expect(mounts('backup')).toEqual(['${NEOS_SECRETS_DIR:-./secrets}/doors:/run/secrets/doors:ro']);
    expect(svc.backup!.environment).toMatchObject({ NEOS_BACKUP_DOORS_DIR: '/run/secrets/doors', NEOS_BACKUP_DOORS_KEY_FILE: '/run/secrets/backup_doors_key' });
    // v3 S9 removed the service-secret vault entirely.
    expect(Object.keys(svc).filter((k) => /vault_keys|VAULT/.test(envKeys(k)))).toEqual([]);
  });

  it('the llm network joins agents and the proxy only; files and Matrix have explicit owners; L3/ctl are gone', () => {
    expect(members('llm')).toEqual(['ledger-agent', 'llm-proxy']);
    expect(members('files')).toEqual(['ledger-backend', 'verify']);
    expect(members('chat')).toEqual(['platform', 'synapse']);
    expect(compose.networks.l3).toBeUndefined();
    expect(compose.networks.ctl).toBeUndefined();
  });

  it('only the egress proxy touches the internet; Matrix, LLM and door traffic go through it alone', () => {
    expect(members('egress')).toEqual(['egress-proxy']);
    expect(svc['egress-proxy']!.networks.sort()).toEqual(['egress', 'outbound']);
    expect(members('outbound')).toEqual(['egress-proxy', 'ledger-backend', 'llm-proxy', 'platform', 'verify']);
    expect(compose.networks.outbound.internal).toBe(true);
    for (const s of ['platform', 'llm-proxy', ...backends, 'verify']) {
      // Internal networks only: no route of their own to the internet.
      for (const n of svc[s]!.networks) expect(compose.networks[n].internal, `${s} on ${n}`).toBe(true);
      const env = svc[s]!.environment!;
      expect(env, s).toMatchObject({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://egress-proxy:3128', HTTPS_PROXY: 'http://egress-proxy:3128' });
      // Bypass only for names inside the stack.
      for (const h of env.NO_PROXY!.split(',')) expect(h, `${s} NO_PROXY`).toMatch(/^(localhost|127\.0\.0\.1|[a-z0-9-]+)$/);
    }
    // The allow-list: the model providers, Resend, and a configurable GSP; exact names, nothing else by default.
    const allow = String(svc['egress-proxy']!.environment!.NEOS_EGRESS_ALLOW);
    expect(allow.startsWith('api.anthropic.com,openrouter.ai,api.resend.com')).toBe(true);
    expect(allow).toContain('${NEOS_GSP_HOST:-}');
    const entry = readFileSync(path.join(ROOT, 'deploy/egress-proxy/entrypoint.sh'), 'utf8');
    expect(entry).toMatch(/FilterDefaultDeny Yes/);
    expect(entry).toMatch(/NEOS_EGRESS_PORTS:-443/); // tunnels to 443 only by default
    expect(svc.postgres!.networks).toEqual(['db']);
    expect(svc.pgbouncer!.networks).toEqual(['db']);
  });

  it('the console reaches only the platform, holds no credential, and every published port is loopback-only', () => {
    expect(members('web')).toEqual(['platform', 'web']);
    expect(svc.web!.networks.sort()).toEqual(['edge', 'web']);
    // The desk is a test harness: it only starts with the `test` profile.
    expect(svc.web!.profiles).toEqual(['test']);
    // … and it must not inherit the image's NEOS_ENV=production, or it refuses to start.
    expect(svc.web!.environment?.NEOS_ENV).toBe('test');
    expect(envKeys('web')).not.toMatch(/DB_URL|SECRET|TOKEN|KEY|app_url|runner_url/i);
    const published = Object.entries(svc).filter(([, s]: any) => s.ports?.length).map(([k]) => k).sort();
    expect(published).toEqual(['grafana', 'ledger-backend', 'platform', 'web']);
    // Loopback only; TLS and the outside world are the reverse proxy's job.
    for (const k of published) for (const p of (svc as any)[k].ports) expect(p, k).toMatch(/^127\.0\.0\.1:/);
  });

  it('signed files listen only on the files network, the gate only on the agent network, and runtime has no platform credential', () => {
    const b = (raw['ledger-backend']!.networks as any);
    expect(b.files.aliases).toEqual(['ledger-files']);
    expect(b['agent-ledger'].aliases).toEqual(['ledger-gate']);
    expect(svc['ledger-backend']!.environment).toMatchObject({ FILES_HOST: 'ledger-files', GATE_HOST: 'ledger-gate' });
    expect(envKeys('ledger-backend')).not.toMatch(/NEOS_PLATFORM_URL|SERVICE_SECRET/i);
    expect(svc.platform!.networks).not.toContain('files');
    expect((raw['ledger-agent']!.networks as any)['agent-ledger'].aliases).toEqual(['ledger-agent-rpc']);
    expect(svc['ledger-agent']!.environment).toMatchObject({ HOST: 'ledger-agent-rpc', NEOP_ALLOWED_GATE: 'http://ledger-gate:4102' });
  });

  it('query pools go through PgBouncer; only LISTEN and the execution lock connect direct (S8)', () => {
    const env = svc['ledger-backend']!.environment!;
    expect(env.NEOP_DIRECT_DB_URL_FILE).toBeTruthy();
    expect(svc['ledger-backend']!.secrets).toEqual(expect.arrayContaining(['ledger_app_url', 'ledger_runner_url', 'ledger_direct_url']));
    expect((svc as any).platform.depends_on).toHaveProperty('pgbouncer');
  });

  it('only the migration runner and the nightly backup hold the admin connection; backup sits on the db network only', () => {
    const holders = Object.keys(svc).filter((k) => /pg_admin_url|ADMIN_URL/.test(envKeys(k)));
    expect(holders.sort()).toEqual(['backup', 'migrate']);
    expect(svc.backup!.networks).toEqual(['db']);
    expect(compose.networks.db.internal).toBe(true);
    expect((raw as any).backup.command).toEqual(['tsx', 'scripts/backup.ts', 'schedule']);
    expect((raw as any).backup.volumes).toEqual(['backups:/backups', '${NEOS_SECRETS_DIR:-./secrets}/doors:/run/secrets/doors:ro']);
    expect(svc.backup!.environment).toMatchObject({ NEOS_ADMIN_URL_FILE: '/run/secrets/pg_admin_url', NEOS_BACKUP_DIR: '/backups', NEOS_BACKUP_COMPANIES: '1' });
    expect(readFileSync(path.join(ROOT, 'deploy/backup.Dockerfile'), 'utf8')).toMatch(/postgresql-client-17/);
  });

  it('observability: its own profile; the scraper never joins files, Grafana reaches only its data sources', () => {
    for (const s of ['otel-collector', 'jaeger', 'prometheus', 'grafana']) expect(svc[s]!.profiles, s).toEqual(['observability']);
    expect(members('files')).not.toContain('prometheus');
    expect(svc.prometheus!.networks.sort()).toEqual(['obs', 'telemetry']);
    expect(svc.grafana!.networks.sort()).toEqual(['edge', 'obs']);
    expect(members('obs')).toEqual(['grafana', 'jaeger', 'prometheus']);
    // The backend's metrics relay is bound to its telemetry alias only.
    expect((raw['ledger-backend']!.networks as any).telemetry.aliases).toEqual(['ledger-metrics']);
    expect(svc['ledger-backend']!.environment).toMatchObject({ METRICS_HOST: 'ledger-metrics' });
    const prom = parse(readFileSync(path.join(ROOT, 'deploy/observability/prometheus.yml'), 'utf8'));
    const targets = prom.scrape_configs.flatMap((j: any) => j.static_configs.flatMap((c: any) => c.targets)).sort();
    expect(targets).toEqual(['ledger-metrics:9464', 'platform:4000']);
    for (const j of prom.scrape_configs) expect(j.authorization.credentials_file).toBe('/run/secrets/metrics_token');
    expect(svc.prometheus!.secrets).toEqual(['metrics_token']);
    // Every file a service mounts from deploy/ exists.
    for (const [k, s] of Object.entries(raw) as any)
      for (const v of s.volumes ?? []) if (v.startsWith('./')) expect(statSync(path.join(ROOT, 'deploy', v.split(':')[0])).isFile(), `${k} ${v}`).toBe(true);
    const col = parse(readFileSync(path.join(ROOT, 'deploy/observability/otel-collector.yml'), 'utf8'));
    expect(col.service.pipelines.traces).toMatchObject({ receivers: ['otlp'], exporters: ['otlp/jaeger'] });
  });
});

describe('overlays', () => {
  // Compose merge tags retain their values in this static YAML view.
  const overlay = (f: string) => parse(readFileSync(path.join(ROOT, 'deploy', f), 'utf8').replace(/!(?:override|reset)\s+/g, ''), { merge: true }).services as Record<string, any>;

  it('the dedicated-DB overlay keeps the second cluster and its backup on the db network only', () => {
    const o = overlay('compose.dedicated-ledger.yml');
    expect(o['pg-ledger'].networks).toEqual(['db']);
    expect(o['backup-ledger'].networks).toEqual(['db']);
    expect(o.migrate.environment.NEOS_ADMIN_URL_LEDGER_FILE).toBe('/run/secrets/pg_admin_url_ledger');
    expect(o['pg-ledger'].ports).toBeUndefined();
  });

  it('the chaos overlay puts its fake provider outside the stack, reachable only through the egress proxy', () => {
    const o = overlay('compose.chaos.yml');
    expect(o.fakes.networks).toEqual(['egress']);
    expect(o['llm-proxy'].environment.NEOP_LLM_UPSTREAM_URL).toBe('http://fakes:4900');
    expect(o['egress-proxy'].environment.NEOS_EGRESS_ALLOW.split(',')).toContain('fakes');
    expect(o['llm-proxy'].networks).toBeUndefined(); // same internal-only networks as production
  });

  it('the production Matrix overlay gives NeuralChat and Ledger different accounts and token secrets', () => {
    const o = overlay('compose.presence-client.yml');
    expect(o.platform.environment).toMatchObject({ NEOS_NEURALCHAT_MATRIX: 'client', MATRIX_HOMESERVER_URL: '${MATRIX_HOMESERVER_URL:?set MATRIX_HOMESERVER_URL}' });
    expect(o['ledger-backend'].environment).toMatchObject({ NEOP_PRESENCE: 'client', NEOP_MATRIX_HOMESERVER_URL: '${MATRIX_HOMESERVER_URL:?set MATRIX_HOMESERVER_URL}' });
    expect(o.platform.environment.MATRIX_NEURALCHAT_ACCOUNTS).toContain('/run/secrets/matrix_neuralchat_token');
    expect(o['ledger-backend'].environment.NEOP_MATRIX_CLIENT_ACCOUNTS).toContain('/run/secrets/matrix_ledger_token');
    expect(o.platform.secrets).toContain('matrix_neuralchat_token');
    expect(o.platform.secrets).not.toContain('matrix_ledger_token');
    expect(o['ledger-backend'].secrets).toContain('matrix_ledger_token');
    expect(o['ledger-backend'].secrets).not.toContain('matrix_neuralchat_token');
  });

  it('the local Matrix overlay uses separate appservice registrations with non-overlapping token files', () => {
    const o = overlay('compose.chat.yml');
    expect(o.synapse.profiles).toEqual([]);
    expect(o.platform.environment).toMatchObject({ NEOS_NEURALCHAT_MATRIX: 'appservice', MATRIX_HS_TOKEN_FILE: '/run/secrets/matrix_hs_token', MATRIX_AS_TOKEN_FILE: '/run/secrets/matrix_as_token' });
    expect(o['ledger-backend'].environment).toMatchObject({ NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HS_TOKEN_FILE: '/run/secrets/matrix_ledger_hs_token', NEOP_MATRIX_AS_TOKEN_FILE: '/run/secrets/matrix_ledger_as_token' });
    expect(o.platform.secrets).not.toContain('matrix_ledger_hs_token');
    expect(o['ledger-backend'].secrets).not.toContain('matrix_hs_token');
    expect(o.verify.environment).toMatchObject({ NEOP_PRESENCE: 'appservice', NEOS_NEURALCHAT_MATRIX: 'appservice' });
    expect(o.verify.secrets).toEqual(['neos_app_url', 'ledger_runner_url']);
    const registration = parse(readFileSync(path.join(ROOT, 'deploy/appservice.ledger.yaml'), 'utf8'));
    const platformRegistration = parse(readFileSync(path.join(ROOT, 'deploy/appservice.yaml'), 'utf8'));
    expect(platformRegistration.namespaces.users).toEqual([{ exclusive: true, regex: '@neuralchat_.*' }]);
    expect(registration.namespaces.aliases).toEqual([
      { exclusive: true, regex: '#ledger-.*' },
      { exclusive: true, regex: '#neop-bus-.*' },
    ]);
    const setup = readFileSync(path.join(ROOT, 'scripts/matrix-setup.sh'), 'utf8');
    expect(setup).toContain('regex: "#ledger-.*"');
    expect(setup).toContain('regex: "#neop-bus-.*"');
  });
});

describe('dashboard and alerts', () => {
  // Every source file (not tests) under packages/ and apps/: where metric names are registered.
  const code = (() => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === 'tests' || n === 'load' || n.startsWith('.')) continue;
        const f = path.join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) out.push(readFileSync(f, 'utf8'));
      }
    };
    walk(path.join(ROOT, 'packages'));
    walk(path.join(ROOT, 'apps'));
    return out.join('\n');
  })();
  const registered = (name: string) => new RegExp(`['"\`]${name}['"\`]`).test(code);
  // Histograms are exported as <name>_bucket/_sum/_count; the code registers <name>.
  const base = (m: string) => m.replace(/_(bucket|sum|count)$/, '');
  const names = (exprs: string[]) => [...new Set(exprs.flatMap((e) => [...e.matchAll(/\bneop_[a-z0-9_]+/g)].map((m) => base(m[0]))))].sort();

  it('the dashboard parses, uses the provisioned Prometheus through its variable, and every metric exists in code', () => {
    const dash = JSON.parse(readFileSync(path.join(ROOT, 'deploy/observability/neop-dashboard.json'), 'utf8'));
    expect(dash.uid).toBe('neop-pilot');
    expect(dash.templating.list.find((v: any) => v.name === 'datasource')).toMatchObject({ type: 'datasource', query: 'prometheus' });
    const exprs = dash.panels.flatMap((p: any) => (p.targets ?? []).map((t: any) => t.expr as string));
    expect(exprs.length).toBe(dash.panels.length);
    const used = names(exprs);
    expect(used.length).toBeGreaterThan(8);
    expect(used.filter((n) => !registered(n)), 'dashboard metrics missing from code').toEqual([]);
  });

  it('the alert rules parse and every metric they use exists in code', () => {
    const rules = parse(readFileSync(path.join(ROOT, 'deploy/observability/alerts.yml'), 'utf8'));
    const all = rules.groups.flatMap((g: any) => g.rules);
    expect(all.every((r: any) => r.alert && r.expr && r.annotations?.summary)).toBe(true);
    const used = names(all.map((r: any) => r.expr));
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((n) => !registered(n)), 'alert metrics missing from code').toEqual([]);
  });

  it('a metric name that is not in code is caught (the check is not vacuous)', () => {
    expect(registered('neop_jobs')).toBe(true);
    expect(registered('neop_no_such_metric_total')).toBe(false);
  });
});

describe('gen-secrets (D2 dedicated-DB tier)', () => {
  const gen = (...args: string[]) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neop-secrets-'));
    execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/gen-secrets.ts'), dir, 'ledger', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NEOS_DB_HOST: '', NEOS_DB_PORT: '', NEOS_DEDICATED_DB: '' },
    });
    return (f: string) => readFileSync(path.join(dir, f), 'utf8').trim();
  };

  it('defaults to the shared cluster at postgres:5432', () => {
    const s = gen();
    expect(s('pg_admin_url')).toMatch(/@postgres:5432\/neos$/);
    expect(s('ledger_direct_url')).toMatch(/^postgres:\/\/ledger_runner:.+@postgres:5432\/neos$/);
    expect(s('ledger_app_url')).toMatch(/@pgbouncer:6432\/neos$/);
    expect(s('pgbouncer_ini')).toContain('neos = host=postgres port=5432 dbname=neos');
    expect(s('grafana_admin').length).toBeGreaterThan(20);
  });

  it('--db-host/--db-port move the shared cluster; --dedicated points one app at its own', () => {
    const s = gen('--db-host', 'pg-main.internal', '--db-port', '6543', '--dedicated', 'ledger=pg-ledger:5433');
    expect(s('pg_admin_url')).toMatch(/@pg-main\.internal:6543\/neos$/);
    expect(s('pg_admin_url_ledger')).toMatch(/^postgres:\/\/neos_admin:.+@pg-ledger:5433\/neos$/);
    expect(s('pg_admin_url_ledger')).toContain(encodeURIComponent(s('pg_admin_ledger')));
    expect(s('ledger_direct_url')).toMatch(/@pg-ledger:5433\/neos$/);
    // Pooled URLs go through PgBouncer to the app's own database entry, which points at its cluster.
    expect(s('ledger_app_url')).toMatch(/@pgbouncer:6432\/neos_ledger$/);
    expect(s('ledger_runner_url')).toMatch(/@pgbouncer:6432\/neos_ledger$/);
    expect(s('neos_app_url')).toMatch(/@pgbouncer:6432\/neos$/);
    const ini = s('pgbouncer_ini');
    expect(ini).toContain('neos = host=pg-main.internal port=6543 dbname=neos');
    expect(ini).toContain('neos_ledger = host=pg-ledger port=5433 dbname=neos');
  });

  it('v3 (S8): private session-signing keys stay with their issuers and only public halves reach the proxy', () => {
    const s = gen();
    const priv = JSON.parse(s('ledger_llm_signing_key'));
    expect(priv).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(priv.d).toBeTruthy();
    const pub = JSON.parse(s('llm_runner_keys'));
    expect(Object.keys(pub)).toEqual(['neuralchat', 'ledger']);
    expect(pub.ledger).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: priv.x, kid: priv.kid, alg: 'EdDSA' }]);
    expect(pub.ledger[0].d).toBeUndefined();
    const ring = JSON.parse(s('platform_signing_key'));
    expect(pub.neuralchat).toEqual([ring.keys.find((k: any) => k.state === 'active').publicJwk]);
    expect(pub.neuralchat[0].d).toBeUndefined();
    expect(Buffer.from(s('backup_doors_key'), 'base64')).toHaveLength(32);
  });

  it('refuses a dedicated cluster for an app it is not generating', () => {
    expect(() => gen('--dedicated', 'wage=pg-wage')).toThrow(/not one of the apps/);
  });
});
