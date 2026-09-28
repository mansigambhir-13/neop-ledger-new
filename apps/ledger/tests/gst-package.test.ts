// gst-package.test · the nep-gst handlers offline (no sandbox, no network): the
// schema shipped in the package is the one the handlers enforce, a built return
// passes an independent validator (Ajv) and the fake GSP's GSTN checks, the
// tax-head split follows the books or a stated assumption and refuses to guess,
// and the package's own selftest passes.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gstnCheck3b } from '@neop/testkit';
import { LEDGER_ROOT } from '../src/index.ts';

const DIR = path.resolve(LEDGER_ROOT, '../../registry/nep-gst');
const H: any = await import(path.join(DIR, 'handlers.js'));
const GSTIN = '27AAPFU0939F1ZV';

// Ajv, as the template resolves it: an implementation independent of the package's own validator.
const templateRequire = createRequire(createRequire(import.meta.url).resolve('@neop/template'));
const { Ajv } = templateRequire('ajv');

/** A ctx whose host reads answer from fixed books. */
function booksCtx(o: { out: number; inp: number; revenue: number; accounts: { code: string; name: string; subtype: string; moved?: number }[] }) {
  const calls: string[] = [];
  const src = { entries: 3, entry_ids: ['e1'], basis: 'journal entries dated 2026-09-01..2026-09-30' };
  const reads: Record<string, (a: any) => Promise<any>> = {
    'ledger.report.vat_summary': async () => ({ output_tax_minor: o.out, input_tax_minor: o.inp, net_payable_minor: o.out - o.inp, sources: src }),
    'ledger.report.pnl': async () => ({ totals: { revenue_minor: o.revenue }, sources: src }),
    'ledger.accounts.list': async () => ({ accounts: o.accounts.map((a) => ({ ...a, type: 'x' })) }),
    'ledger.account.ledger': async (a) => {
      const acct = o.accounts.find((x) => x.code === a.account_code)!;
      return { opening_minor: 1000, closing_minor: 1000 + (acct.moved ?? 0) };
    },
  };
  return {
    calls,
    ctx: { reads: new Proxy({}, { get: (_, k: string) => (a: any) => (calls.push(k), reads[k]!(a)) }) },
  };
}

describe('nep-gst handlers (offline)', () => {
  it('the schema file in the package is the schema the handlers enforce', async () => {
    expect(H.GSTR3B_SCHEMA).toEqual(JSON.parse(await readFile(path.join(DIR, 'gstr3b.schema.json'), 'utf8')));
  });

  it('the copy built into Ledger (neos install) is this source, byte for byte, pinned by the artifact hash', async () => {
    const built = path.join(LEDGER_ROOT, 'src/packages/nep-gst');
    expect(await readFile(path.join(built, 'handlers.js'), 'utf8')).toBe(await readFile(path.join(DIR, 'handlers.js'), 'utf8'));
    for (const f of ['001_returns.sql', '002_gstr3b.sql']) expect(await readFile(path.join(built, 'migrations', f), 'utf8')).toBe(await readFile(path.join(DIR, 'migrations', f), 'utf8'));
    const { buildPackage, readLock, verifyInstalledPackage } = await import('@neop/template');
    const pin = (await readLock(path.join(LEDGER_ROOT, 'packages.lock.json'))).packages.find((p) => p.key === 'nep-gst')!;
    expect(pin.version).toBe((await buildPackage(DIR)).manifest.version);
    expect(await verifyInstalledPackage(LEDGER_ROOT, pin)).toMatchObject({ ok: true });
  });

  it('its selftest passes, offline', async () => {
    const r = await H.selftest();
    expect(r.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a return built from figures passes Ajv on the schema and the GSP’s own GSTN checks; the package validator agrees on a bad one', () => {
    const doc = H.buildReturn({ gstin: GSTIN, ret_period: '092026', taxable_minor: 58_000_000, output: H.splitByAssumption(10_440_001, 'intra_state'), input: H.splitByAssumption(3_600_000, 'inter_state') });
    const ajv = new Ajv({ allErrors: true, strict: false });
    const v = ajv.compile(H.GSTR3B_SCHEMA);
    expect(v(doc) ? null : ajv.errorsText(v.errors)).toBeNull();
    expect(gstnCheck3b(doc, GSTIN, '092026')).toBeNull();
    expect(doc.sup_details.osup_det).toEqual({ txval: 580000, iamt: 0, camt: 52200.01, samt: 52200, csamt: 0 });
    expect(doc.itc_elg.itc_net).toEqual({ iamt: 36000, camt: 0, samt: 0, csamt: 0 });
    const bad = structuredClone(doc);
    delete bad.itc_elg.itc_net;
    expect(v(bad)).toBe(false);
    expect(H.validateSchema(H.GSTR3B_SCHEMA, bad).length).toBeGreaterThan(0);
    expect(gstnCheck3b(bad, GSTIN, '092026')).toMatch(/itc_net/);
  });

  it('with one tax account per head the split is read from the books, and must add up to the VAT summary', async () => {
    const accounts = [
      { code: '2101', name: 'Output CGST', subtype: 'tax_output', moved: 400 },
      { code: '2102', name: 'Output SGST', subtype: 'tax_output', moved: 400 },
      { code: '2103', name: 'Output IGST', subtype: 'tax_output', moved: 1000 },
      { code: '1301', name: 'Input IGST credit', subtype: 'tax_input', moved: 700 },
    ];
    const { ctx } = booksCtx({ out: 1800, inp: 700, revenue: 10000, accounts });
    const f = await H.figuresFromBooks(ctx, '2026-09', { assume_supply: null });
    expect(f.output).toEqual({ iamt: 1000, camt: 400, samt: 400, csamt: 0 });
    expect(f.input).toEqual({ iamt: 700, camt: 0, samt: 0, csamt: 0 });
    expect(f.split_basis).toMatch(/^by head from the ledger/);
    const off = booksCtx({ out: 1900, inp: 700, revenue: 10000, accounts });
    await expect(H.figuresFromBooks(off.ctx, '2026-09', {})).rejects.toMatchObject({ definite: true, message: expect.stringMatching(/do not add up/) });
  });

  it('with one output and one input account it follows the configured assumption, says so, and refuses without one', async () => {
    const accounts = [
      { code: '2100', name: 'GST output payable', subtype: 'tax_output' },
      { code: '1300', name: 'GST input credit', subtype: 'tax_input' },
    ];
    const { ctx, calls } = booksCtx({ out: 1801, inp: 700, revenue: 10000, accounts });
    const f = await H.figuresFromBooks(ctx, '2026-09', { assume_supply: 'intra_state' });
    expect(f.output).toEqual({ iamt: 0, camt: 901, samt: 900, csamt: 0 });
    expect(f.split_basis).toMatch(/^ASSUMED intra_state/);
    expect(f.assumptions[0]).toMatch(/^A1: ASSUMED/);
    expect(calls).not.toContain('ledger.account.ledger');
    await expect(H.figuresFromBooks(booksCtx({ out: 1, inp: 0, revenue: 1, accounts }).ctx, '2026-09', {})).rejects.toMatchObject({
      definite: true,
      message: expect.stringMatching(/cannot tell intra-state from inter-state/),
    });
  });

  it('refuses a chart where only some tax accounts name their head, and negative figures', async () => {
    const mixed = [
      { code: '2100', name: 'GST output payable', subtype: 'tax_output' },
      { code: '2103', name: 'Output IGST', subtype: 'tax_output' },
    ];
    await expect(H.figuresFromBooks(booksCtx({ out: 1, inp: 0, revenue: 1, accounts: mixed }).ctx, '2026-09', { assume_supply: 'intra_state' })).rejects.toMatchObject({
      message: expect.stringMatching(/only some tax accounts/),
    });
    await expect(H.figuresFromBooks(booksCtx({ out: -5, inp: 0, revenue: 1, accounts: [] }).ctx, '2026-09', { assume_supply: 'intra_state' })).rejects.toMatchObject({
      message: expect.stringMatching(/negative figure/),
    });
  });
});
