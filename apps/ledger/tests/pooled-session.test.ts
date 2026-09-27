// pooled-session.test · query pools go through PgBouncer in transaction mode (S8), where a session-level
// SET stays on the server connection and the next client inherits it. Found live: a verification script's
// `set default_transaction_read_only = on` made the running backend read-only. Only transaction-scoped
// settings (`set_config(..., true)`, `SET LOCAL`, `BEGIN ... READ ONLY`) are allowed in code that uses
// pooled links; the migrator's `set role` runs on its own direct admin connection.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIRS = ['scripts', 'packages/pgkit/src', 'packages/neop-template/src', 'packages/platform/src', 'apps/ledger/src', 'apps/ledger/scripts', 'registry'];
const ALLOWED = new Set<string>();

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let out: string[] = [];
  for (const f of readdirSync(abs)) {
    const p = path.join(abs, f);
    if (f === 'node_modules') continue;
    if (statSync(p).isDirectory()) out = out.concat(files(path.join(dir, f)));
    else if (/\.(ts|js|mjs)$/.test(f)) out.push(path.join(dir, f));
  }
  return out;
}

it('no session-level SET on a pooled connection anywhere in runtime or ops code', () => {
  const bad: string[] = [];
  for (const d of DIRS) {
    for (const f of files(d)) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      // A statement that starts with SET <name> = / TO <value> (not SET LOCAL / TRANSACTION, not UPDATE ... SET).
      for (const m of src.matchAll(/['"`]\s*set\s+(?!local\b|transaction\b)(session\s+)?([a-z_][a-z_.]*)\s*(=|\bto\b)/gi)) {
        const what = m[2]!.toLowerCase();
        const key = `${f}:set ${what}`;
        if (!ALLOWED.has(key)) bad.push(key);
      }
    }
  }
  expect(bad).toEqual([]);
});
