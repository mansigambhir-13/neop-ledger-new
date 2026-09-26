// blocks.test · Ledger's screens are data the platform can trust: they only read, their only
// effect is an ask, and they carry no markup (WP §13 "never JavaScript").
import { describe, expect, it } from 'vitest';
import { blocksProblem } from '@neop/contracts';
import { ledgerApp } from '../src/index.ts';

const app = await ledgerApp();
const ok = (b: unknown) => blocksProblem(b, app.manifest);

describe('Ledger blocks', () => {
  it('are all valid, and cover every screen the desk shows for Ledger', () => {
    expect(ok(app.blocks)).toBeNull();
    const pages = Object.entries(app.blocks!).filter(([, b]: any) => b.block === 'page').map(([k]) => k);
    expect(pages.sort()).toEqual(['accounts', 'bills', 'close', 'gst', 'invoices', 'overview', 'reconcile', 'reports', 'rules', 'transactions']);
    expect(app.blocks!.home).toMatchObject({ block: 'stats' });
  });

  it('every source is a read of Ledger; writes happen only as asks', () => {
    const sources: string[] = [];
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (typeof v.ability === 'string') sources.push(v.ability);
        Object.values(v).forEach(walk);
      }
    };
    walk(app.blocks);
    const reads = new Set(app.manifest.abilities.filter((a) => a.kind === 'read').map((a) => a.key));
    expect(sources.length).toBeGreaterThan(20);
    for (const s of sources) expect(reads.has(s), s).toBe(true);
  });
});

describe('the validator refuses', () => {
  const page = (children: unknown[], extra = {}) => ({ p: { block: 'page', title: 'x', children, ...extra } });
  const table = { block: 'table', source: { ability: 'ledger.accounts.list' }, rows: '/accounts', columns: [{ label: 'Code', path: '/code' }] };
  it('a write used as a source', () => {
    expect(ok(page([{ ...table, source: { ability: 'ledger.journal.post' } }]))).toMatch(/must be a read ability/);
  });
  it('an ability of another app', () => {
    expect(ok(page([{ ...table, source: { ability: 'marketing.campaigns.list' } }]))).toMatch(/must be a read ability/);
  });
  it('markup and script in any string', () => {
    expect(ok(page([{ ...table, title: '<img src=x onerror=alert(1)>' }]))).toMatch(/markup or script/);
    expect(ok(page([table], { actions: [{ label: 'Go', ask: 'javascript:alert(1)' }] }))).toMatch(/markup or script/);
  });
  it('unknown block kinds and unknown keys (no escape hatches)', () => {
    expect(ok(page([{ block: 'html', body: 'x' }]))).toMatch(/unknown block kind/);
    expect(ok(page([{ ...table, onClick: 'x' }]))).toMatch(/does not take onClick/);
  });
  it('actions that do more than one thing, or point nowhere', () => {
    expect(ok(page([table], { actions: [{ label: 'x', ask: 'hi', form: 'f' }] }))).toMatch(/exactly one/);
    expect(ok(page([table], { actions: [{ label: 'x', form: 'form.nope' }] }))).toMatch(/no form block/);
  });
  it('a form without an ask', () => {
    expect(ok({ f: { block: 'form', title: 'x', fields: [] } })).toMatch(/ask is required/);
  });
});
