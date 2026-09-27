import type { Setting } from './setting.ts';

export interface AbilityEffects {
  /** True when the effect leaves the company (email, post, payment). */
  external?: boolean;
  /** JSON pointer to a list of recipient addresses in args. */
  recipients?: string;
  /** JSON pointer to an integer amount in minor units in args. */
  amount_minor?: string;
  /** JSON pointer to an ISO currency code in args, or a fixed code. */
  currency?: string;
  /** The ability moves or books money: a call whose amount cannot be measured is refused. */
  money?: boolean;
}

export interface ManifestAbility {
  key: string;
  version: string;
  title: string;
  description: string;
  kind: 'read' | 'write';
  floor: Setting;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  effects?: AbilityEffects;
  /** How a write is verified after it runs. */
  verifyWith?: string;
  doors?: string[];
}

export interface Manifest {
  app: string;
  name: string;
  subject: string;
  description: string;
  version: string;
  contract_version: string;
  abilities: ManifestAbility[];
  doors: { key: string; scopes: string[] }[];
  /**
   * Borrowed abilities (reads, called through the gateway) and a2a hand-offs
   * (`ability: "tasks.open"`: this app may hand whole tasks to that app).
   */
  uses: { app: string; ability: string; range: string; floor?: Setting }[];
  skills: { key: string; path: string; requires: string[] }[];
  packages: { key: string; version: string }[];
  blocks: string[];
  /**
   * WP §11 "personal-data columns are tagged in the manifest so deletion can find them".
   * Each entry: a table in the app's own schema, the columns in it that hold a person's data,
   * and `subject_key` — the column whose value identifies the person (the data subject) the
   * row is about. The DBA's export (subject access) and erase read only these columns.
   */
  personal_data?: PersonalDataTag[];
}

export interface PersonalDataTag {
  table: string;
  columns: string[];
  subject_key: string;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Problems with a manifest's personal-data tags (empty when well formed). */
export function personalDataProblems(m: Pick<Manifest, 'personal_data'>): string[] {
  const tags = m.personal_data;
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) return ['personal_data must be a list of {table, columns, subject_key}'];
  const out: string[] = [];
  const seen = new Set<string>();
  tags.forEach((t, i) => {
    const at = `personal_data[${i}]`;
    if (!t || typeof t !== 'object') return void out.push(`${at} must be an object`);
    if (typeof t.table !== 'string' || !IDENT.test(t.table)) out.push(`${at}.table must be a table name in the app's own schema (no schema prefix)`);
    else if (seen.has(t.table)) out.push(`${at}: ${t.table} is tagged twice`);
    else seen.add(t.table);
    if (!Array.isArray(t.columns) || !t.columns.length || t.columns.some((c) => typeof c !== 'string' || !IDENT.test(c))) out.push(`${at}.columns must be a non-empty list of column names`);
    else if (new Set(t.columns).size !== t.columns.length) out.push(`${at}.columns lists a column twice`);
    if (typeof t.subject_key !== 'string' || !IDENT.test(t.subject_key)) out.push(`${at}.subject_key must be a column name`);
    else if (Array.isArray(t.columns) && t.columns.includes(t.subject_key)) out.push(`${at}: subject_key ${t.subject_key} cannot also be a personal column (it is how the person is found)`);
    if (['company_id'].includes(t.subject_key) || (Array.isArray(t.columns) && t.columns.includes('company_id'))) out.push(`${at}: company_id is never personal data nor a subject`);
  });
  return out;
}

/** Resolve an RFC 6901 JSON pointer against a value. */
export function getPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
