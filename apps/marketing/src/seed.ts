import { withCompany, type Pool } from '@neop/pgkit';

export const DIWALI_CAMPAIGN = '7d1c2f0e-5b1a-4c3e-9a47-0c1d2e3f4a5b';

export async function seedMarketing(pool: Pool, companyId: string): Promise<void> {
  await withCompany(pool, companyId, async (c) => {
    await c.query(
      `insert into marketing.campaigns (id, company_id, name, channel, status, start_date, end_date, currency, planned_spend_minor)
       values ($1, $2, 'Diwali sale', 'search', 'active', '2026-09-15', '2026-10-31', 'INR', 15000000),
              (gen_random_uuid(), $2, 'Winter launch', 'social', 'planned', '2026-11-15', '2026-12-31', 'INR', 8000000)
       on conflict do nothing`,
      [DIWALI_CAMPAIGN, companyId],
    );
    for (let d = 1; d <= 30; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      for (const [channel, base] of [['search', 900], ['social', 1400]] as const) {
        await c.query(
          `insert into marketing.channel_stats (company_id, channel, day, impressions, clicks, leads) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [companyId, channel, day, base * 10 + d * 7, base / 10 + d, Math.floor((base / 100 + d) / 4)],
        );
      }
    }
  });
}
