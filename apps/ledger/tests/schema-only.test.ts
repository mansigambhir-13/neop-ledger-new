// schema-only.test · WP v3 §13 standard test: the app's roles cannot name any other schema, and the
// assistant holds no DB link. One database with the platform (neos), Marketing (another NEOP) and Ledger:
//   · as ledger_app and as ledger_runner, every table in every other schema — marketing.*, neos.* — is
//     refused with 42501 (no USAGE on the schema), and so is another app's answer_proposal();
//   · the assistant side has no database: its deployment carries no DB URL or secret, its entry script
//     reads none, and what the runner hands a session (bundle, token, gate URL, model session) holds none.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleUrl, rolePassword } from '@neop/pgkit';
import { marketingApp, seedMarketing } from '@neop/marketing';
import { LEDGER_ROOT } from '../src/index.ts';
import { bootPilot, finish, ledgerUnderTest, type Pilot } from './harness.ts';

const REPO = path.resolve(LEDGER_ROOT, '../..');
let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [await ledgerUnderTest(), { def: await marketingApp(), seed: seedMarketing }] });
});
afterAll(async () => P?.close());

async function as<T>(role: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: roleUrl(P.adminUrl, role) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

describe('the app’s roles see only the app’s schema', () => {
  it('as ledger_app and ledger_runner, every table of marketing.* and neos.* is refused with 42501', async () => {
    const admin = new pg.Client({ connectionString: P.adminUrl });
    await admin.connect();
    const others = (
      await admin.query<{ s: string; t: string }>(
        `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'v', 'p') and n.nspname not in ('ledger', 'pg_catalog', 'information_schema') and n.nspname not like 'pg_%'
          order by 1, 2`,
      )
    ).rows;
    await admin.end();
    // The pilot really has other schemas to be kept out of.
    expect(others.filter((o) => o.s === 'marketing').length).toBeGreaterThan(10);
    expect(others.filter((o) => o.s === 'neos').length).toBeGreaterThan(10);
    expect([...new Set(others.map((o) => o.s))].sort()).toEqual(['marketing', 'neos']);
    for (const role of ['ledger_app', 'ledger_runner']) {
      await as(role, async (c) => {
        for (const o of others) expect(await code(c.query(`select 1 from ${o.s}.${o.t} limit 1`)), `${role} → ${o.s}.${o.t}`).toBe('42501');
        // Not by writing either, and not through another app's answer function.
        expect(await code(c.query("insert into marketing.jobs (company_id, source, requester, ask) values (gen_random_uuid(), 'task', 'user:x', 'x')"))).toBe('42501');
        expect(await code(c.query('select marketing.answer_proposal(gen_random_uuid(), $1, $2, $3, null)', ['sha256:x', 'yes', 'user:x']))).toBe('42501');
        // Its own schema is its home: an unqualified name resolves there (search_path = ledger).
        expect((await c.query('show search_path')).rows[0].search_path).toBe('ledger');
        expect(await code(c.query('select 1 from schema_migrations limit 1'))).toBe('ok');
      });
    }
    // And the other way round: Marketing's roles cannot name Ledger's tables.
    for (const role of ['marketing_app', 'marketing_runner']) {
      await as(role, async (c) => {
        expect(await code(c.query('select 1 from ledger.journal_entries limit 1'))).toBe('42501');
        expect(await code(c.query('select 1 from ledger.proposals limit 1'))).toBe('42501');
      });
    }
  });
});

describe('the assistant holds no DB link', () => {
  const DB = /postgres(ql)?:\/\/|DB_URL|DATABASE|PGHOST|PGPASSWORD|_url\b/i;

  it('its deployment carries no DB URL and no secret; its entry script reads none', async () => {
    let agents = 0;
    for (const f of ['compose.pilot.yml', 'compose.dedicated-ledger.yml', 'compose.chat.yml']) {
      const doc = parse(await readFile(path.join(REPO, 'deploy', f), 'utf8')) as { services?: Record<string, any> };
      for (const [name, svc] of Object.entries(doc.services ?? {})) {
        const cmd = JSON.stringify(svc.command ?? '') + JSON.stringify(svc.build ?? '');
        if (!/agent\.ts|agent\.Dockerfile/.test(cmd)) continue;
        agents++;
        expect(svc.secrets ?? [], `${f} ${name} secrets`).toEqual([]);
        const env = svc.environment ?? {};
        const pairs = Array.isArray(env) ? env.map(String) : Object.entries(env).map(([k, v]) => `${k}=${String(v)}`);
        for (const kv of pairs) expect(kv, `${f} ${name}`).not.toMatch(DB);
        expect(Object.keys(svc.networks ?? {}), `${f} ${name} networks`).not.toContain('db');
      }
    }
    expect(agents).toBeGreaterThan(0);
    const entry = await readFile(path.join(LEDGER_ROOT, 'scripts', 'agent.ts'), 'utf8');
    // (It imports closeServer from pgkit — an HTTP helper — and nothing that connects to a database.)
    expect(entry).not.toMatch(/createPool|withCompany|new pg\.|roleUrl|DB_URL|DATABASE_URL|adminUrl/);
    const dockerfile = (await readFile(path.join(REPO, 'deploy', 'agent.Dockerfile'), 'utf8')).split('\n').filter((l) => /^\s*(ENV|ARG)\b/.test(l));
    expect(dockerfile.length).toBeGreaterThan(0);
    for (const l of dockerfile) expect(l).not.toMatch(DB);
  });

  it('what the runner hands a session holds no DB URL or role password', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith('/sessions') && init?.body) seen.push(String(init.body));
      return real(input, init);
    }) as typeof fetch;
    try {
      P.setBrain(() => finish('ok'));
      const t = await P.ask('What was our net profit in August 2026?');
      await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'completed');
    } finally {
      globalThis.fetch = real;
    }
    expect(seen.length).toBeGreaterThan(0);
    const secrets = ['ledger_app', 'ledger_runner', 'ledger_migrator'].map((r) => rolePassword(r));
    for (const body of seen) {
      expect(body).not.toMatch(/postgres(ql)?:\/\//i);
      for (const s of secrets) expect(body).not.toContain(s);
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(['bundle', 'gate_url', 'llm', 'token']);
    }
  });
});
