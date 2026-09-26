// Package self-test at install (Phase 5): after its migrations, the package's own
// `selftest` handler runs in the sandbox against its freshly migrated tables, as
// the package role, for a throwaway company, inside a transaction that is always
// rolled back. A package that fails it is not installed. A package with no
// selftest handler is reported as such (never counted as passed).
//
// Handler shape (either):
//   export async function selftest(ctx) { ... throw to fail ... }
//   export const abilities = { selftest: { async run(args, ctx) { ... } } }
// ctx.tables.select/insert/update work on the package's own nep_* tables only.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { roleUrl } from '@neop/pgkit';
import { packageRole } from './migrate.ts';
import { Sandbox } from './sandbox.ts';
import type { PackageBundle } from './types.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export class PackageSelftestError extends Error {}

export function hasSelftest(bundle: PackageBundle): boolean {
  return /\bselftest\b/.test(bundle.handlers);
}

export async function selftestPackage(adminUrl: string, host: string, bundle: PackageBundle, opts: { timeoutMs?: number } = {}): Promise<{ ran: boolean; result?: unknown }> {
  const m = bundle.manifest;
  if (!hasSelftest(bundle)) return { ran: false };
  const prefix = `nep_${m.key.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_')}_`;
  const client = new pg.Client({ connectionString: roleUrl(adminUrl, packageRole(host, m.key)) });
  await client.connect();
  const sandbox = new Sandbox({ name: `${m.key}@${m.version}:selftest`, handlersSource: bundle.handlers, callTimeoutMs: opts.timeoutMs ?? 15_000 });
  const company = randomUUID();
  try {
    await client.query('begin');
    await client.query("select set_config('neos.company_id', $1, true)", [company]);
    const table = (t: unknown) => {
      if (typeof t !== 'string' || !t.startsWith(prefix) || !m.tables.includes(t) || !IDENT.test(t)) throw new Error(`table ${String(t)} is not this package's`);
      return `${host}.${t}`;
    };
    const cols = (o: Record<string, unknown>) => {
      const ks = Object.keys(o ?? {});
      for (const k of ks) if (!IDENT.test(k) || k === 'company_id') throw new Error(`column ${k} not allowed`);
      return ks;
    };
    const onCtx = async (op: string, p: any): Promise<unknown> => {
      switch (op) {
        case 'tables.select': {
          const ks = cols(p.where);
          return (await client.query(`select * from ${table(p.table)} where ${ks.map((k, i) => `${k} = $${i + 1}`).join(' and ') || 'true'} limit ${Math.min(Number(p.limit) || 100, 500)}`, ks.map((k) => p.where[k]))).rows;
        }
        case 'tables.insert': {
          const ks = cols(p.row);
          return (await client.query(`insert into ${table(p.table)} (company_id${ks.map((k) => `, ${k}`).join('')}) values ($1${ks.map((_, i) => `, $${i + 2}`).join('')}) returning *`, [company, ...ks.map((k) => p.row[k])])).rows[0];
        }
        case 'tables.update': {
          const w = cols(p.where);
          const s = cols(p.set);
          if (!w.length || !s.length) throw new Error('update needs where and set');
          return (await client.query(`update ${table(p.table)} set ${s.map((k, i) => `${k} = $${i + 1}`).join(', ')} where ${w.map((k, i) => `${k} = $${s.length + i + 1}`).join(' and ')} returning *`, [...s.map((k) => p.set[k]), ...w.map((k) => p.where[k])])).rows;
        }
        case 'book.step':
        case 'book.fact':
          return null; // no job during a self-test
        default:
          throw new Error(`${op} is not available during a self-test`);
      }
    };
    let result: unknown;
    try {
      result = await sandbox.call('selftest', 'run', {}, { company_id: company, job_id: null, selftest: true }, onCtx);
    } catch (e) {
      throw new PackageSelftestError(`${m.key}@${m.version} self-test failed: ${(e as Error).message}`);
    }
    // Contract: `selftest()` returns { ok, checks }; ok:false fails the install (a throw does too).
    const r = result as { ok?: unknown; checks?: unknown } | null;
    if (!r || typeof r !== 'object' || r.ok !== true) {
      const failed = Array.isArray(r?.checks) ? (r!.checks as any[]).filter((c) => c && c.ok === false) : [];
      throw new PackageSelftestError(`${m.key}@${m.version} self-test failed: ${r && typeof r === 'object' && 'ok' in r ? `ok=${String(r.ok)}` : 'it returned no {ok, checks}'}${failed.length ? ` — ${JSON.stringify(failed).slice(0, 400)}` : ''}`);
    }
    return { ran: true, result };
  } finally {
    sandbox.stop();
    await client.query('rollback').catch(() => {});
    await client.end().catch(() => {});
  }
}
