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
const svc = compose.services as Record<string, { networks: string[]; environment?: Record<string, string>; secrets?: string[] }>;
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
  });

  it('only the migration runner holds the admin connection', () => {
    const holders = Object.keys(svc).filter((k) => /pg_admin_url|ADMIN_URL/.test(envKeys(k)));
    expect(holders).toEqual(['migrate']);
  });
});
