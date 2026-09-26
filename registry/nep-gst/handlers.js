// nep-gst handlers. Runs inside the Deno sandbox: no network, no files, no
// environment. Everything it can do is on ctx: its own table, the book, and
// the gst_portal door (only on the approved path, with the proposal's key).

const T = 'nep_gst_returns';

function view(r) {
  return {
    id: r.id, period: r.period, status: r.status,
    net_payable_minor: Number(r.net_payable_minor), credit_carried_minor: Number(r.credit_carried_minor),
    ack_ref: r.ack_ref ?? null,
  };
}

export const abilities = {
  'gst.returns.list': {
    async run(args, ctx) {
      const rows = await ctx.tables.select(T, args.period ? { period: args.period } : {});
      return {
        generatedAt: new Date().toISOString(),
        empty: rows.length === 0,
        sources: { entries: rows.length, entry_ids: rows.map((r) => r.id), basis: 'GSTR-3B returns prepared by nep-gst' },
        returns: rows.map(view),
      };
    },
  },

  'gst.gstr3b.prepare': {
    async execute(args, ctx) {
      const net = args.output_tax_minor - args.input_tax_minor;
      const row = await ctx.tables.insert(T, {
        period: args.period, currency: args.currency,
        output_tax_minor: args.output_tax_minor, input_tax_minor: args.input_tax_minor,
        net_payable_minor: Math.max(net, 0), credit_carried_minor: Math.max(-net, 0),
        status: 'draft', reference: ctx.idempotency_key,
      });
      await ctx.book.step(`GSTR-3B draft for ${args.period}: net payable ${Math.max(net, 0)}, credit carried ${Math.max(-net, 0)} (paise)`);
      return { external_ref: row.id };
    },
    async readBack(_x, ctx) {
      const rows = await ctx.tables.select(T, { reference: ctx.idempotency_key });
      return { found: rows.length === 1, data: rows[0] ? view(rows[0]) : null };
    },
  },

  'gst.gstr3b.file': {
    async execute(args, ctx) {
      const drafts = await ctx.tables.select(T, { period: args.period, status: 'draft' });
      if (!drafts.length) {
        const e = new Error(`no draft GSTR-3B for ${args.period}; prepare it first`);
        e.definite = true;
        throw e;
      }
      const d = drafts[drafts.length - 1];
      const sent = await ctx.doors.gst_portal.send({ form: 'GSTR-3B', period: args.period, net_payable_minor: Number(d.net_payable_minor), currency: d.currency });
      await ctx.tables.update(T, { id: d.id }, { status: 'filed', ack_ref: sent.id });
      return { external_ref: sent.id };
    },
    async readBack({ args }, ctx) {
      const m = await ctx.doors.gst_portal.lookup();
      return { found: !!m && m.period === args.period && m.form === 'GSTR-3B', data: m };
    },
  },
};
