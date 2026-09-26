import { conformance } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { DIWALI_CAMPAIGN, marketingApp, seedMarketing } from '../src/index.ts';

conformance({
  app: async () => ({ def: await marketingApp(), seed: seedMarketing }),
  companions: async () => [{ def: await ledgerApp(), seed: seedLedger }],
  reads: {
    'marketing.campaigns.list': {},
    'marketing.stats.read': { from: '2026-09-01', to: '2026-09-30' },
  },
  gatedWrite: { key: 'marketing.spend.commit', args: { campaign_id: DIWALI_CAMPAIGN, vendor: 'Google Ads', amount_minor: 2_500_000, currency: 'INR' } },
});
