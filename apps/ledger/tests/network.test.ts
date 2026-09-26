// network.test · the deploy topology keeps every model away from data and keys.
// Static check of deploy/compose.pilot.yml; the runtime probe (containers up,
// agent cannot open a socket to Postgres, the vault or the internet) runs
// against built images in the ops pipeline.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LEDGER_ROOT } from '../src/index.ts';

const compose = parse(readFileSync(path.join(LEDGER_ROOT, '../../deploy/compose.pilot.yml'), 'utf8'));
const raw = compose.services as Record<string, { networks: string[] | Record<string, unknown>; environment?: Record<string, string>; secrets?: string[] }>;
// Networks may be a list or a map (with per-network aliases); compare by name.
const svc = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { ...v, networks: Array.isArray(v.networks) ? v.networks : Object.keys(v.networks ?? {}) }])) as Record<string, { networks: string[]; environment?: Record<string, string>; secrets?: string[] }>;
const envKeys = (s: string) => Object.keys(svc[s]!.environment ?? {}).join(' ') + ' ' + (svc[s]!.secrets ?? []).join(' ');
const agents = Object.keys(svc).filter((k) => k.endsWith('-agent'));
const backends = Object.keys(svc).filter((k) => k.endsWith('-backend'));
const members = (net: string) => Object.entries(svc).filter(([, s]) => s.networks.includes(net)).map(([k]) => k).sort();

describe('network policy', () => {
  it('there is an agent per app, each on internal networks only, never with the DB, the platform, chat or the internet', () => {
    expect(agents.sort()).toEqual(['ledger-agent']);
    for (const a of agents) {
      for (const n of svc[a]!.networks) expect(compose.networks[n].internal, `${a} on ${n}`).toBe(true);
      for (const bad of ['db', 'l3', 'ctl', 'chat', 'egress', 'edge', 'telemetry']) expect(svc[a]!.networks).not.toContain(bad);
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
    for (const b of backends) expect(envKeys(b)).not.toMatch(/LLM|llm/);
    const holders = Object.keys(svc).filter((k) => /llm_upstream_key/.test(envKeys(k)));
    expect(holders).toEqual(['llm-proxy']);
  });

  it('the llm network joins agents and the proxy only; only the platform reaches L3 and chat', () => {
    expect(members('llm')).toEqual(['ledger-agent', 'llm-proxy']);
    expect(members('l3')).toEqual(['ledger-backend', 'platform']);
    expect(members('chat')).toEqual(['platform', 'synapse']);
    expect(members('ctl')).toEqual(['llm-proxy', 'platform']);
  });

  it('only the LLM proxy (model) and backends (email/GST doors) reach the internet; never the database', () => {
    expect(members('egress')).toEqual(['ledger-backend', 'llm-proxy']);
    expect(svc.postgres!.networks).toEqual(['db']);
    expect(svc.pgbouncer!.networks).toEqual(['db']);
  });

  it('the console reaches only the platform, holds no credential, and is the only other published port', () => {
    expect(members('web')).toEqual(['platform', 'web']);
    expect(svc.web!.networks.sort()).toEqual(['edge', 'web']);
    expect(envKeys('web')).not.toMatch(/DB_URL|SECRET|TOKEN|KEY|app_url|runner_url/i);
    const published = Object.entries(svc).filter(([, s]: any) => s.ports?.length).map(([k]) => k).sort();
    expect(published).toEqual(['platform', 'web']);
  });

  it('L3 listens only on the gateway network, the gate only on the agent network, the agent only on its own', () => {
    const b = (raw['ledger-backend']!.networks as any);
    expect(b.l3.aliases).toEqual(['ledger-l3']);
    expect(b['agent-ledger'].aliases).toEqual(['ledger-gate']);
    expect(svc['ledger-backend']!.environment).toMatchObject({ L3_HOST: 'ledger-l3', GATE_HOST: 'ledger-gate' });
    expect((raw['ledger-agent']!.networks as any)['agent-ledger'].aliases).toEqual(['ledger-agent-rpc']);
    expect(svc['ledger-agent']!.environment).toMatchObject({ HOST: 'ledger-agent-rpc', NEOP_ALLOWED_GATE: 'http://ledger-gate:4102' });
  });

  it('query pools go through PgBouncer; only LISTEN and the execution lock connect direct (S8)', () => {
    const env = svc['ledger-backend']!.environment!;
    expect(env.NEOP_DIRECT_DB_URL_FILE).toBeTruthy();
    expect(svc['ledger-backend']!.secrets).toEqual(expect.arrayContaining(['ledger_app_url', 'ledger_runner_url', 'ledger_direct_url']));
    expect((svc as any).platform.depends_on).toHaveProperty('pgbouncer');
  });

  it('only the migration runner holds the admin connection', () => {
    const holders = Object.keys(svc).filter((k) => /pg_admin_url|ADMIN_URL/.test(envKeys(k)));
    expect(holders).toEqual(['migrate']);
  });
});
