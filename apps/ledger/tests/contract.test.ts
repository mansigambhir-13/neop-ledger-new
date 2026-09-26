// contract.test · every result matches its manifest schema; the manifest is
// complete (every ability has a handler and vice versa) and well formed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, type Pilot } from './harness.ts';
import { ledgerApp, manifest } from '../src/index.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const READ_ARGS: Record<string, unknown> = {
  'ledger.report.pnl': { from: '2026-07-01', to: '2026-09-30' },
  'ledger.report.balance_sheet': { as_of: '2026-09-30' },
  'ledger.report.cash_flow': { from: '2026-07-01', to: '2026-09-30' },
  'ledger.report.trial_balance': { as_of: '2026-09-30' },
  'ledger.report.aging': { kind: 'receivable', as_of: '2026-09-30' },
  'ledger.report.vat_summary': { from: '2026-07-01', to: '2026-09-30' },
  'ledger.budget.remaining': { account_code: '6400', month: '2026-09' },
  'ledger.accounts.list': { as_of: '2026-09-30' },
  'ledger.account.ledger': { account_code: '1010', from: '2026-09-01', to: '2026-09-30' },
  'ledger.journal.list': { from: '2026-09-01', to: '2026-09-30' },
  'ledger.documents.list': { kind: 'invoice', status: 'all' },
  'ledger.parties.list': {},
  'ledger.bank.unreconciled': {},
  'ledger.periods.status': {},
  'ledger.settings.get': {},
  'ledger.report.aging_analysis': { kind: 'payable', as_of: '2026-09-30' },
  'ledger.report.cash_forecast': { as_of: '2026-09-30', weeks: 4 },
  'ledger.report.tax_return': { from: '2026-09-01', to: '2026-09-30' },
  'ledger.report.export': { report: 'trial_balance', format: 'md', as_of: '2026-09-30' },
  'ledger.document.extract': { filename: 'lines.csv', content_type: 'text/csv', content_base64: Buffer.from('date,amount\n2026-09-01,100\n').toString('base64') },
};

describe('contract', () => {
  it('declares every handler and only declared handlers', async () => {
    const app = await ledgerApp();
    expect(Object.keys(app.abilities).sort()).toEqual(manifest.abilities.map((a) => a.key).sort());
    for (const a of manifest.abilities) {
      expect(a.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['on', 'ask_first', 'off']).toContain(a.floor);
      if (a.effects?.external) expect(a.floor).not.toBe('on');
    }
  });

  it.each(Object.entries(READ_ARGS))('%s returns a result that matches its schema', async (key, args) => {
    const r = await P.api('POST', `/api/apps/ledger/read/${key}`, args);
    expect(r.status).toBe(200);
    expect(P.backend.core.validators.checkOutput(key, r.body.result)).toBeNull();
  });

  it('rejects arguments outside the schema before running anything', async () => {
    const r = await P.api('POST', '/api/apps/ledger/read/ledger.report.pnl', { from: 'last month' });
    expect(r.status).toBe(400);
  });

  it('serves its manifest to the registry through the gateway', async () => {
    const r = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'manifest', company_id: null });
    expect(r.status).toBe(200);
    expect(r.body.app).toBe('ledger');
  });
});
