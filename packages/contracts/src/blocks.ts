// Blocks: an app's screens as data (WP §13 "blocks/ — descriptions of screens · never
// JavaScript"; §8 "block renderer, My Desk: once, on the platform"). The platform validates
// them at registration and one renderer on the desk draws them for every app.
//
// Two rules make blocks safe to render from any app:
//  · a block only READS — every `source` names a read ability of the same app;
//  · the only effect a block can cause is an ASK — a sentence sent to the app's assistant,
//    which the gate then treats like any other request (proposals, approvals, rules).
// Strings are text, never markup; the renderer escapes everything.

import type { Manifest } from './manifest.ts';

export type BlockFormat = 'money_minor' | 'money_minor_exact' | 'signed_money_minor' | 'date' | 'datetime' | 'number' | 'text' | 'month' | 'days';
export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'teal' | 'gray' | 'dark';

/** A read of the app's own data. Arg values may be templates ("{{month_from}}"). */
export interface BlockSource {
  ability: string;
  args?: Record<string, string | number | boolean>;
}
export interface BlockAction {
  label: string;
  style?: 'primary' | 'default' | 'danger';
  /** A sentence to the app's assistant (templated from the row/params). The gate decides what happens. */
  ask?: string;
  /** Open a form block by key. */
  form?: string;
  /** Open a block (a report, a table) in a panel. */
  open?: string;
  /** Go to a page block. */
  page?: string;
  /** Only show when these JSON pointers (on the row) are all truthy / all falsy. */
  when?: string | string[];
  unless?: string | string[];
}
export interface BlockField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'email' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  /** Template for the initial value ("{{today}}", "{{row.number}}"). */
  default?: string;
  options?: { value: string; label: string }[];
  /** Options read from the app: rows at `rows`, value/label templates. */
  options_source?: { source: BlockSource; rows: string; value: string; label: string };
  pattern?: string;
  min?: number;
  max?: number;
}
interface Base {
  title?: string;
  description?: string;
}
export type Block =
  | (Base & { block: 'page'; nav?: { label: string; icon?: string; order?: number }; params?: ('month' | 'quarter')[]; actions?: BlockAction[]; children: Block[] })
  | (Base & { block: 'stat'; source: BlockSource; value: { path: string; format?: BlockFormat }; empty_text?: string; footnote?: { path: string }; tone?: Tone; link?: string })
  | (Base & { block: 'stats'; source?: BlockSource; items: { title: string; source?: BlockSource; value: { path: string; format?: BlockFormat }; sub?: string; tone?: Tone; link?: string }[] })
  | (Base & {
      block: 'table';
      source: BlockSource;
      rows: string;
      columns: { label: string; path?: string; template?: string; format?: BlockFormat; align?: 'right'; strong?: boolean; pill?: Record<string, Tone>; hide_small?: boolean }[];
      row_actions?: BlockAction[];
      filters?: { param: string; label?: string; options: { value: string; label: string }[] }[];
      summary?: string;
      empty_text?: string;
    })
  | (Base & { block: 'statement'; source: BlockSource; sections: { label: string; rows: string; label_template: string; amount: string }[]; totals: { label: string; path: string; strong?: boolean }[] })
  | (Base & { block: 'kv'; source: BlockSource; items: { label: string; path: string; format?: BlockFormat; strong?: boolean }[] })
  | (Base & { block: 'checklist'; source: BlockSource; rows: string; item: { title: string; ok: string; detail?: string; link?: string } })
  | (Base & { block: 'list'; source: { platform: 'desk'; filter?: Record<string, string> }; item: Record<string, string> })
  | (Base & { block: 'tiles'; items: { title: string; description?: string; icon?: string; open?: string; page?: string }[] })
  | (Base & { block: 'form'; fields: BlockField[]; repeat?: { name: string; count: number; fields: BlockField[]; template: string; join?: string; min?: number }; ask: string; submit_label?: string });

export type BlockSet = Record<string, Block>;

const KINDS = ['page', 'stat', 'stats', 'table', 'statement', 'kv', 'checklist', 'list', 'tiles', 'form'] as const;
const FORMATS = ['money_minor', 'money_minor_exact', 'signed_money_minor', 'date', 'datetime', 'number', 'text', 'month', 'days'];
const TONES = ['green', 'red', 'amber', 'blue', 'violet', 'teal', 'gray', 'dark'];
const FIELD_TYPES = ['text', 'number', 'money', 'date', 'email', 'textarea', 'select', 'checkbox'];
const ALLOWED: Record<string, string[]> = {
  page: ['block', 'title', 'description', 'nav', 'params', 'actions', 'children'],
  stat: ['block', 'title', 'description', 'source', 'value', 'empty_text', 'footnote', 'tone', 'link'],
  stats: ['block', 'title', 'description', 'source', 'items'],
  table: ['block', 'title', 'description', 'source', 'rows', 'columns', 'row_actions', 'filters', 'summary', 'empty_text'],
  statement: ['block', 'title', 'description', 'source', 'sections', 'totals'],
  kv: ['block', 'title', 'description', 'source', 'items'],
  checklist: ['block', 'title', 'description', 'source', 'rows', 'item'],
  list: ['block', 'title', 'description', 'source', 'item'],
  tiles: ['block', 'title', 'description', 'items'],
  form: ['block', 'title', 'description', 'fields', 'repeat', 'ask', 'submit_label'],
};
const MAX_BYTES = 256 * 1024;

/** Why this app's block set is not acceptable, or null. Checks shape, reads-only sources, and references. */
export function blocksProblem(blocks: unknown, manifest: Pick<Manifest, 'app' | 'abilities'>): string | null {
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return 'blocks must be an object of key → block';
  const size = JSON.stringify(blocks).length;
  if (size > MAX_BYTES) return `blocks are ${size} bytes; at most ${MAX_BYTES}`;
  const set = blocks as Record<string, unknown>;
  const keys = new Set(Object.keys(set));
  const reads = new Set(manifest.abilities.filter((a) => a.kind === 'read').map((a) => a.key));
  const forms = new Set(Object.entries(set).filter(([, b]) => (b as any)?.block === 'form').map(([k]) => k));
  const pages = new Set(Object.entries(set).filter(([, b]) => (b as any)?.block === 'page').map(([k]) => k));

  // No markup, no script, no URLs that execute — anywhere, in any string.
  let bad: string | null = null;
  const scan = (v: unknown, at: string) => {
    if (bad) return;
    if (typeof v === 'string') {
      if (/<\s*\/?\s*[a-z!]/i.test(v) || /javascript:|data:text\/html|\bon[a-z]{3,}\s*=\s*["']?[a-z]/i.test(v)) bad = `${at}: markup or script is not allowed in blocks`;
    } else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${at}.${k}`);
    else if (!['number', 'boolean'].includes(typeof v) && v !== null) bad = `${at}: only JSON values are allowed`;
  };
  scan(blocks, 'blocks');
  if (bad) return bad;

  const source = (s: any, at: string): string | null => {
    if (!s || typeof s !== 'object') return `${at}: source required`;
    if (s.platform === 'desk') return null;
    if (typeof s.ability !== 'string' || !reads.has(s.ability)) return `${at}: source must be a read ability of ${manifest.app} (got ${JSON.stringify(s.ability)})`;
    if (s.args !== undefined && (typeof s.args !== 'object' || Array.isArray(s.args))) return `${at}: args must be an object`;
    return null;
  };
  const pointer = (p: unknown, at: string) => (typeof p === 'string' && (p === '' || p.startsWith('/')) ? null : `${at}: must be a JSON pointer like /totals/net`);
  const action = (a: any, at: string): string | null => {
    if (!a || typeof a.label !== 'string') return `${at}: an action needs a label`;
    const targets = ['ask', 'form', 'open', 'page'].filter((k) => a[k] !== undefined);
    if (targets.length !== 1) return `${at}: an action does exactly one of ask, form, open, page`;
    if (a.form && !forms.has(a.form)) return `${at}: no form block "${a.form}"`;
    if (a.open && !keys.has(a.open)) return `${at}: no block "${a.open}"`;
    if (a.page && !pages.has(a.page)) return `${at}: no page "${a.page}"`;
    if (a.ask !== undefined && (typeof a.ask !== 'string' || !a.ask.trim())) return `${at}: ask must be a sentence`;
    for (const k of ['when', 'unless']) for (const ptr of a[k] === undefined ? [] : [a[k]].flat()) if (pointer(ptr, `${at}.${k}`)) return pointer(ptr, `${at}.${k}`);
    return null;
  };
  const field = (f: any, at: string): string | null => {
    if (!f || typeof f.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(f.name)) return `${at}: field name must be snake_case`;
    if (!FIELD_TYPES.includes(f.type)) return `${at}: unknown field type ${f.type}`;
    if (f.type === 'select' && !f.options && !f.options_source) return `${at}: a select needs options`;
    if (f.options_source) return source(f.options_source.source, `${at}.options_source`) ?? pointer(f.options_source.rows, `${at}.options_source.rows`);
    return null;
  };

  const check = (b: any, at: string, depth: number): string | null => {
    if (depth > 4) return `${at}: blocks nest at most 4 deep`;
    if (!b || typeof b !== 'object' || !(KINDS as readonly string[]).includes(b.block)) return `${at}: unknown block kind ${JSON.stringify(b?.block)}`;
    const extra = Object.keys(b).filter((k) => !ALLOWED[b.block]!.includes(k));
    if (extra.length) return `${at}: ${b.block} does not take ${extra.join(', ')}`;
    switch (b.block) {
      case 'page':
        if (!Array.isArray(b.children) || !b.children.length) return `${at}: a page needs children`;
        for (const [i, a] of (b.actions ?? []).entries()) {
          const p = action(a, `${at}.actions[${i}]`);
          if (p) return p;
        }
        for (const [i, c] of b.children.entries()) {
          const p = check(c, `${at}.children[${i}]`, depth + 1);
          if (p) return p;
        }
        return null;
      case 'stat':
        return source(b.source, at) ?? pointer(b.value?.path, `${at}.value.path`) ?? (b.value?.format && !FORMATS.includes(b.value.format) ? `${at}: unknown format` : null) ?? (b.tone && !TONES.includes(b.tone) ? `${at}: unknown tone` : null);
      case 'stats':
        if (!Array.isArray(b.items) || !b.items.length) return `${at}: stats need items`;
        if (b.source) {
          const p = source(b.source, at);
          if (p) return p;
        }
        for (const [i, it] of b.items.entries()) {
          if (!it.source && !b.source) return `${at}.items[${i}]: needs a source (its own or the block's)`;
          const p = (it.source ? source(it.source, `${at}.items[${i}]`) : null) ?? pointer(it.value?.path, `${at}.items[${i}].value.path`) ?? (it.tone && !TONES.includes(it.tone) ? `${at}.items[${i}]: unknown tone` : null);
          if (p) return p;
        }
        return null;
      case 'table': {
        const p = source(b.source, at) ?? pointer(b.rows, `${at}.rows`);
        if (p) return p;
        if (!Array.isArray(b.columns) || !b.columns.length) return `${at}: a table needs columns`;
        for (const [i, c] of b.columns.entries()) {
          if (typeof c.label !== 'string' || (!c.path && !c.template)) return `${at}.columns[${i}]: needs a label and a path or template`;
          if (c.path && pointer(c.path, `${at}.columns[${i}]`)) return pointer(c.path, `${at}.columns[${i}]`);
          if (c.format && !FORMATS.includes(c.format)) return `${at}.columns[${i}]: unknown format`;
          if (c.pill && Object.values(c.pill).some((t) => !TONES.includes(t as string))) return `${at}.columns[${i}]: unknown tone`;
        }
        for (const [i, a] of (b.row_actions ?? []).entries()) {
          const q = action(a, `${at}.row_actions[${i}]`);
          if (q) return q;
        }
        return null;
      }
      case 'statement':
        return source(b.source, at) ?? (Array.isArray(b.sections) && Array.isArray(b.totals) ? null : `${at}: a statement needs sections and totals`);
      case 'kv':
        return source(b.source, at) ?? (Array.isArray(b.items) && b.items.every((x: any) => typeof x.label === 'string' && !pointer(x.path, at)) ? null : `${at}: kv items need a label and a pointer`);
      case 'checklist':
        return source(b.source, at) ?? pointer(b.rows, `${at}.rows`) ?? (b.item && typeof b.item.title === 'string' && typeof b.item.ok === 'string' ? null : `${at}: a checklist item needs title and ok pointers`);
      case 'list':
        return source(b.source, at);
      case 'tiles':
        for (const [i, t] of (b.items ?? []).entries()) {
          if (typeof t.title !== 'string') return `${at}.items[${i}]: a tile needs a title`;
          if (t.open && !keys.has(t.open)) return `${at}.items[${i}]: no block "${t.open}"`;
          if (t.page && !pages.has(t.page)) return `${at}.items[${i}]: no page "${t.page}"`;
        }
        return null;
      case 'form': {
        if (typeof b.ask !== 'string' || !b.ask.trim()) return `${at}: a form turns into an ask; ask is required`;
        if (!Array.isArray(b.fields)) return `${at}: a form needs fields`;
        for (const [i, f] of [...b.fields, ...(b.repeat?.fields ?? [])].entries()) {
          const p = field(f, `${at}.fields[${i}]`);
          if (p) return p;
        }
        if (b.repeat && (typeof b.repeat.template !== 'string' || !Number.isInteger(b.repeat.count) || b.repeat.count < 1 || b.repeat.count > 20)) return `${at}.repeat: needs a template and a count of 1–20`;
        return null;
      }
    }
    return null;
  };
  for (const [k, b] of Object.entries(set)) {
    if (!/^[a-z][a-z0-9_.-]{0,80}$/.test(k)) return `block key ${JSON.stringify(k)} is not a simple name`;
    const p = check(b, k, 0);
    if (p) return p;
  }
  return null;
}
