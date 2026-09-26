// Minimal semver ranges for borrowed abilities (WP §10 `uses: books.budget.remaining@^2`):
// exact, *, ^x.y.z, ~x.y.z, >=x.y.z. Enough for pins; no prereleases.
const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] as const : null;
};
const cmp = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '*' || r === '') return true;
  const op = /^(\^|~|>=)?\s*(\d+(?:\.\d+){0,2})$/.exec(r);
  if (!op) return false;
  const parts = op[2]!.split('.').map(Number);
  const base = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
  switch (op[1]) {
    case '^':
      return cmp(v, base) >= 0 && (base[0] > 0 ? v[0] === base[0] : base[1] > 0 ? v[0] === 0 && v[1] === base[1] : cmp(v, base) === 0);
    case '~':
      return cmp(v, base) >= 0 && v[0] === base[0] && v[1] === base[1];
    case '>=':
      return cmp(v, base) >= 0;
    default:
      return parts.length === 3 ? cmp(v, base) === 0 : v[0] === base[0] && (parts.length < 2 || v[1] === base[1]);
  }
}
