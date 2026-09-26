// Marketing's handlers: reads, a draft that stays inside the company (on), and
// two ask-first writes through doors that prove themselves by reading back.
import type { PoolClient } from '@neop/pgkit';
import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '@neop/template';

const S = 'marketing';

export const campaignsList: ReadAbility = {
  kind: 'read',
  async run(a: { status?: string }, ctx: ReadCtx) {
    const r = await ctx.db.query(
      `select id, name, channel, status, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date,
              currency, planned_spend_minor, ledger_account_code
         from ${S}.campaigns where ($1::text is null or status = $1) order by start_date`,
      [a.status ?? null],
    );
    return {
      generatedAt: new Date().toISOString(),
      empty: r.rows.length === 0,
      sources: { entries: r.rows.length, entry_ids: r.rows.map((x) => x.id), basis: `campaigns${a.status ? ` with status ${a.status}` : ''}` },
      campaigns: r.rows,
    };
  },
};

export const statsRead: ReadAbility = {
  kind: 'read',
  async run(a: { from: string; to: string; channel?: string }, ctx: ReadCtx) {
    const r = await ctx.db.query<{ channel: string; impressions: number; clicks: number; leads: number; days: number }>(
      `select channel, sum(impressions)::int as impressions, sum(clicks)::int as clicks, sum(leads)::int as leads, count(*)::int as days
         from ${S}.channel_stats where day between $1 and $2 and ($3::text is null or channel = $3) group by channel order by channel`,
      [a.from, a.to, a.channel ?? null],
    );
    const totals = r.rows.reduce((t, x) => ({ impressions: t.impressions + x.impressions, clicks: t.clicks + x.clicks, leads: t.leads + x.leads }), { impressions: 0, clicks: 0, leads: 0 });
    const days = r.rows.reduce((s, x) => s + x.days, 0);
    return {
      generatedAt: new Date().toISOString(),
      empty: days === 0,
      sources: { entries: days, entry_ids: [], basis: `daily channel stats ${a.from}..${a.to}` },
      rows: r.rows.map(({ days: _d, ...x }) => x),
      totals,
    };
  },
};

async function byRef(db: PoolClient, table: string, ref: string) {
  return (await db.query(`select * from ${S}.${table} where reference = $1`, [ref])).rows[0] ?? null;
}

export const postDraft: WriteAbility = {
  kind: 'write',
  async execute(a: { channel: string; text: string; campaign_id?: string }, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const r = await db.query<{ id: string }>(
        `insert into ${S}.posts (company_id, campaign_id, channel, text, reference) values ($1,$2,$3,$4,$5)
         on conflict (company_id, reference) do update set text = excluded.text returning id`,
        [ctx.company_id, a.campaign_id ?? null, a.channel, a.text, ctx.idempotencyKey],
      );
      return { external_ref: r.rows[0]!.id };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const row = await ctx.withDb((db) => byRef(db, 'posts', ctx.idempotencyKey));
    return { found: !!row, data: row && { id: row.id, status: row.status } };
  },
};

export const postSchedule: WriteAbility = {
  kind: 'write',
  check: (a: { at: string }) => (Date.parse(a.at) > Date.now() ? null : 'the post time must be in the future'),
  async execute(a: { channel: string; text: string; at: string; campaign_id?: string }, ctx: ExecCtx) {
    const sent = await ctx.doors.social.send({ channel: a.channel, text: a.text, at: a.at }, ctx.idempotencyKey);
    await ctx.withDb((db) =>
      db.query(
        `insert into ${S}.posts (company_id, campaign_id, channel, text, status, scheduled_at, reference, external_ref) values ($1,$2,$3,$4,'scheduled',$5,$6,$7)
         on conflict (company_id, reference) do update set status = 'scheduled', external_ref = excluded.external_ref`,
        [ctx.company_id, a.campaign_id ?? null, a.channel, a.text, a.at, ctx.idempotencyKey, sent.id],
      ),
    );
    return { external_ref: sent.id };
  },
  async readBack(a: { channel: string; text: string }, ctx: ExecCtx) {
    const m = await ctx.doors.social.lookup(ctx.idempotencyKey);
    return { found: !!m && m.channel === a.channel && m.text === a.text, data: m && { id: m.id, channel: m.channel, at: m.at } };
  },
};

export const spendCommit: WriteAbility = {
  kind: 'write',
  async execute(a: { campaign_id: string; vendor: string; amount_minor: number; currency: string }, ctx: ExecCtx) {
    const sent = await ctx.doors.ads.send({ vendor: a.vendor, amount_minor: a.amount_minor, currency: a.currency, campaign_id: a.campaign_id }, ctx.idempotencyKey);
    await ctx.withDb((db) =>
      db.query(
        `insert into ${S}.spend_commitments (company_id, campaign_id, vendor, currency, amount_minor, reference, external_ref) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (company_id, reference) do nothing`,
        [ctx.company_id, a.campaign_id, a.vendor, a.currency, a.amount_minor, ctx.idempotencyKey, sent.id],
      ),
    );
    return { external_ref: sent.id };
  },
  async readBack(a: { amount_minor: number }, ctx: ExecCtx) {
    const m = await ctx.doors.ads.lookup(ctx.idempotencyKey);
    return { found: !!m && m.amount_minor === a.amount_minor, data: m && { id: m.id, amount_minor: m.amount_minor, vendor: m.vendor } };
  },
};
