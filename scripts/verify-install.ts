// VERIFY AN INSTALL · a READ-ONLY check against a running deployment, after the migrator ran and the company was
// installed (ported from Shivam's tests/verify-install.mjs, 930eb38, onto our platform). It writes nothing (every
// database session is read-only), never sends a chat message, never logs in or out, and never prints a secret —
// the LLM provider key is only checked to be there, never read. Every check prints PASS / WARN / FAIL / SKIP in a
// table; any FAIL exits 1.
//
//   tsx scripts/verify-install.ts <app> <company id|slug>
//
//   NEOS_PLATFORM_URL                   the running platform (GET /live)
//   NEOS_DB_URL[_FILE]                  a platform database link (read-only use): apps, installs
//   NEOP_RUNNER_DB_URL[_FILE]           the app's runner link (it reads <app>.schema_migrations, like the boot check, and
//                                       <app>.switchboard, the board's truth since v3 S1); defaults to NEOS_DB_URL
//   NEOP_DOOR_SECRETS_DIR               the door secret store as the backend mounts it (default /run/secrets/doors):
//                                       each connected door has a file — checked by name and mode, never opened
//   NEOS_COMPOSE_FILE                   the rendered compose config (docker compose config): only the backend
//                                       mounts the doors; no agent, no web
//   NEOP_LLM_UPSTREAM_KEY[_FILE]        the LLM proxy's provider key — present, never read (run where the proxy's env is)
//   MATRIX_MODE=client + MATRIX_HOMESERVER_URL + MATRIX_CLIENT_ACCOUNTS[_FILE]   each account's token: whoami
//   NEOS_ENV=production                 an app registered without a conformance attestation is a FAIL (else a WARN)
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, familyRoles, schemaDrift, shippedMigrations, type AppliedMigration, type PoolClient } from '@neop/pgkit';

type Pool = ReturnType<typeof createPool>;
import { attestationProblem, chatClientConfigFromEnv, MatrixClientHttp } from '@neop/platform';
import { appMigrationSources, DEFAULT_DOOR_SECRETS_DIR, doorSecretPaths, type AppDefinition } from '@neop/template';
import { parse as parseYaml } from 'yaml';

type Manifest = AppDefinition['manifest'];

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface CheckResult {
  status: Status;
  name: string;
  detail: string;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const APPS: Record<string, () => Promise<AppDefinition>> = {
  ledger: async () => (await import('@neop/ledger')).ledgerApp(),
  marketing: async () => (await import('@neop/marketing')).marketingApp(),
};
const RANK: Record<string, number> = { off: 0, ask_first: 1, on: 2 };

/** NAME, or the contents of the file NAME_FILE names. */
function envOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name] || undefined;
}

/** JSON with keys sorted: the database (jsonb) does not keep key order. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}` : JSON.stringify(v ?? null);

class Skip extends Error {}
class Warn extends Error {}

export async function verifyInstall(o: {
  app: string;
  company: string;
  env?: NodeJS.ProcessEnv;
  def?: AppDefinition;
  fetchImpl?: FetchLike;
  out?: (line: string) => void;
}): Promise<{ ok: boolean; results: CheckResult[] }> {
  const env = o.env ?? process.env;
  const fetchImpl = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      results.push({ status: 'PASS', name, detail: (await fn()) || '' });
    } catch (e) {
      const status: Status = e instanceof Skip ? 'SKIP' : e instanceof Warn ? 'WARN' : 'FAIL';
      results.push({ status, name, detail: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  };
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const get = async (url: string, headers: Record<string, string> = {}) => fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });

  // ── the build ────────────────────────────────────────────────────────────
  let def: AppDefinition | null = o.def ?? null;
  await check(`build: ${o.app} is an app of this build`, async () => {
    if (!def) {
      const load = APPS[o.app];
      must(load, `no app ${o.app} in this build (${Object.keys(APPS).join(', ')})`);
      def = await load!();
    }
    return `${def!.manifest.name} ${def!.manifest.version}`;
  });
  const manifest = def ? (def as AppDefinition).manifest : null;

  // ── the platform ─────────────────────────────────────────────────────────
  const platformUrl = (env.NEOS_PLATFORM_URL ?? '').replace(/\/+$/, '');
  await check('platform: reachable', async () => {
    must(platformUrl, 'NEOS_PLATFORM_URL is not set');
    let r;
    try {
      r = await get(`${platformUrl}/live`);
    } catch (e) {
      throw new Error(`nothing answers at ${platformUrl}: ${(e as Error).message}`);
    }
    must(r.ok, `${platformUrl}/live answered ${r.status}`);
    return platformUrl;
  });

  const dbUrl = envOf(env, 'NEOS_DB_URL');
  const runnerUrl = envOf(env, 'NEOP_RUNNER_DB_URL') ?? dbUrl;
  let pool: Pool | null = null;
  let db: PoolClient | null = null;
  await check('database: platform link connects (read-only)', async () => {
    must(dbUrl, 'NEOS_DB_URL (or NEOS_DB_URL_FILE) is not set');
    pool = createPool(dbUrl!, 1);
    db = await pool.connect();
    // One read-only TRANSACTION, never a session setting: through PgBouncer (transaction pooling) a session
    // SET stays on the server connection and the next client — the app itself — inherits it (found live:
    // the backend went read-only). A transaction ends with us; nothing outlives this script.
    await db.query('begin transaction read only');
    try {
      return (await db.query<{ u: string }>('select current_user as u')).rows[0]!.u;
    } finally {
      await db.query('rollback');
    }
  });
  const q = async <T extends Record<string, any> = any>(sql: string, args: unknown[] = []): Promise<T[]> => {
    if (!db) throw new Skip('no database link');
    // Each query in its own read-only transaction: a failing check cannot poison the next one.
    const c = db as PoolClient;
    await c.query('begin transaction read only');
    try {
      return (await c.query<T>(sql, args)).rows;
    } finally {
      await c.query('rollback').catch(() => {});
    }
  };

  let companyId: string | null = null;
  let appRow: { l3_url: string; manifest: Manifest; status: string; conformance: unknown } | null = null;
  await check(`platform: ${o.app} is registered, active and attested`, async () => {
    const [r] = await q<{ l3_url: string; manifest: Manifest; status: string; conformance: unknown }>('select l3_url, manifest, status, conformance from neos.apps where key = $1', [o.app]);
    must(r, `${o.app} is not registered (tsx scripts/ops.ts register-app …)`);
    appRow = r!;
    must(r!.status === 'active', `status ${r!.status}`);
    if (manifest) must(stable(r!.manifest) === stable(manifest), 'the registered manifest is not this build’s — register this build again');
    const problem = attestationProblem(r!.conformance, o.app, r!.manifest);
    if (problem) {
      if (env.NEOS_ENV === 'production') throw new Error(`not attested: ${problem}`);
      throw new Warn(`not attested (${problem}); production refuses this`);
    }
    return `${r!.manifest.version}, attested`;
  });
  await check(`platform: ${o.app} is installed for ${o.company}`, async () => {
    const [co] = await q<{ id: string; name: string; time_zone: string }>('select id, name, time_zone from neos.companies where id::text = $1 or slug = $1', [o.company]);
    must(co, `no company ${o.company}`);
    companyId = co!.id;
    const [i] = await q<{ status: string }>('select status from neos.installs where company_id = $1 and app_key = $2', [co!.id, o.app]);
    must(i, `no install of ${o.app} for ${co!.name}`);
    must(i!.status === 'active', `install status ${i!.status}`);
    return `${co!.name} (${co!.time_zone})`;
  });

  // ── the app's database family ────────────────────────────────────────────
  const schema = manifest?.app ?? o.app;
  const roles = familyRoles(schema);
  await check(`database: roles ${roles.migrator}, ${roles.app}, ${roles.runner}`, async () => {
    const rows = await q<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>('select rolname, rolbypassrls, rolsuper from pg_roles where rolname = any($1)', [[roles.migrator, roles.app, roles.runner]]);
    const by = new Map(rows.map((r) => [r.rolname, r]));
    const missing = [roles.migrator, roles.app, roles.runner].filter((r) => !by.has(r));
    must(!missing.length, `missing: ${missing.join(', ')} — run the migrator (scripts/migrate.ts)`);
    must(!by.get(roles.app)!.rolbypassrls && !by.get(roles.app)!.rolsuper, `${roles.app} must not bypass row-level security`);
    must(!by.get(roles.runner)!.rolsuper, `${roles.runner} must not be a superuser`);
    const [owner] = await q<{ owner: string }>('select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1', [schema]);
    must(owner, `schema ${schema} does not exist`);
    must(owner!.owner === roles.migrator, `schema ${schema} is owned by ${owner!.owner}, not ${roles.migrator}`);
    return 'present; app role under RLS';
  });
  await check('database: grants (app and runner use, never create)', async () => {
    const bad: string[] = [];
    for (const role of [roles.app, roles.runner]) {
      const [r] = await q<{ usage: boolean; create: boolean; dbcreate: boolean }>(
        "select has_schema_privilege($1, $2, 'USAGE') as usage, has_schema_privilege($1, $2, 'CREATE') as create, has_database_privilege($1, current_database(), 'CREATE') as dbcreate",
        [role, schema],
      );
      if (!r!.usage) bad.push(`${role} has no USAGE on ${schema}`);
      if (r!.create) bad.push(`${role} may CREATE in ${schema}`);
      if (r!.dbcreate) bad.push(`${role} may CREATE schemas in the database`);
    }
    const [jobs] = await q<{ app: boolean; runner: boolean }>(
      // By oid from the catalogue: resolving the name "<schema>.jobs" would need USAGE on the app's schema,
      // which the platform link rightly does not have.
      `select has_table_privilege($1, c.oid, 'SELECT') as app, has_table_privilege($2, c.oid, 'SELECT') as runner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $3 and c.relname = 'jobs'`,
      [roles.app, roles.runner, schema],
    );
    if (!jobs?.app) bad.push(`${roles.app} cannot read ${schema}.jobs`);
    if (!jobs?.runner) bad.push(`${roles.runner} cannot read ${schema}.jobs`);
    must(!bad.length, bad.join('; '));
  });
  await check("database: schema in step with this build's migrations", async () => {
    if (!def) throw new Skip('no build to compare with');
    must(runnerUrl, 'NEOP_RUNNER_DB_URL (or NEOS_DB_URL) is not set');
    // The same comparison the backend makes before it listens (assertSchemaInStep), read-only.
    const shipped = await shippedMigrations(await appMigrationSources(def));
    const rp = createPool(runnerUrl!, 1);
    let applied: AppliedMigration[];
    try {
      const c = await rp.connect();
      try {
        await c.query('begin transaction read only');
        applied = (await c.query<AppliedMigration>(`select name, checksum from ${schema}.schema_migrations order by name`)).rows;
      } finally {
        await c.query('rollback').catch(() => {});
        c.release(true);
      }
    } finally {
      await rp.end().catch(() => {});
    }
    const d = schemaDrift(applied, shipped);
    const parts = [d.pending.length ? `pending: ${d.pending.join(', ')}` : '', d.unknown.length ? `unknown: ${d.unknown.join(', ')}` : '', d.changed.length ? `changed: ${d.changed.join(', ')}` : ''].filter(Boolean);
    must(!parts.length, `${parts.join('; ')} — the backend will refuse to start`);
    return `${shipped.length} migrations`;
  });

  // ── the company's install ────────────────────────────────────────────────
  await check('switchboard: every line within its floor', async () => {
    if (!companyId || !appRow) throw new Skip('no install to read');
    const m = (appRow as { manifest: Manifest }).manifest;
    // v3 S1: the board is the app's own <schema>.switchboard (read, like the boot check, over the runner link).
    must(runnerUrl, 'NEOP_RUNNER_DB_URL (or NEOS_DB_URL) is not set');
    const rp = createPool(runnerUrl!, 1);
    let sb: { version: number; settings: Record<string, string> };
    try {
      const c = await rp.connect();
      try {
        await c.query('begin transaction read only');
        const lines = (await c.query<{ line: string; setting: string }>(`select line, setting from ${schema}.switchboard where company_id = $1 and line <> '*'`, [companyId])).rows;
        const [v] = (
          await c.query<{ v: number }>(
            `select greatest(coalesce((select max(version) from ${schema}.switchboard where company_id = $1), 0),
                             coalesce((select max(version) from ${schema}.switchboard_history where company_id = $1), 0))::int as v`,
            [companyId],
          )
        ).rows;
        sb = { version: v?.v ?? 0, settings: Object.fromEntries(lines.map((l) => [l.line, l.setting])) };
      } finally {
        await c.query('rollback').catch(() => {});
        c.release(true);
      }
    } finally {
      await rp.end().catch(() => {});
    }
    const settings = sb.settings;
    const floors = new Map(m.abilities.map((a) => [a.key, a.floor as string]));
    const problems: string[] = [];
    for (const [line, setting] of Object.entries(settings)) {
      if (line.startsWith('skill:')) {
        if (!['on', 'off'].includes(setting)) problems.push(`${line} is ${setting} (a skill is on or off)`);
        continue;
      }
      const floor = floors.get(line);
      if (!floor) continue; // a package's line: checked by the registry
      if (!(setting in RANK)) problems.push(`${line} is ${setting}`);
      else if (RANK[setting]! > RANK[floor]!) problems.push(`${line} is ${setting}, looser than its floor ${floor}`);
    }
    must(!problems.length, problems.join('; '));
    const eff = m.abilities.map((a) => {
      const s = settings[a.key];
      return s && RANK[s]! < RANK[a.floor]! ? s : a.floor;
    });
    return `version ${sb?.version ?? 0}: ${eff.filter((s) => s === 'on').length} on, ${eff.filter((s) => s === 'ask_first').length} ask first, ${eff.filter((s) => s === 'off').length} off`;
  });
  // v3 §12: door credentials are files in the secret store, read by the backend per call. Checked to be there (and
  // not open to others) by name and mode only — never opened.
  await check('doors: a credential file for every connected door (not read)', async () => {
    if (!companyId || !appRow) throw new Skip('no install to read');
    const m = (appRow as { manifest: Manifest }).manifest;
    const declared = (m.doors ?? []).map((d) => d.key);
    if (!declared.length) return 'no doors declared';
    // v3 S1: door switches are lines of the app's own <schema>.switchboard, read over the runner link.
    must(runnerUrl, 'NEOP_RUNNER_DB_URL (or NEOS_DB_URL) is not set');
    const rp = createPool(runnerUrl!, 1);
    const sb: { settings: Record<string, string> } = { settings: {} };
    try {
      const c = await rp.connect();
      try {
        await c.query('begin transaction read only');
        const lines = (await c.query<{ line: string; setting: string }>(`select line, setting from ${schema}.switchboard where company_id = $1 and line like 'door:%'`, [companyId])).rows;
        sb.settings = Object.fromEntries(lines.map((l) => [l.line, l.setting]));
      } finally {
        await c.query('rollback').catch(() => {});
        c.release(true);
      }
    } finally {
      await rp.end().catch(() => {});
    }
    const off = (d: string) => (m.doors ?? []).find((x) => x.key === d)?.floor === 'off' || sb?.settings?.[`door:${d}`] === 'off';
    const connected = declared.filter((d) => !off(d));
    const root = env.NEOP_DOOR_SECRETS_DIR ?? DEFAULT_DOOR_SECRETS_DIR;
    must(existsSync(root), `no secret store at ${root} — run this where the backend's doors mount is (NEOP_DOOR_SECRETS_DIR)`);
    const missing: string[] = [];
    const open: string[] = [];
    const found: string[] = [];
    for (const d of connected) {
      const p = doorSecretPaths(root, companyId, o.app, d);
      const f = [p.own, p.company].find((x) => existsSync(x));
      if (!f) {
        missing.push(d);
        continue;
      }
      found.push(`${d} (${f === p.own ? 'own' : 'company-wide'})`);
      if (statSync(f).mode & 0o077) open.push(`${path.relative(root, f)} is ${(statSync(f).mode & 0o777).toString(8)}`);
    }
    // A door is connected per company when it is needed; until then its gated abilities fail cleanly (a definite
    // "not connected", never UNKNOWN). So a missing file is a warning to act on, not a broken install.
    if (missing.length) throw new Warn(`no credential yet for ${missing.join(', ')} — abilities using it fail cleanly until ops runs scripts/deploy.sh door set ${companyId} <door> ${o.app} (RUNBOOK: Door secrets)`);
    if (open.length) throw new Warn(`readable by group or others (chmod 600): ${open.join('; ')}`);
    const offList = declared.filter(off);
    return `${found.join(', ')}${offList.length ? ` · switched off: ${offList.join(', ')}` : ''}`;
  });
  await check('deploy: the door secret store reaches the backend only (no agent, no web mount)', async () => {
    const file = env.NEOS_COMPOSE_FILE;
    if (!file) throw new Skip('NEOS_COMPOSE_FILE is not set (the rendered compose config)');
    must(existsSync(file), `NEOS_COMPOSE_FILE names ${file}, which is missing`);
    const services = (parseYaml(readFileSync(file, 'utf8'), { merge: true })?.services ?? {}) as Record<string, any>;
    const mountsDoors = (s: any) =>
      (s.volumes ?? []).some((v: any) => /\/doors(:|$|\/)/.test(typeof v === 'string' ? v : `${v.source ?? ''}:${v.target ?? ''}`)) || /DOOR_SECRETS/.test(JSON.stringify(s.environment ?? {}));
    const bad = Object.entries(services)
      .filter(([k, s]) => (k.endsWith('-agent') || k === 'web' || /agent\.ts/.test(JSON.stringify(s.command ?? ''))) && mountsDoors(s))
      .map(([k]) => k);
    must(!bad.length, `${bad.join(', ')} can see the door secret store — only the backend may`);
    const backend = services[`${o.app}-backend`];
    must(backend, `no ${o.app}-backend service in ${path.basename(file)}`);
    const vols = (backend.volumes ?? []).map((v: any) => (typeof v === 'string' ? v : `${v.source}:${v.target}${v.read_only ? ':ro' : ''}`));
    const doors = vols.find((v: string) => /:\/run\/secrets\/doors(:|$)/.test(v) || /\/doors:/.test(v));
    must(doors, `${o.app}-backend has no doors mount: its doors will all fail as not connected`);
    must(/:ro$/.test(doors) || (backend.volumes ?? []).some((v: any) => typeof v === 'object' && v.read_only), `${o.app}-backend mounts the doors read-write; mount it :ro`);
    const agents = Object.keys(services).filter((k) => k.endsWith('-agent'));
    return `${o.app}-backend read-only; ${agents.length} agent container(s) without it`;
  });

  // ── what runs beside it ──────────────────────────────────────────────────
  await check('llm proxy: provider key present (not read)', async () => {
    const file = env.NEOP_LLM_UPSTREAM_KEY_FILE;
    if (file) {
      must(existsSync(file) && statSync(file).size > 0, `NEOP_LLM_UPSTREAM_KEY_FILE names ${file}, which is missing or empty`);
      return `in ${path.basename(file)}`;
    }
    must(env.NEOP_LLM_UPSTREAM_KEY, 'NEOP_LLM_UPSTREAM_KEY (or _FILE) is not set here — run this where the LLM proxy’s environment is');
    return 'set';
  });
  await check('backend: /l3/ready, reached as the platform reaches it', async () => {
    if (!appRow) throw new Skip('the app is not registered');
    const base = (appRow as { l3_url: string }).l3_url.replace(/\/+$/, '');
    let r;
    try {
      r = await get(`${base}/l3/ready`);
    } catch (e) {
      throw new Error(`nothing answers at ${base}: ${(e as Error).message}`);
    }
    must(r.ok, `${base}/l3/ready answered ${r.status} — the backend cannot reach its database`);
    return base;
  });
  await check('matrix: client tokens valid (whoami)', async () => {
    if ((env.MATRIX_MODE ?? 'appservice') !== 'client') throw new Skip(`MATRIX_MODE=${env.MATRIX_MODE ?? 'appservice'}`);
    const cfg = chatClientConfigFromEnv(env);
    const mine = cfg!.accounts.filter((a) => a.app === o.app && (!companyId || a.company === companyId || a.company === o.company));
    must(mine.length, `no MATRIX_CLIENT_ACCOUNTS entry for ${o.app} at ${o.company}`);
    const seen: string[] = [];
    for (const a of mine) {
      must(a.tokenFile && existsSync(a.tokenFile), `${a.account}: token file ${a.tokenFile ?? '(none)'} is missing`);
      const http = new MatrixClientHttp({ homeserverUrl: cfg!.homeserverUrl, account: a.account, accessToken: readFileSync(a.tokenFile!, 'utf8').trim(), fetchImpl: (o.fetchImpl ?? cfg!.fetchImpl) as any });
      let who: string;
      try {
        who = await http.whoami();
      } catch (e) {
        throw new Error(`${a.account}: the homeserver refused the token (${(e as Error).message}) — ask the Matrix operator for a new one`);
      }
      must(who === a.account, `${a.account}: the token belongs to ${who}`);
      seen.push(who);
    }
    return seen.join(', ');
  });

  (db as PoolClient | null)?.release(true);
  if (pool) await (pool as Pool).end().catch(() => {});
  const out = o.out ?? ((l: string) => console.log(l));
  const w = Math.max(...results.map((r) => r.name.length), 5);
  out(`${'STATUS'.padEnd(6)}  ${'CHECK'.padEnd(w)}  DETAIL`);
  for (const r of results) out(`${r.status.padEnd(6)}  ${r.name.padEnd(w)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  out(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed'} (${results.filter((r) => r.status === 'PASS').length} passed, ${results.filter((r) => r.status === 'WARN').length} warnings, ${results.filter((r) => r.status === 'SKIP').length} skipped).`);
  return { ok: failed === 0, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app, company] = process.argv.slice(2);
  if (!app || !company) {
    console.error('usage: tsx scripts/verify-install.ts <app> <company id|slug>');
    process.exit(64);
  }
  verifyInstall({ app, company }).then(
    (r) => process.exit(r.ok ? 0 : 1),
    (e) => {
      console.error(`verify failed to run: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
