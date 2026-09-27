// Names the books hold, and the date the company is living on. Deterministic helpers the abilities use:
//   · an unknown party / account / document is refused with the closest real names (edit distance), so the
//     assistant asks "Did you mean …?" — it never acts on a guess (live test with NeuralChat, 26 Sep 2026);
//   · an account or category named in words is matched to the chart by name, and only when exactly one
//     account matches — none or several is a question, never a pick;
//   · "today" is the company's today (its time zone), and a running period is aged to it, never past it.

import type { PoolClient } from '@neop/pgkit';
import type { CallerCtx, Refusal } from '@neop/template';

const S = 'ledger';

// ── dates ──────────────────────────────────────────────────────────────────

/** The company's today (YYYY-MM-DD), in its time zone; UTC when the caller did not say. */
export function companyToday(ctx: Pick<CallerCtx, 'now' | 'time_zone'>): string {
  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.time_zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The date an aging is measured to: the date asked for, or the company's today while that date is still
 * ahead (a running period) — a report never ages into days that have not happened, and a bill due today
 * is not overdue yet.
 */
export function agedTo(asOf: string, ctx: Pick<CallerCtx, 'now' | 'time_zone'>): string {
  const today = companyToday(ctx);
  return asOf > today ? today : asOf;
}

// ── closeness ──────────────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** How far `q` is from `c`, 0 (same) … 1 (nothing alike): whole-string edit distance, or the best word's. */
function distance(q: string, c: string): number {
  const a = norm(q);
  const b = norm(c);
  if (!a || !b) return 1;
  if (a === b) return 0;
  if (b.includes(a) || a.includes(b)) return 0.1;
  const whole = levenshtein(a, b) / Math.max(a.length, b.length);
  const compact = levenshtein(a.replace(/ /g, ''), b.replace(/ /g, '')) / Math.max(a.replace(/ /g, '').length, b.replace(/ /g, '').length);
  let word = 1;
  const words = (x: string) => x.split(' ').filter((w) => w.length >= 3 && !COMMON.has(w));
  for (const w of words(a)) for (const v of words(b)) word = Math.min(word, levenshtein(w, v) / Math.max(w.length, v.length) + 0.15);
  return Math.min(whole, compact, word);
}

/** Words every other company name has: alike in them says nothing about which party was meant. */
const COMMON = new Set(['ltd', 'pvt', 'private', 'limited', 'inc', 'llp', 'llc', 'company', 'corp', 'and', 'the', 'india', 'group', 'services', 'account', 'accounts']);

/** The closest names to `query` (best first), at most `max`, only those reasonably alike. */
export function closest<T>(query: string, items: T[], key: (t: T) => string | string[], max = 3, cutoff = 0.5): T[] {
  return items
    .map((t) => {
      const ks = key(t);
      return { t, d: Math.min(...(Array.isArray(ks) ? ks : [ks]).map((k) => distance(query, k))) };
    })
    .filter((x) => x.d <= cutoff)
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.t);
}

// ── the chart ──────────────────────────────────────────────────────────────

export interface ChartAccount {
  code: string;
  name: string;
  type: string;
  subtype: string;
  is_active: boolean;
}

export async function chart(db: PoolClient): Promise<ChartAccount[]> {
  return (await db.query<ChartAccount>(`select code, name, type, subtype, is_active from ${S}.accounts order by code`)).rows;
}

/**
 * The account a caller meant: its code as given, or — when what was given is a name, not a code in the
 * chart — the ONE account whose name matches it (the same name, or every word of it). None or several: null.
 */
export function accountByName(accounts: ChartAccount[], given: string, fits: (a: ChartAccount) => boolean = () => true): ChartAccount | null {
  const byCode = accounts.find((a) => a.code === given);
  if (byCode) return byCode;
  const q = norm(given);
  if (!q) return null;
  const pool = accounts.filter((a) => a.is_active !== false && fits(a));
  const same = pool.filter((a) => norm(a.name) === q);
  if (same.length) return same.length === 1 ? same[0]! : null;
  const words = q.split(' ').filter((w) => w.length > 1);
  const all = pool.filter((a) => {
    const n = ` ${norm(a.name)} `;
    return words.every((w) => n.includes(` ${w} `) || n.includes(` ${w}s `) || (w.endsWith('s') && n.includes(` ${w.slice(0, -1)} `)));
  });
  return all.length === 1 ? all[0]! : null;
}

/** "no account X in the chart" with the closest real accounts, by code and by name. */
export function unknownAccount(accounts: ChartAccount[], given: string[] | string, what = 'account'): Refusal {
  const list = Array.isArray(given) ? given : [given];
  const near = new Map<string, ChartAccount>();
  for (const g of list) for (const a of closest(g, accounts.filter((x) => x.is_active !== false), (x) => [x.code, x.name], 3, 0.5)) near.set(a.code, a);
  return {
    reason: `no ${what}${list.length > 1 ? 's' : ''} ${list.map((g) => `"${g}"`).join(', ')} in the chart of accounts`,
    did_you_mean: [...near.values()].slice(0, 5).map((a) => `${a.code} ${a.name} (${a.type})`),
  };
}

/** Account fields given as names become the one matching code; anything else is left for validate to refuse. */
export async function codesFromNames(db: PoolClient, codes: (string | undefined)[], fits?: (a: ChartAccount) => boolean): Promise<(string | undefined)[]> {
  if (!codes.some((c) => c)) return codes;
  const accts = await chart(db);
  return codes.map((c) => (c ? (accountByName(accts, c, fits)?.code ?? c) : c));
}

// ── parties and documents ──────────────────────────────────────────────────

export async function unknownParty(db: PoolClient, kind: 'customer' | 'vendor', name: string): Promise<Refusal> {
  const parties = (
    await db.query<{ name: string; outstanding_minor: number; open_documents: number }>(
      `select p.name, coalesce(sum(d.total_minor - d.paid_minor) filter (where d.status = 'open'), 0)::bigint as outstanding_minor,
              count(d.id) filter (where d.status = 'open')::int as open_documents
         from ${S}.parties p left join ${S}.documents d on d.party_id = p.id where p.kind = $1 group by p.id`,
      [kind],
    )
  ).rows;
  const near = closest(name, parties, (p) => p.name);
  return {
    reason: `no ${kind} called "${name}"${near.length ? ' (if it is a new one, create them with ledger.party.create first)' : '; create them with ledger.party.create first'}`,
    did_you_mean: near.map((p) => `${p.name}${Number(p.open_documents) ? ` (${p.open_documents} open, ${Number(p.outstanding_minor)} minor units outstanding)` : ''}`),
  };
}

export async function unknownDocument(db: PoolClient, kind: 'invoice' | 'bill', number: string): Promise<Refusal> {
  const docs = (
    await db.query<{ number: string; party: string; status: string; outstanding_minor: number }>(
      `select d.number, p.name as party, d.status, (d.total_minor - d.paid_minor)::bigint as outstanding_minor
         from ${S}.documents d join ${S}.parties p on p.id = d.party_id where d.kind = $1`,
      [kind],
    )
  ).rows;
  const near = closest(number, docs, (d) => [d.number, d.party]);
  return {
    reason: `no ${kind} ${number}`,
    did_you_mean: near.map((d) => `${d.number} — ${d.party}, ${d.status}, ${Number(d.outstanding_minor)} minor units outstanding`),
  };
}
