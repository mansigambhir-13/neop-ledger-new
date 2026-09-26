// nep-gst handlers. Runs inside the Deno sandbox: no network, no files, no
// environment. Everything it can do is on ctx: its own table, the book, the host
// reads its manifest requires (ctx.reads — read-only, the switchboard applies),
// and the gst_portal door (only on the approved path, with the proposal's key).
//
// The figures come from the books, never from the assistant: the assistant
// names the month; prepare reads the ledger (VAT/GST summary, P&L, the tax
// accounts) and builds the GSTR-3B in the GSTN format. Save sends that exact
// document to the GSP; filing is a separate ask-first step bound (by hash) to
// the saved document, signed with an EVC OTP a person enters — never the
// assistant.
//
// ASSUMPTIONS (stated on every return as split_basis/assumptions, and in the skill):
//  A1. Tax heads. If every tax account in the chart names its head (IGST /
//      CGST / SGST or UTGST / cess), each head is read from its own account.
//      If none does (one "GST output" and one "GST input" account, as in the
//      demo books), the books cannot tell intra- from inter-state supply: the
//      GSP door's configured `assume_supply` decides — intra_state splits each
//      total into CGST = SGST (the odd paisa to CGST), inter_state puts it all
//      in IGST. With no assumption configured, prepare refuses. A chart where
//      only some tax accounts name a head is refused.
//  A2. Outward supplies (3.1a txval) = revenue-subtype income for the month.
//      Zero-rated, nil/exempt, non-GST and reverse-charge supplies are 0: the
//      books do not mark them.
//  A3. All input tax is "all other ITC" (4A5 OTH); imports, ISD, reversals and
//      ineligible ITC are 0. 3.2 inter-state supplies to unregistered persons
//      (place-of-supply table) is empty: the books do not record place of supply.
//  A4. Interest and late fee are 0 (the portal computes them).
//  A5. Output and input tax are the month's movement on the tax accounts as
//      ledger.report.vat_summary returns it (a GST payment posted to the output
//      account in the same month reduces it; prepare refuses a negative figure).

const T = 'nep_gst_returns';
const VAT = 'ledger.report.vat_summary';
const PNL = 'ledger.report.pnl';
const ACCTS = 'ledger.accounts.list';
const ACCT_LEDGER = 'ledger.account.ledger';

// Generated from gstr3b.schema.json (a test checks they are identical).
export const GSTR3B_SCHEMA = {"$id":"nep-gst/gstr3b.schema.json","title":"GSTR-3B return (GSTN RETSAVE data); amounts in rupees to 2 decimals","type":"object","additionalProperties":false,"required":["gstin","ret_period","sup_details","sup_inter","itc_elg","inward_sup","intr_ltfee"],"properties":{"gstin":{"type":"string","pattern":"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"},"ret_period":{"type":"string","pattern":"^(0[1-9]|1[0-2])[0-9]{4}$"},"sup_details":{"type":"object","additionalProperties":false,"required":["osup_det","osup_zero","osup_nil_exmp","isup_rev","osup_nongst"],"properties":{"osup_det":{"type":"object","additionalProperties":false,"required":["txval","iamt","camt","samt","csamt"],"properties":{"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}},"osup_zero":{"type":"object","additionalProperties":false,"required":["txval","iamt","csamt"],"properties":{"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}},"osup_nil_exmp":{"type":"object","additionalProperties":false,"required":["txval"],"properties":{"txval":{"type":"number","minimum":0,"x-decimals":2}}},"isup_rev":{"type":"object","additionalProperties":false,"required":["txval","iamt","camt","samt","csamt"],"properties":{"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}},"osup_nongst":{"type":"object","additionalProperties":false,"required":["txval"],"properties":{"txval":{"type":"number","minimum":0,"x-decimals":2}}}}},"sup_inter":{"type":"object","additionalProperties":false,"required":["unreg_details","comp_details","uin_details"],"properties":{"unreg_details":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["pos","txval","iamt"],"properties":{"pos":{"type":"string","pattern":"^(0[1-9]|[1-3][0-9]|97|99)$"},"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2}}}},"comp_details":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["pos","txval","iamt"],"properties":{"pos":{"type":"string","pattern":"^(0[1-9]|[1-3][0-9]|97|99)$"},"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2}}}},"uin_details":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["pos","txval","iamt"],"properties":{"pos":{"type":"string","pattern":"^(0[1-9]|[1-3][0-9]|97|99)$"},"txval":{"type":"number","minimum":0,"x-decimals":2},"iamt":{"type":"number","minimum":0,"x-decimals":2}}}}}},"itc_elg":{"type":"object","additionalProperties":false,"required":["itc_avl","itc_rev","itc_net","itc_inelg"],"properties":{"itc_avl":{"type":"array","minItems":5,"maxItems":5,"items":{"type":"object","additionalProperties":false,"required":["ty","iamt","camt","samt","csamt"],"properties":{"ty":{"type":"string","enum":["IMPG","IMPS","ISRC","ISD","OTH"]},"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}}},"itc_rev":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"object","additionalProperties":false,"required":["ty","iamt","camt","samt","csamt"],"properties":{"ty":{"type":"string","enum":["RUL","OTH"]},"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}}},"itc_net":{"type":"object","additionalProperties":false,"required":["iamt","camt","samt","csamt"],"properties":{"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}},"itc_inelg":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"object","additionalProperties":false,"required":["ty","iamt","camt","samt","csamt"],"properties":{"ty":{"type":"string","enum":["RUL","OTH"]},"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}}}}},"inward_sup":{"type":"object","additionalProperties":false,"required":["isup_details"],"properties":{"isup_details":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"object","additionalProperties":false,"required":["ty","inter","intra"],"properties":{"ty":{"type":"string","enum":["GST","NONGST"]},"inter":{"type":"number","minimum":0,"x-decimals":2},"intra":{"type":"number","minimum":0,"x-decimals":2}}}}}},"intr_ltfee":{"type":"object","additionalProperties":false,"required":["intr_details"],"properties":{"intr_details":{"type":"object","additionalProperties":false,"required":["iamt","camt","samt","csamt"],"properties":{"iamt":{"type":"number","minimum":0,"x-decimals":2},"camt":{"type":"number","minimum":0,"x-decimals":2},"samt":{"type":"number","minimum":0,"x-decimals":2},"csamt":{"type":"number","minimum":0,"x-decimals":2}}}}}}};

// ── pure helpers (exported for the selftest and unit tests) ───────────────

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/** A small JSON-Schema (draft-07 subset) validator: the sandbox has no npm. Returns a list of problems. */
export function validateSchema(schema, v, at = '') {
  const errs = [];
  const where = at || '/';
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => TYPES[t]?.(v))) return [`${where}: must be ${ts.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${where}: must be one of ${schema.enum.join(', ')}`);
  if (typeof v === 'string' && schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${where}: does not match ${schema.pattern}`);
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${where}: must be >= ${schema.minimum}`);
    if (schema['x-decimals'] !== undefined) {
      const f = 10 ** schema['x-decimals'];
      if (Math.abs(v * f - Math.round(v * f)) > 1e-6) errs.push(`${where}: more than ${schema['x-decimals']} decimals`);
    }
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${where}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${where}: at most ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...validateSchema(schema.items, x, `${at}/${i}`)));
  }
  if (TYPES.object(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${where}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      const p = schema.properties?.[k];
      if (p) errs.push(...validateSchema(p, x, `${at}/${k}`));
      else if (schema.additionalProperties === false) errs.push(`${where}: unexpected ${k}`);
    }
  }
  return errs;
}

/** GSTIN: format and the mod-36 check character. */
export function gstinValid(g) {
  if (typeof g !== 'string' || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = cs.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return cs[(36 - (sum % 36)) % 36] === g[14];
}

/** Minor units (paise) → rupees with exactly 2 decimals. */
export const rupees = (minor) => Math.round(minor) / 100;

/** Canonical JSON: keys sorted at every level (the hash a filing is bound to). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return 'sha256:' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 'YYYY-MM' → { from, to, ret_period: 'MMYYYY' }. */
export function monthOf(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}`, ret_period: `${String(m).padStart(2, '0')}${y}` };
}

/** Which tax head an account's name declares, or null. */
export function headOf(name) {
  const n = String(name);
  if (/\bIGST\b|integrated/i.test(n)) return 'iamt';
  if (/\bCGST\b|central (gst|tax)/i.test(n)) return 'camt';
  if (/\b(SGST|UTGST)\b|state (gst|tax)|union territory/i.test(n)) return 'samt';
  if (/\bcess\b/i.test(n)) return 'csamt';
  return null;
}

/** Split one total by the configured supply assumption (A1). Exact in paise. */
export function splitByAssumption(total, assume) {
  if (assume === 'inter_state') return { iamt: total, camt: 0, samt: 0, csamt: 0 };
  const c = Math.ceil(total / 2);
  return { iamt: 0, camt: c, samt: total - c, csamt: 0 };
}

const zero4 = () => ({ iamt: 0, camt: 0, samt: 0, csamt: 0 });
const r4 = (h) => ({ iamt: rupees(h.iamt), camt: rupees(h.camt), samt: rupees(h.samt), csamt: rupees(h.csamt) });

/** The GSTR-3B document (GSTN RETSAVE `data`) from figures in minor units. */
export function buildReturn({ gstin, ret_period, taxable_minor, output, input }) {
  return {
    gstin,
    ret_period,
    sup_details: {
      osup_det: { txval: rupees(taxable_minor), ...r4(output) },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: 0 },
      isup_rev: { txval: 0, ...zero4() },
      osup_nongst: { txval: 0 },
    },
    sup_inter: { unreg_details: [], comp_details: [], uin_details: [] },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...zero4() },
        { ty: 'IMPS', ...zero4() },
        { ty: 'ISRC', ...zero4() },
        { ty: 'ISD', ...zero4() },
        { ty: 'OTH', ...r4(input) },
      ],
      itc_rev: [
        { ty: 'RUL', ...zero4() },
        { ty: 'OTH', ...zero4() },
      ],
      itc_net: r4(input),
      itc_inelg: [
        { ty: 'RUL', ...zero4() },
        { ty: 'OTH', ...zero4() },
      ],
    },
    inward_sup: { isup_details: [{ ty: 'GST', inter: 0, intra: 0 }, { ty: 'NONGST', inter: 0, intra: 0 }] },
    intr_ltfee: { intr_details: zero4() },
  };
}

/** Every numeric leaf of `approved` must be on the portal with the same value (the portal may add fields). */
export function sameFigures(approved, onPortal, at = '') {
  if (typeof approved === 'number') return typeof onPortal === 'number' && Math.round(onPortal * 100) === Math.round(approved * 100) ? null : `${at || '/'}: ${approved} vs ${JSON.stringify(onPortal)}`;
  if (Array.isArray(approved)) {
    if (!Array.isArray(onPortal)) return `${at}: missing`;
    for (const [i, x] of approved.entries()) {
      const m = x && typeof x === 'object' && 'ty' in x ? onPortal.find((y) => y?.ty === x.ty) : onPortal[i];
      const d = sameFigures(x, m, `${at}/${x?.ty ?? i}`);
      if (d) return d;
    }
    return null;
  }
  if (approved && typeof approved === 'object') {
    if (!onPortal || typeof onPortal !== 'object') return `${at}: missing`;
    for (const [k, v] of Object.entries(approved)) {
      const d = sameFigures(v, onPortal[k], `${at}/${k}`);
      if (d) return d;
    }
  }
  return null;
}

function refuse(msg) {
  const e = new Error(msg);
  e.definite = true;
  return e;
}

// ── figures from the books ────────────────────────────────────────────────

/** A host read; a refusal (switched off, not required, bad input) is definite: nothing was prepared. */
async function read(ctx, key, args) {
  try {
    return await ctx.reads[key](args);
  } catch (e) {
    throw refuse(`could not read ${key} from the books: ${e?.message ?? e}`);
  }
}

/**
 * Read the month from the ledger and decide the tax heads (A1–A5).
 * Returns the figures in minor units, the basis of each, and what was assumed.
 */
export async function figuresFromBooks(ctx, period, profile) {
  const { from, to } = monthOf(period);
  const vat = await read(ctx, VAT, { from, to, currency: 'INR' });
  const pnl = await read(ctx, PNL, { from, to, currency: 'INR' });
  const out = vat.output_tax_minor;
  const inp = vat.input_tax_minor;
  const taxable = pnl.totals.revenue_minor;
  if (out < 0 || inp < 0 || taxable < 0) {
    throw refuse(`the books show a negative figure for ${period} (output tax ${out}, input tax ${inp}, sales ${taxable} paise); a GST payment or reversal is probably posted to a tax account — correct the books before preparing`);
  }
  const accts = (await read(ctx, ACCTS, { as_of: to, include_inactive: true })).accounts.filter((a) => a.subtype === 'tax_output' || a.subtype === 'tax_input');
  const named = accts.filter((a) => headOf(a.name));
  const assumptions = [
    'A2: outward taxable value = revenue for the month; zero-rated, nil/exempt, non-GST and reverse-charge supplies reported as 0 (the books do not mark them)',
    'A3: all input tax reported as "all other ITC" (4A5); imports, ISD, reversals, ineligible ITC and the 3.2 place-of-supply table are empty',
    'A4: interest and late fee 0 (computed by the portal)',
  ];
  let output;
  let input;
  let split_basis;
  if (accts.length && named.length === accts.length) {
    output = zero4();
    input = zero4();
    for (const a of accts) {
      const l = await read(ctx, ACCT_LEDGER, { account_code: a.code, from, to });
      const moved = (l.closing_minor ?? 0) - (l.opening_minor ?? 0);
      (a.subtype === 'tax_output' ? output : input)[headOf(a.name)] += moved;
    }
    const so = output.iamt + output.camt + output.samt + output.csamt;
    const si = input.iamt + input.camt + input.samt + input.csamt;
    if (so !== out || si !== inp) throw refuse(`the tax accounts by head (output ${so}, input ${si}) do not add up to the VAT/GST summary (output ${out}, input ${inp}) for ${period}; nothing was prepared`);
    split_basis = `by head from the ledger's tax accounts: ${accts.map((a) => `${a.code} ${a.name}`).join('; ')}`;
  } else if (named.length) {
    throw refuse(`only some tax accounts name their head (${named.map((a) => a.name).join(', ')}); name every tax account IGST/CGST/SGST/cess, or none, so the split is not guessed`);
  } else {
    const assume = profile?.assume_supply;
    if (assume !== 'intra_state' && assume !== 'inter_state') {
      throw refuse(`the books cannot tell intra-state from inter-state supplies (tax accounts ${accts.map((a) => a.name).join(', ') || 'none'} do not name IGST/CGST/SGST), and the GST portal door has no assume_supply set; an admin sets it (intra_state or inter_state), or the chart gets one tax account per head. Nothing was prepared`);
    }
    output = splitByAssumption(out, assume);
    input = splitByAssumption(inp, assume);
    split_basis = `ASSUMED ${assume}: the books keep one output and one input tax account, so ${assume === 'intra_state' ? 'each total is split CGST = SGST (odd paisa to CGST)' : 'each total is reported as IGST'} (A1, configured on the GST portal door)`;
  }
  assumptions.unshift(`A1: ${split_basis}`);
  return {
    taxable_minor: taxable,
    output_tax_minor: out,
    input_tax_minor: inp,
    output,
    input,
    split_basis,
    assumptions,
    sources: { vat_summary: vat.sources, pnl: pnl.sources, tax_accounts: accts.map((a) => a.code) },
  };
}

function view(r) {
  return {
    id: r.id,
    period: r.period,
    ret_period: r.ret_period ?? null,
    gstin: r.gstin ?? null,
    status: r.status,
    output_tax_minor: Number(r.output_tax_minor),
    input_tax_minor: Number(r.input_tax_minor),
    net_payable_minor: Number(r.net_payable_minor),
    credit_carried_minor: Number(r.credit_carried_minor),
    split_basis: r.split_basis ?? null,
    payload_sha256: r.payload_sha256 ?? null,
    gsp_ref: r.gsp_ref ?? null,
    gsp_status: r.gsp_status ?? null,
    ack_ref: r.ack_ref ?? null,
  };
}

const newest = (rows) => [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;

async function latest(ctx, period, statuses) {
  const rows = [];
  for (const s of statuses) rows.push(...(await ctx.tables.select(T, { period, status: s })));
  return newest(rows);
}

async function profileOf(ctx) {
  const p = await ctx.doors.gst_portal.lookup({ action: 'profile' });
  if (!p || !gstinValid(p.gstin)) throw refuse('the GST portal door is not configured with a GSP credential and a valid GSTIN (provider gsp); an admin connects it under Doors');
  return p;
}

// ── abilities ─────────────────────────────────────────────────────────────

export const abilities = {
  'gst.returns.list': {
    async run(args, ctx) {
      const rows = (await ctx.tables.select(T, args.period ? { period: args.period } : {})).filter((r) => r.status !== 'superseded');
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return {
        generatedAt: new Date().toISOString(),
        empty: rows.length === 0,
        sources: { entries: rows.length, entry_ids: rows.map((r) => r.id), basis: 'GSTR-3B returns prepared by nep-gst from the ledger' },
        returns: rows.map(view),
      };
    },
  },

  'gst.gstr3b.prepare': {
    async execute(args, ctx) {
      const again = await ctx.tables.select(T, { reference: ctx.idempotency_key });
      if (again.length) return { external_ref: again[0].id };
      const filed = await ctx.tables.select(T, { period: args.period, status: 'filed' });
      if (filed.length) throw refuse(`the GSTR-3B for ${args.period} is already filed (ARN ${filed[0].ack_ref}); a filed return is not prepared again`);
      const profile = await profileOf(ctx);
      const { ret_period } = monthOf(args.period);
      const f = await figuresFromBooks(ctx, args.period, profile);
      const data = buildReturn({ gstin: profile.gstin, ret_period, taxable_minor: f.taxable_minor, output: f.output, input: f.input });
      const problems = validateSchema(GSTR3B_SCHEMA, data);
      if (problems.length) throw refuse(`the GSTR-3B built from the books does not validate: ${problems.slice(0, 5).join('; ')}`);
      const hash = await sha256(canonical(data));
      for (const old of [...(await ctx.tables.select(T, { period: args.period, status: 'draft' })), ...(await ctx.tables.select(T, { period: args.period, status: 'saved' }))]) {
        await ctx.tables.update(T, { id: old.id }, { status: 'superseded' });
      }
      const net = f.output_tax_minor - f.input_tax_minor;
      const row = await ctx.tables.insert(T, {
        period: args.period,
        currency: 'INR',
        gstin: profile.gstin,
        ret_period,
        output_tax_minor: f.output_tax_minor,
        input_tax_minor: f.input_tax_minor,
        taxable_minor: f.taxable_minor,
        net_payable_minor: Math.max(net, 0),
        credit_carried_minor: Math.max(-net, 0),
        payload: JSON.stringify(data),
        payload_sha256: hash,
        split_basis: f.split_basis,
        sources: JSON.stringify({ ...f.sources, assumptions: f.assumptions }),
        status: 'draft',
        reference: ctx.idempotency_key,
      });
      const src = `ledger.report.vat_summary: ${f.sources.vat_summary.basis} (${f.sources.vat_summary.entries} entries)`;
      await ctx.book.fact(`GSTR-3B ${ret_period} output tax (paise)`, f.output_tax_minor, src);
      await ctx.book.fact(`GSTR-3B ${ret_period} input tax credit (paise)`, f.input_tax_minor, src);
      await ctx.book.fact(`GSTR-3B ${ret_period} taxable outward supplies (paise)`, f.taxable_minor, `ledger.report.pnl: ${f.sources.pnl.basis}`);
      await ctx.book.fact(`GSTR-3B ${ret_period} tax split`, f.split_basis, 'nep-gst A1');
      await ctx.book.step(
        `GSTR-3B draft ${ret_period} for ${profile.gstin} from the books: taxable ${f.taxable_minor}, output ${f.output_tax_minor} (IGST ${f.output.iamt} CGST ${f.output.camt} SGST ${f.output.samt}), ITC ${f.input_tax_minor}, net payable ${Math.max(net, 0)}, credit carried ${Math.max(-net, 0)} paise. Split: ${f.split_basis}`,
      );
      return { external_ref: row.id };
    },
    async readBack(_x, ctx) {
      const rows = await ctx.tables.select(T, { reference: ctx.idempotency_key });
      if (rows.length !== 1) return { found: false, data: null };
      const r = rows[0];
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return { found: true, data: { ...view(r), gstr3b: payload, assumptions: (typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources)?.assumptions ?? [] } };
    },
  },

  'gst.gstr3b.save': {
    async execute(args, ctx) {
      const d = await latest(ctx, args.period, ['draft', 'saved']);
      if (!d) throw refuse(`no GSTR-3B draft for ${args.period}; prepare it from the books first`);
      const data = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
      const problems = validateSchema(GSTR3B_SCHEMA, data);
      if (problems.length) throw refuse(`the draft does not validate: ${problems.slice(0, 5).join('; ')}`);
      if ((await sha256(canonical(data))) !== d.payload_sha256) throw refuse('the draft changed after it was prepared; prepare it again');
      const sent = await ctx.doors.gst_portal.send({ action: 'gstr3b.save', ret_period: d.ret_period, data });
      const st = await ctx.doors.gst_portal.lookup({ action: 'gstr3b.status', ret_period: d.ret_period, reference_id: sent.id });
      if (st?.status_cd === 'ER') {
        await ctx.tables.update(T, { id: d.id }, { gsp_ref: sent.id, gsp_status: 'ER' });
        throw refuse(`the GST portal rejected the saved GSTR-3B (reference ${sent.id}): ${JSON.stringify(st.error_report ?? {}).slice(0, 300)}`);
      }
      await ctx.tables.update(T, { id: d.id }, { status: 'saved', gsp_ref: sent.id, gsp_status: st?.status_cd ?? null });
      await ctx.book.step(`GSTR-3B ${d.ret_period} saved on the GST portal through the GSP: reference ${sent.id}, status ${st?.status_cd ?? 'unknown'} (P processed, PE processed with errors, IP in progress). Saving is not filing.`);
      return { external_ref: sent.id };
    },
    async readBack({ args }, ctx) {
      const d = await latest(ctx, args.period, ['saved', 'draft']);
      if (!d) return { found: false, data: null };
      const s = await ctx.doors.gst_portal.lookup({ action: 'gstr3b.summary', ret_period: d.ret_period });
      const data = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
      const diff = s?.return ? sameFigures(data, s.return) : 'nothing saved';
      if (diff) return { found: false, data: { ret_period: d.ret_period, differs: diff } };
      if (d.status === 'draft') await ctx.tables.update(T, { id: d.id }, { status: 'saved' });
      return { found: true, data: { ret_period: d.ret_period, gstin: d.gstin, reference_id: d.gsp_ref ?? null, status_cd: d.gsp_status ?? null, portal_matches_books: true } };
    },
  },

  'gst.otp.request': {
    async execute(args, ctx) {
      const sent = await ctx.doors.gst_portal.send({ action: 'otp.request', purpose: args.purpose });
      await ctx.book.step(
        args.purpose === 'evc'
          ? 'Asked the GST portal to send the EVC OTP to the authorised signatory. A person enters it on the GST portal OTP door; the assistant never sees it.'
          : 'Asked the GST portal to send a login OTP to the registered mobile. A person enters it on the GST portal OTP door; the assistant never sees it.',
      );
      return { external_ref: sent.id };
    },
    async readBack({ external_ref }) {
      return { found: !!external_ref, data: external_ref ? { requested: true } : null };
    },
  },

  'gst.gstr3b.file': {
    // Bind the proposal to the exact saved document: the card and the fingerprint
    // carry its figures and hash, whatever the assistant passed.
    async normalize(args, ctx) {
      const d = await latest(ctx, args.period, ['saved']);
      if (!d) return { period: args.period };
      return {
        period: args.period,
        gstin: d.gstin,
        ret_period: d.ret_period,
        return_id: d.id,
        payload_sha256: d.payload_sha256,
        output_tax_minor: Number(d.output_tax_minor),
        input_tax_minor: Number(d.input_tax_minor),
        net_payable_minor: Number(d.net_payable_minor),
        credit_carried_minor: Number(d.credit_carried_minor),
        split_basis: d.split_basis,
      };
    },
    async validate(args, ctx) {
      const filed = await ctx.tables.select(T, { period: args.period, status: 'filed' });
      if (filed.length) return `the GSTR-3B for ${args.period} is already filed (ARN ${filed[0].ack_ref})`;
      if (!args.return_id) return `no GSTR-3B for ${args.period} has been saved on the GST portal; prepare it from the books and save it first`;
      return null;
    },
    async execute(args, ctx) {
      const [d] = await ctx.tables.select(T, { id: args.return_id });
      if (!d || d.period !== args.period) throw refuse('the approved return no longer exists');
      if (d.status === 'filed') return { external_ref: d.ack_ref };
      if (d.status !== 'saved') throw refuse(`the approved return is ${d.status}, not saved; nothing was filed`);
      const data = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
      const hash = await sha256(canonical(data));
      if (hash !== args.payload_sha256 || hash !== d.payload_sha256) throw refuse('the return changed after it was approved; nothing was filed');
      const sent = await ctx.doors.gst_portal.send({ action: 'gstr3b.file', ret_period: d.ret_period, data, payload_sha256: hash });
      await ctx.tables.update(T, { id: d.id }, { status: 'filed', ack_ref: sent.id });
      await ctx.book.fact(`GSTR-3B ${d.ret_period} ARN`, sent.id, 'GST portal acknowledgement via the GSP');
      return { external_ref: sent.id };
    },
    async readBack({ args }, ctx) {
      const t = await ctx.doors.gst_portal.lookup({ action: 'gstr3b.track', ret_period: args.ret_period ?? monthOf(args.period).ret_period });
      if (!t) return { found: false, data: null };
      if (args.return_id) {
        const [d] = await ctx.tables.select(T, { id: args.return_id });
        if (d && d.status !== 'filed') await ctx.tables.update(T, { id: d.id }, { status: 'filed', ack_ref: t.arn });
      }
      return { found: true, data: { ret_period: t.ret_period, arn: t.arn, filed_on: t.dof, status: t.status } };
    },
  },
};

// ── selftest (run by the host at install; offline, no ctx needed) ──────────

export async function selftest() {
  const checks = [];
  const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail });
  const G = '27AAPFU0939F1ZV';
  check('gstin checksum accepts a valid GSTIN', gstinValid(G));
  check('gstin checksum rejects a wrong check character', !gstinValid('27AAPFU0939F1ZA'));
  check('month → ret_period', monthOf('2026-09').ret_period === '092026' && monthOf('2024-02').to === '2024-02-29');
  check('paise → rupees keeps 2 decimals', rupees(1234567) === 12345.67 && rupees(5) === 0.05);
  const intra = splitByAssumption(1001, 'intra_state');
  check('intra-state split is exact in paise', intra.camt === 501 && intra.samt === 500 && intra.iamt === 0);
  check('inter-state split is all IGST', splitByAssumption(1001, 'inter_state').iamt === 1001);
  check('tax heads are read from account names', headOf('Output IGST') === 'iamt' && headOf('CGST input credit') === 'camt' && headOf('UTGST payable') === 'samt' && headOf('GST output payable') === null);
  const good = buildReturn({ gstin: G, ret_period: '092026', taxable_minor: 123456789, output: splitByAssumption(22222222, 'intra_state'), input: splitByAssumption(7777777, 'intra_state') });
  const probs = validateSchema(GSTR3B_SCHEMA, good);
  check('a return built from figures validates against the GSTR-3B schema', probs.length === 0, probs.slice(0, 3));
  check('figures survive the build', good.sup_details.osup_det.txval === 1234567.89 && good.sup_details.osup_det.camt === 111111.11 && good.itc_elg.itc_net.samt === 38888.88);
  const bad3 = JSON.parse(JSON.stringify(good));
  bad3.sup_details.osup_det.txval = 1.005;
  check('the schema refuses 3 decimals', validateSchema(GSTR3B_SCHEMA, bad3).length > 0);
  const badExtra = { ...good, net_payable: 1 };
  check('the schema refuses unknown fields', validateSchema(GSTR3B_SCHEMA, badExtra).length > 0);
  const badPeriod = { ...good, ret_period: '2026-09' };
  check('the schema refuses a non-MMYYYY period', validateSchema(GSTR3B_SCHEMA, badPeriod).length > 0);
  check('portal comparison sees a changed figure', sameFigures(good, bad3) !== null && sameFigures(good, JSON.parse(JSON.stringify(good))) === null);
  const h1 = await sha256(canonical(good));
  const h2 = await sha256(canonical(JSON.parse(JSON.stringify(good))));
  check('the filing hash is stable', h1 === h2 && /^sha256:[0-9a-f]{64}$/.test(h1));
  return { ok: checks.every((c) => c.ok), checks };
}
