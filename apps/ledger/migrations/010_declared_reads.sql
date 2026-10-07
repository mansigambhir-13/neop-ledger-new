-- 010_declared_reads.sql · app-team-owned. Expand-only. WP v3 §11 "heavy reads are declared views in the migration
-- file — real SQL, reviewed once, not improvised at runtime"; V3-MIGRATION-PLAN S9 (the desk on the database, no gateway).
-- Every Ledger read that a NEOS screen (blocks/*.json) uses as a source is ONE SQL function here, `ledger.read_<x>(args)`,
-- registered in {{schema}}.declared_reads (template t018). The desk reaches it only through {{schema}}.block_read()
-- (SECURITY DEFINER, as the migrator, under the person's company: row-level security is forced on every table), and
-- Ledger's own read handler (src/abilities/*.ts) calls the same function — the screen and the assistant see one answer.
-- The functions are SECURITY INVOKER: called by the app role they read what the app role may read, for its company.
-- They reproduce what the TypeScript handlers answered before, key for key: minor units as JSON numbers, dates as
-- 'YYYY-MM-DD', timestamps as ISO-8601 UTC with milliseconds (JavaScript's toISOString), generatedAt from the
-- database clock, and every sources block (entries, the first 50 ids, the basis in words).

-- ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
create function {{schema}}.iso_ts(t timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create function {{schema}}.iso_date(d date) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$ select to_char(d, 'YYYY-MM-DD') $$;

-- An argument that must be a date ('YYYY-MM-DD'), or null when absent. Anything else is the caller's mistake (22023,
-- 'bad_request: …'), never a crash: the manifest's input schema says the same.
create function {{schema}}.arg_date(p jsonb, k text) returns date
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v text := p->>k;
begin
  if v is null then return null; end if;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'bad_request: % must be a date (YYYY-MM-DD)', k using errcode = '22023'; end if;
  begin
    return v::date;
  exception when others then
    raise exception 'bad_request: % must be a date (YYYY-MM-DD)', k using errcode = '22023';
  end;
end $$;

-- A read switched off at the company (its own switch, or the app's floor) answers nobody — not the assistant (the
-- gate refuses it first), not a screen: 42501 'switched_off: …' (the desk shows 403). A line with no row is at its
-- floor, which for every Ledger read is on.
create function {{schema}}.require_line_on(p_line text) returns void
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  if exists (select 1 from {{schema}}.switchboard s
              where s.company_id = nullif(current_setting('neos.company_id', true), '')::uuid and s.line = p_line
                and (s.setting = 'off' or s.floor = 'off')) then
    raise exception 'switched_off: % is switched off at this company', p_line using errcode = '42501';
  end if;
end $$;

-- The company's today, in its time zone (the install row's; UTC when none is on record).
create function {{schema}}.company_today() returns date
language sql stable set search_path = pg_catalog, pg_temp as $$
  select (now() at time zone coalesce(
    (select i.time_zone from {{schema}}.installs i where i.company_id = nullif(current_setting('neos.company_id', true), '')::uuid),
    'UTC'))::date
$$;

-- An amount in minor units as rupees with Indian digit grouping and two decimals ('en-IN': 1,23,456.78; -0.50).
create function {{schema}}.fmt_inr(m bigint) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  a bigint := abs(m);
  i text := (a / 100)::text;
  f text := lpad((a % 100)::text, 2, '0');
  head text;
  out text;
begin
  if length(i) > 3 then
    head := left(i, length(i) - 3);
    out := right(i, 3);
    while length(head) > 2 loop
      out := right(head, 2) || ',' || out;
      head := left(head, length(head) - 2);
    end loop;
    out := head || ',' || out;
  else
    out := i;
  end if;
  return case when m < 0 then '-' else '' end || out || '.' || f;
end $$;

-- The head every read carries: when, currency, whether empty, and where it came from (at most 50 ids).
create function {{schema}}.read_head(p_entries integer, p_ids text[], p_basis text, p_currency text) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'generatedAt', {{schema}}.iso_ts(now()),
    'currency', p_currency,
    'empty', p_entries = 0,
    'sources', jsonb_build_object('entries', p_entries, 'entry_ids', to_jsonb(coalesce(p_ids[1:50], '{}'::text[])), 'basis', p_basis))
$$;

-- Posted debits and credits per account (every account, zero when untouched), in the period and currency, by code.
create function {{schema}}.account_totals(p_from date, p_to date, p_currency text)
returns table (code text, name text, type text, subtype text, debit_minor bigint, credit_minor bigint)
language sql stable set search_path = pg_catalog, pg_temp as $$
  select a.code, a.name, a.type, a.subtype, coalesce(s.debit, 0)::bigint, coalesce(s.credit, 0)::bigint
    from {{schema}}.accounts a
    left join (
      select l.account_id, sum(l.debit_minor) as debit, sum(l.credit_minor) as credit
        from {{schema}}.journal_lines l join {{schema}}.journal_entries e on e.id = l.entry_id
       where e.entry_date <= p_to and (p_from is null or e.entry_date >= p_from) and e.currency = p_currency
       group by l.account_id) s on s.account_id = a.id
   order by a.code
$$;

-- Natural-side balance: debit-normal for assets and expenses, credit-normal otherwise.
create function {{schema}}.natural_balance(p_type text, p_debit bigint, p_credit bigint) returns bigint
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_type in ('asset', 'expense') then p_debit - p_credit else p_credit - p_debit end
$$;

-- How many journal entries a report stands on, and the first 50 of them (by date, then creation).
create function {{schema}}.entry_sources(p_from date, p_to date, p_currency text) returns table (n integer, ids text[])
language sql stable set search_path = pg_catalog, pg_temp as $$
  select count(*)::int, coalesce((array_agg(id::text order by entry_date, created_at))[1:50], '{}'::text[])
    from {{schema}}.journal_entries where entry_date <= p_to and (p_from is null or entry_date >= p_from) and currency = p_currency
$$;

-- Open invoices or bills issued by a date, with what is still owed, by due date.
create function {{schema}}.open_documents(p_kind text, p_as_of date, p_currency text)
returns table (id text, number text, party text, due_date text, outstanding_minor bigint)
language sql stable set search_path = pg_catalog, pg_temp as $$
  select d.id::text, d.number, p.name, {{schema}}.iso_date(d.due_date), (d.total_minor - d.paid_minor)::bigint
    from {{schema}}.documents d join {{schema}}.parties p on p.id = d.party_id
   where d.kind = p_kind and d.status = 'open' and d.issue_date <= p_as_of and d.currency = p_currency and d.total_minor > d.paid_minor
   order by d.due_date, d.number
$$;

-- The company's bookkeeping settings (the defaults when none are stored). plpgsql: resolved when called, not when made.
create function {{schema}}.settings_now() returns table (tax_regime text, return_frequency text, forecast_weeks integer, min_cash_buffer_minor bigint)
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.tax_regime, s.return_frequency, s.forecast_weeks, s.min_cash_buffer_minor from {{schema}}.settings s
    union all
    select 'IN_GST'::text, 'monthly'::text, 13, 0::bigint where not exists (select 1 from {{schema}}.settings)
    limit 1;
end $$;

-- ── the reports ────────────────────────────────────────────────────────────────────────────────────────────────────
-- A report line: code, name, subtype and the natural-side amount, for accounts with any movement.
create function {{schema}}.report_lines(p_from date, p_to date, p_currency text, p_type text) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'subtype', t.subtype,
                                               'amount_minor', {{schema}}.natural_balance(t.type, t.debit_minor, t.credit_minor)) order by t.code), '[]'::jsonb)
    from {{schema}}.account_totals(p_from, p_to, p_currency) t
   where t.type = p_type and (t.debit_minor <> 0 or t.credit_minor <> 0)
$$;

create function {{schema}}.read_pnl(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  f date := {{schema}}.arg_date(p, 'from');
  t date := {{schema}}.arg_date(p, 'to');
  src record;
  x record;
begin
  perform {{schema}}.require_line_on('ledger.report.pnl');
  select * into src from {{schema}}.entry_sources(f, t, cur);
  select coalesce(sum(n) filter (where type = 'income' and subtype = 'revenue'), 0)::bigint as revenue,
         coalesce(sum(n) filter (where type = 'expense' and subtype = 'cogs'), 0)::bigint as cogs,
         coalesce(sum(n) filter (where type = 'income'), 0)::bigint as inc,
         coalesce(sum(n) filter (where type = 'expense'), 0)::bigint as exp
    into x
    from (select a.type, a.subtype, {{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor) as n
            from {{schema}}.account_totals(f, t, cur) a where a.debit_minor <> 0 or a.credit_minor <> 0) z;
  return {{schema}}.read_head(src.n, src.ids, format('journal entries dated %s..%s', p->>'from', p->>'to'), cur)
    || jsonb_build_object(
      'period', jsonb_build_object('from', p->>'from', 'to', p->>'to'),
      'income', {{schema}}.report_lines(f, t, cur, 'income'),
      'expenses', {{schema}}.report_lines(f, t, cur, 'expense'),
      'totals', jsonb_build_object('revenue_minor', x.revenue, 'cogs_minor', x.cogs, 'gross_profit_minor', x.revenue - x.cogs,
                                   'income_minor', x.inc, 'expenses_minor', x.exp, 'net_profit_minor', x.inc - x.exp));
end $$;

create function {{schema}}.read_balance_sheet(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  t date := {{schema}}.arg_date(p, 'as_of');
  src record;
  x record;
begin
  perform {{schema}}.require_line_on('ledger.report.balance_sheet');
  select * into src from {{schema}}.entry_sources(null, t, cur);
  select coalesce(sum(n) filter (where type = 'asset'), 0)::bigint as a,
         coalesce(sum(n) filter (where type = 'liability'), 0)::bigint as l,
         coalesce(sum(n) filter (where type = 'equity'), 0)::bigint as e,
         (coalesce(sum(n) filter (where type = 'income'), 0) - coalesce(sum(n) filter (where type = 'expense'), 0))::bigint as earnings
    into x
    from (select a.type, {{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor) as n from {{schema}}.account_totals(null, t, cur) a) z;
  return {{schema}}.read_head(src.n, src.ids, format('all journal entries up to %s', p->>'as_of'), cur)
    || jsonb_build_object(
      'as_of', p->>'as_of',
      'assets', {{schema}}.report_lines(null, t, cur, 'asset'),
      'liabilities', {{schema}}.report_lines(null, t, cur, 'liability'),
      'equity', {{schema}}.report_lines(null, t, cur, 'equity'),
      'totals', jsonb_build_object('assets_minor', x.a, 'liabilities_minor', x.l, 'equity_minor', x.e, 'earnings_to_date_minor', x.earnings),
      'balanced', x.a = x.l + x.e + x.earnings);
end $$;

create function {{schema}}.read_trial_balance(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  t date := {{schema}}.arg_date(p, 'as_of');
  src record;
  rows_ jsonb;
  d bigint;
  c bigint;
begin
  perform {{schema}}.require_line_on('ledger.report.trial_balance');
  select * into src from {{schema}}.entry_sources(null, t, cur);
  select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'type', a.type, 'debit_minor', a.debit_minor,
                                               'credit_minor', a.credit_minor, 'balance_minor', a.debit_minor - a.credit_minor) order by a.code), '[]'::jsonb),
         coalesce(sum(a.debit_minor), 0)::bigint, coalesce(sum(a.credit_minor), 0)::bigint
    into rows_, d, c
    from {{schema}}.account_totals(null, t, cur) a where a.debit_minor <> 0 or a.credit_minor <> 0;
  return {{schema}}.read_head(src.n, src.ids, format('all journal entries up to %s', p->>'as_of'), cur)
    || jsonb_build_object('as_of', p->>'as_of', 'rows', rows_, 'total_debit_minor', d, 'total_credit_minor', c, 'balanced', d = c);
end $$;

create function {{schema}}.read_vat_summary(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  f date := {{schema}}.arg_date(p, 'from');
  t date := {{schema}}.arg_date(p, 'to');
  src record;
  o bigint;
  i bigint;
begin
  perform {{schema}}.require_line_on('ledger.report.vat_summary');
  select * into src from {{schema}}.entry_sources(f, t, cur);
  select coalesce(sum(a.credit_minor - a.debit_minor) filter (where a.subtype = 'tax_output'), 0)::bigint,
         coalesce(sum(a.debit_minor - a.credit_minor) filter (where a.subtype = 'tax_input'), 0)::bigint
    into o, i from {{schema}}.account_totals(f, t, cur) a;
  return {{schema}}.read_head(src.n, src.ids, format('journal entries dated %s..%s', p->>'from', p->>'to'), cur)
    || jsonb_build_object('period', jsonb_build_object('from', p->>'from', 'to', p->>'to'),
                          'output_tax_minor', o, 'input_tax_minor', i, 'net_payable_minor', o - i);
end $$;

-- Direct method: each entry's net cash movement is classed by its largest non-cash counterpart.
create function {{schema}}.read_cash_flow(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  f date := {{schema}}.arg_date(p, 'from');
  t date := {{schema}}.arg_date(p, 'to');
  src record;
  opening bigint;
  x record;
begin
  perform {{schema}}.require_line_on('ledger.report.cash_flow');
  select * into src from {{schema}}.entry_sources(f, t, cur);
  select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint into opening
    from {{schema}}.journal_lines l join {{schema}}.journal_entries e on e.id = l.entry_id join {{schema}}.accounts a on a.id = l.account_id
   where a.subtype in ('cash', 'bank') and e.entry_date < f and e.currency = cur;
  with l as (
    select l.id, l.entry_id, a.subtype, l.debit_minor, l.credit_minor
      from {{schema}}.journal_lines l
      join {{schema}}.journal_entries e on e.id = l.entry_id
      join {{schema}}.accounts a on a.id = l.account_id
     where e.entry_date between f and t and e.currency = cur
       and exists (select 1 from {{schema}}.journal_lines l2 join {{schema}}.accounts a2 on a2.id = l2.account_id
                    where l2.entry_id = l.entry_id and a2.subtype in ('cash', 'bank'))),
  cash as (select entry_id, sum(debit_minor - credit_minor) as net from l where subtype in ('cash', 'bank') group by entry_id),
  main as (select distinct on (entry_id) entry_id, subtype from l where subtype not in ('cash', 'bank')
            order by entry_id, debit_minor + credit_minor desc, id)
  select coalesce(sum(c.net) filter (where m.subtype = 'fixed_asset'), 0)::bigint as investing,
         coalesce(sum(c.net) filter (where m.subtype in ('loan', 'equity', 'retained_earnings')), 0)::bigint as financing,
         coalesce(sum(c.net) filter (where m.subtype not in ('fixed_asset', 'loan', 'equity', 'retained_earnings')), 0)::bigint as operating
    into x
    from cash c join main m on m.entry_id = c.entry_id;
  return {{schema}}.read_head(src.n, src.ids, format('journal entries touching cash or bank, %s..%s', p->>'from', p->>'to'), cur)
    || jsonb_build_object('period', jsonb_build_object('from', p->>'from', 'to', p->>'to'),
                          'opening_cash_minor', opening, 'operating_minor', x.operating, 'investing_minor', x.investing,
                          'financing_minor', x.financing, 'closing_cash_minor', opening + x.operating + x.investing + x.financing);
end $$;

create function {{schema}}.read_aging(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  p_kind text := p->>'kind';
  asked text := p->>'as_of';
  as_of date := least({{schema}}.arg_date(p, 'as_of'), {{schema}}.company_today());
  as_of_s text := {{schema}}.iso_date(least({{schema}}.arg_date(p, 'as_of'), {{schema}}.company_today()));
  n integer;
  ids text[];
  items jsonb;
  b_cur bigint;
  b_30 bigint;
  b_60 bigint;
  b_90 bigint;
  b_90p bigint;
  total bigint;
begin
  perform {{schema}}.require_line_on('ledger.report.aging');
  with docs as (
    select d.*, (as_of - d.due_date::date) as days, row_number() over (order by d.due_date, d.number) as o
      from {{schema}}.open_documents(case when p_kind = 'receivable' then 'invoice' else 'bill' end, as_of, cur) d),
  x as (select docs.*, case when days <= 0 then 'current' when days <= 30 then 'd1_30' when days <= 60 then 'd31_60' when days <= 90 then 'd61_90' else 'd90_plus' end as bucket from docs)
  select count(*)::int, coalesce(array_agg(id order by o), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('number', number, 'party', party, 'due_date', due_date, 'outstanding_minor', outstanding_minor,
                                               'days_past_due', greatest(days, 0), 'bucket', bucket) order by o), '[]'::jsonb),
         coalesce(sum(outstanding_minor) filter (where bucket = 'current'), 0)::bigint as current,
         coalesce(sum(outstanding_minor) filter (where bucket = 'd1_30'), 0)::bigint as d1_30,
         coalesce(sum(outstanding_minor) filter (where bucket = 'd31_60'), 0)::bigint as d31_60,
         coalesce(sum(outstanding_minor) filter (where bucket = 'd61_90'), 0)::bigint as d61_90,
         coalesce(sum(outstanding_minor) filter (where bucket = 'd90_plus'), 0)::bigint as d90_plus,
         coalesce(sum(outstanding_minor), 0)::bigint as total
    into n, ids, items, b_cur, b_30, b_60, b_90, b_90p, total
    from x;
  return {{schema}}.read_head(n, ids,
      format('open %s issued on or before %s%s', case when p_kind = 'receivable' then 'customer invoices' else 'supplier bills' end, as_of_s,
             case when as_of_s <> asked then format(' (aged to today, %s: %s has not come yet)', as_of_s, asked) else '' end), cur)
    || jsonb_build_object('kind', p_kind, 'as_of', as_of_s,
         'buckets', jsonb_build_object('current', b_cur, 'd1_30', b_30, 'd31_60', b_60, 'd61_90', b_90, 'd90_plus', b_90p),
         'items', items, 'total_outstanding_minor', total);
end $$;

-- ── the books ──────────────────────────────────────────────────────────────────────────────────────────────────────
create function {{schema}}.read_accounts_list(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  as_of text := coalesce(p->>'as_of', {{schema}}.iso_date({{schema}}.company_today()));
  incl boolean := coalesce((p->>'include_inactive')::boolean, false);
  accts jsonb;
  n integer;
begin
  perform {{schema}}.require_line_on('ledger.accounts.list');
  select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'type', t.type, 'subtype', t.subtype,
                                               'balance_minor', {{schema}}.natural_balance(t.type, t.debit_minor, t.credit_minor),
                                               'active', coalesce(a.is_active, true)) order by t.code), '[]'::jsonb),
         count(*)::int
    into accts, n
    from {{schema}}.account_totals(null, coalesce({{schema}}.arg_date(p, 'as_of'), {{schema}}.company_today()), 'INR') t
    left join {{schema}}.accounts a on a.code = t.code
   where (p->>'type' is null or t.type = p->>'type') and (incl or coalesce(a.is_active, true));
  return {{schema}}.read_head(n, '{}', format('chart of accounts with balances as of %s', as_of), 'INR')
    || jsonb_build_object('as_of', as_of, 'accounts', accts);
end $$;

create function {{schema}}.read_account_ledger(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  code_ text := p->>'account_code';
  f date := {{schema}}.arg_date(p, 'from');
  t date := {{schema}}.arg_date(p, 'to');
  acct record;
  sgn integer;
  open_ bigint;
  rows_ jsonb;
  ids text[];
  n integer;
  closing bigint;
begin
  perform {{schema}}.require_line_on('ledger.account.ledger');
  select a.id, a.code, a.name, a.type into acct from {{schema}}.accounts a where a.code = code_ limit 1;
  if not found then
    return {{schema}}.read_head(0, '{}', format('no account %s', code_), 'INR')
      || jsonb_build_object('account_code', code_, 'account_name', null, 'opening_minor', null, 'closing_minor', null, 'rows', '[]'::jsonb);
  end if;
  sgn := case when acct.type in ('asset', 'expense') then 1 else -1 end;
  select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint * sgn into open_
    from {{schema}}.journal_lines l join {{schema}}.journal_entries e on e.id = l.entry_id
   where l.account_id = acct.id and e.entry_date < f;
  with lines as (
    select e.id::text as entry_id, {{schema}}.iso_date(e.entry_date) as date, e.memo, e.reference, l.debit_minor, l.credit_minor,
           row_number() over (order by e.entry_date, e.created_at, l.id) as o
      from {{schema}}.journal_lines l join {{schema}}.journal_entries e on e.id = l.entry_id
     where l.account_id = acct.id and e.entry_date between f and t),
  run as (select lines.*, open_ + sum((debit_minor - credit_minor) * sgn) over (order by o) as bal from lines)
  select coalesce(jsonb_agg(jsonb_build_object('entry_id', entry_id, 'date', date, 'memo', memo, 'reference', reference,
                                               'debit_minor', debit_minor, 'credit_minor', credit_minor, 'balance_minor', bal::bigint) order by o), '[]'::jsonb),
         coalesce(array_agg(entry_id order by o), '{}'), count(*)::int, coalesce((array_agg(bal::bigint order by o desc))[1], open_)
    into rows_, ids, n, closing from run;
  return {{schema}}.read_head(n, ids, format('lines on %s %s..%s', code_, p->>'from', p->>'to'), 'INR')
    || jsonb_build_object('account_code', acct.code, 'account_name', acct.name, 'opening_minor', open_, 'closing_minor', closing, 'rows', rows_);
end $$;

create function {{schema}}.read_journal_list(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  search text := p->>'search';
  lim integer := least(coalesce((p->>'limit')::int, 100), 200);
  entries jsonb;
  ids text[];
  n integer;
begin
  perform {{schema}}.require_line_on('ledger.journal.list');
  with e as (
    select e.id, {{schema}}.iso_date(e.entry_date) as date, e.memo, e.reference, e.source, e.reverses, e.entry_date, e.created_at,
           coalesce(jsonb_agg(jsonb_build_object('account_code', a.code, 'account_name', a.name, 'debit_minor', l.debit_minor, 'credit_minor', l.credit_minor) order by l.id), '[]'::jsonb) as lines
      from {{schema}}.journal_entries e join {{schema}}.journal_lines l on l.entry_id = e.id join {{schema}}.accounts a on a.id = l.account_id
     where e.entry_date between {{schema}}.arg_date(p, 'from') and {{schema}}.arg_date(p, 'to')
       and (search is null or e.memo ilike '%' || search || '%' or e.reference ilike '%' || search || '%')
     group by e.id order by e.entry_date, e.created_at limit lim),
  o as (select e.*, row_number() over (order by entry_date, created_at) as k from e)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', date, 'memo', memo, 'reference', reference, 'source', source, 'reverses', reverses, 'lines', lines) order by k), '[]'::jsonb),
         coalesce(array_agg(id::text order by k), '{}'), count(*)::int
    into entries, ids, n from o;
  return {{schema}}.read_head(n, ids, format('journal entries %s..%s%s', p->>'from', p->>'to', case when coalesce(search, '') <> '' then format(' matching "%s"', search) else '' end), 'INR')
    || jsonb_build_object('entries', entries);
end $$;

create function {{schema}}.read_documents_list(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  p_kind text := p->>'kind';
  st text := coalesce(p->>'status', 'open');
  as_of date := least(coalesce({{schema}}.arg_date(p, 'as_of'), {{schema}}.company_today()), {{schema}}.company_today());
  docs jsonb;
  ids text[];
  n integer;
  tot record;
begin
  perform {{schema}}.require_line_on('ledger.documents.list');
  with d as (
    select d.id, d.number, pa.name as party, {{schema}}.iso_date(d.issue_date) as issue_date, {{schema}}.iso_date(d.due_date) as due_date,
           d.due_date as due, d.currency, d.total_minor, d.paid_minor, (d.total_minor - d.paid_minor)::bigint as outstanding_minor, d.status,
           case when d.sent_at is null then null else {{schema}}.iso_ts(d.sent_at) end as sent_at,
           case when d.reminded_at is null then null else {{schema}}.iso_ts(d.reminded_at) end as reminded_at,
           case when d.status = 'open' then greatest(0, as_of - d.due_date) else 0 end as overdue_days,
           row_number() over (order by d.due_date, d.number) as o
      from {{schema}}.documents d join {{schema}}.parties pa on pa.id = d.party_id
     where d.kind = p_kind and (p->>'party' is null or pa.name ilike '%' || (p->>'party') || '%')),
  f as (select * from d where st = 'all' or (st = 'overdue' and status = 'open' and overdue_days > 0) or (st not in ('all', 'overdue') and status = st))
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'party', party, 'issue_date', issue_date, 'due_date', due_date, 'currency', currency,
                                               'total_minor', total_minor, 'paid_minor', paid_minor, 'outstanding_minor', outstanding_minor, 'status', status,
                                               'sent_at', sent_at, 'reminded_at', reminded_at, 'overdue_days', overdue_days) order by o), '[]'::jsonb),
         coalesce(array_agg(id::text order by o), '{}'), count(*)::int
    into docs, ids, n from f;
  with d as (
    select (d.total_minor - d.paid_minor)::bigint as outstanding_minor, d.due_date, d.status,
           case when d.status = 'open' then greatest(0, as_of - d.due_date) else 0 end as overdue_days
      from {{schema}}.documents d join {{schema}}.parties pa on pa.id = d.party_id
     where d.kind = p_kind and (p->>'party' is null or pa.name ilike '%' || (p->>'party') || '%')),
  f as (select * from d where (st = 'all' or (st = 'overdue' and status = 'open' and overdue_days > 0) or (st not in ('all', 'overdue') and status = st)) and status = 'open')
  select coalesce(sum(outstanding_minor), 0)::bigint as outstanding,
         coalesce(sum(outstanding_minor) filter (where overdue_days > 0), 0)::bigint as overdue,
         coalesce(sum(outstanding_minor) filter (where overdue_days = 0 and due_date - as_of <= 7), 0)::bigint as due7
    into tot from f;
  return {{schema}}.read_head(n, ids, format('%ss (%s) as of %s', p_kind, coalesce(p->>'status', 'open'), {{schema}}.iso_date(as_of)), 'INR')
    || jsonb_build_object('kind', p_kind, 'as_of', {{schema}}.iso_date(as_of),
         'totals', jsonb_build_object('count', n, 'outstanding_minor', tot.outstanding, 'overdue_minor', tot.overdue, 'due_in_7_minor', tot.due7),
         'documents', docs);
end $$;

create function {{schema}}.read_parties_list(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  rows_ jsonb;
  ids text[];
  n integer;
begin
  perform {{schema}}.require_line_on('ledger.parties.list');
  with x as (
    select pa.id, pa.kind, pa.name, pa.email, pa.gstin,
           coalesce(sum(d.total_minor - d.paid_minor) filter (where d.status = 'open'), 0)::bigint as outstanding_minor,
           count(d.id) filter (where d.status = 'open')::int as open_documents
      from {{schema}}.parties pa left join {{schema}}.documents d on d.party_id = pa.id
     where (p->>'kind' is null or pa.kind = p->>'kind') group by pa.id),
  o as (select x.*, row_number() over (order by name, id) as k from x)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'email', email, 'gstin', gstin,
                                               'outstanding_minor', outstanding_minor, 'open_documents', open_documents) order by k), '[]'::jsonb),
         coalesce(array_agg(id::text order by k), '{}'), count(*)::int
    into rows_, ids, n from o;
  return {{schema}}.read_head(n, ids, format('%s parties with open balances', coalesce(p->>'kind', 'all')), 'INR') || jsonb_build_object('parties', rows_);
end $$;

-- What a bank line probably is: a coding rule's account, and open documents it could settle (domain suggest()).
create function {{schema}}.read_bank_unreconciled(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  txns jsonb;
  ids text[];
  n integer;
begin
  perform {{schema}}.require_line_on('ledger.bank.unreconciled');
  with t as (
    select t.id, {{schema}}.iso_date(t.txn_date) as date, t.description, t.amount_minor, t.currency, a.code as bank_account_code,
           lower(t.description) as txt, case when t.amount_minor > 0 then 'in' else 'out' end as dir,
           row_number() over (order by t.txn_date, t.imported_at, t.id) as k
      from {{schema}}.bank_transactions t join {{schema}}.accounts a on a.id = t.bank_account_id
     where t.status = 'unmatched' and (p->>'bank_account_code' is null or a.code = p->>'bank_account_code')),
  s as (
    select t.*,
           (select jsonb_build_object('pattern', r.pattern, 'account_code', ra.code)
              from {{schema}}.coding_rules r join {{schema}}.accounts ra on ra.id = r.account_id
             where (r.direction = 'any' or r.direction = t.dir) and strpos(t.txt, lower(r.pattern)) > 0
             order by r.priority, r.ctid limit 1) as rule,
           (select coalesce(jsonb_agg(jsonb_build_object('number', m.number, 'kind', m.kind, 'party', m.party, 'outstanding_minor', m.outstanding_minor, 'score', m.score)
                                     order by m.score desc, m.o), '[]'::jsonb)
              from (select m.*, row_number() over (order by m.score desc, m.o) as rk from (
                      select d.number, d.kind, pa.name as party, (d.total_minor - d.paid_minor)::bigint as outstanding_minor,
                             row_number() over (order by d.ctid) as o,
                             (case when strpos(t.txt, lower(d.number)) > 0 then 2 else 0 end)
                             + (case when (d.total_minor - d.paid_minor) = abs(t.amount_minor) then 2 else 0 end)
                             + (case when exists (select 1 from regexp_split_to_table(pa.name, '\s+') w where length(w) > 3 and strpos(t.txt, lower(w)) > 0) then 1 else 0 end) as score
                        from {{schema}}.documents d join {{schema}}.parties pa on pa.id = d.party_id
                       where d.status = 'open' and d.kind = case when t.dir = 'in' then 'invoice' else 'bill' end) m
                     where m.score >= 2) m where m.rk <= 3) as docs
      from t)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', date, 'description', description, 'amount_minor', amount_minor, 'currency', currency,
                                               'bank_account_code', bank_account_code, 'suggestions', jsonb_build_object('rule', rule, 'documents', docs)) order by k), '[]'::jsonb),
         coalesce(array_agg(id::text order by k), '{}'), count(*)::int
    into txns, ids, n from s;
  return {{schema}}.read_head(n, ids, 'imported bank lines not yet matched to the books', 'INR') || jsonb_build_object('transactions', txns);
end $$;

create function {{schema}}.read_coding_rules_list(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  rows_ jsonb;
  ids text[];
  n integer;
begin
  perform {{schema}}.require_line_on('ledger.coding_rules.list');
  with x as (
    select r.id, r.reference, r.pattern, a.code as account_code, a.name as account_name, r.direction, r.priority, r.created_at,
           (select count(*)::int from {{schema}}.bank_transactions t where t.status <> 'unmatched' and t.description ilike '%' || r.pattern || '%') as matched,
           row_number() over (order by r.priority, r.created_at, r.ctid) as k
      from {{schema}}.coding_rules r join {{schema}}.accounts a on a.id = r.account_id)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'pattern', pattern, 'account_code', account_code, 'account_name', account_name,
                                               'direction', direction, 'priority', priority, 'created_at', {{schema}}.iso_ts(created_at), 'matched', matched) order by k), '[]'::jsonb),
         coalesce(array_agg(id::text order by k), '{}'), count(*)::int
    into rows_, ids, n from x;
  return {{schema}}.read_head(n, ids, 'coding rules, in the order they are tried', 'INR') || jsonb_build_object('rules', rows_);
end $$;

-- Home: the four figures a bookkeeper looks at first.
create function {{schema}}.read_home_summary(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  as_of text := coalesce(p->>'as_of', {{schema}}.iso_date({{schema}}.company_today()));
  d date := coalesce({{schema}}.arg_date(p, 'as_of'), {{schema}}.company_today());
  n integer;
  cash bigint;
  banks integer;
  unmatched integer;
  ar record;
  ap record;
begin
  perform {{schema}}.require_line_on('ledger.home.summary');
  select count(*)::int, coalesce(sum({{schema}}.natural_balance(t.type, t.debit_minor, t.credit_minor)) filter (where t.subtype in ('bank', 'cash')), 0)::bigint,
         (count(*) filter (where t.subtype = 'bank'))::int
    into n, cash, banks from {{schema}}.account_totals(null, d, 'INR') t;
  select count(*)::int into unmatched from {{schema}}.bank_transactions where status = 'unmatched';
  select coalesce(sum(o.outstanding_minor), 0)::bigint as amount, count(*)::int as cnt into ar
    from {{schema}}.open_documents('invoice', d, 'INR') o where o.due_date < as_of and o.outstanding_minor > 0;
  select coalesce(sum(o.outstanding_minor), 0)::bigint as amount, count(*)::int as cnt into ap
    from {{schema}}.open_documents('bill', d, 'INR') o where o.due_date <= {{schema}}.iso_date(d + 7) and o.outstanding_minor > 0;
  return {{schema}}.read_head(n, '{}', format('balances as of %s; open invoices and bills; unmatched bank lines', as_of), 'INR')
    || jsonb_build_object('as_of', as_of, 'cash_minor', cash, 'bank_accounts', banks, 'unmatched_lines', unmatched,
                          'overdue_ar_minor', ar.amount, 'overdue_ar_count', ar.cnt, 'ap_due_7d_minor', ap.amount, 'ap_due_7d_count', ap.cnt);
end $$;

-- The month-end close checklist: what blocks closing a month, worked out from the books.
create function {{schema}}.read_close_checklist(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  m text := p->>'month';
  f date := {{schema}}.arg_date(jsonb_build_object('month', coalesce(p->>'month', 'x') || '-01'), 'month');
  t date := ({{schema}}.arg_date(jsonb_build_object('month', coalesce(p->>'month', 'x') || '-01'), 'month') + interval '1 month' - interval '1 day')::date;
  here integer;
  earlier text;
  unsent text;
  n integer;
  dr bigint;
  cr bigint;
  a_asset bigint;
  a_liab bigint;
  a_eq bigint;
  a_inc bigint;
  a_exp bigint;
  bs boolean;
  lk record;
  items jsonb;
begin
  perform {{schema}}.require_line_on('ledger.close.checklist');
  select coalesce(sum(c.n) filter (where c.month = m), 0)::int,
         string_agg(format('%s: %s', c.month, c.n), ', ' order by c.month) filter (where c.month < m)
    into here, earlier
    from (select to_char(date_trunc('month', txn_date), 'YYYY-MM') as month, count(*)::int as n from {{schema}}.bank_transactions
           where status = 'unmatched' and txn_date <= t group by 1) c;
  select string_agg(number, ', ' order by number) into unsent from {{schema}}.documents
   where kind = 'invoice' and status = 'open' and sent_at is null and issue_date between f and t;
  select count(*)::int, coalesce(sum(a.debit_minor), 0)::bigint, coalesce(sum(a.credit_minor), 0)::bigint,
         coalesce(sum({{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor)) filter (where a.type = 'asset'), 0)::bigint as asset,
         coalesce(sum({{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor)) filter (where a.type = 'liability'), 0)::bigint as liability,
         coalesce(sum({{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor)) filter (where a.type = 'equity'), 0)::bigint as equity,
         coalesce(sum({{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor)) filter (where a.type = 'income'), 0)::bigint as income,
         coalesce(sum({{schema}}.natural_balance(a.type, a.debit_minor, a.credit_minor)) filter (where a.type = 'expense'), 0)::bigint as expense
    into n, dr, cr, a_asset, a_liab, a_eq, a_inc, a_exp
    from {{schema}}.account_totals(null, t, 'INR') a;
  bs := a_asset = a_liab + a_eq + (a_inc - a_exp);
  select locked_at, reason into lk from {{schema}}.period_locks where month = f;
  items := jsonb_build_array(
    jsonb_build_object('key', 'bank', 'title', 'Import and match every bank line', 'ok', here = 0,
                       'detail', case when here > 0 then format('%s line(s) still unmatched in %s', here, m) else 'All matched' end,
                       'link', case when here > 0 then 'reconcile' end),
    jsonb_build_object('key', 'earlier', 'title', 'Earlier months reconciled', 'ok', earlier is null,
                       'detail', coalesce(earlier, 'Nothing carried over'), 'link', case when earlier is not null then 'reconcile' end),
    jsonb_build_object('key', 'invoices', 'title', 'Send this month''s invoices', 'ok', unsent is null,
                       'detail', case when unsent is not null then 'Not sent: ' || unsent else 'All sent' end, 'link', case when unsent is not null then 'money' end),
    jsonb_build_object('key', 'trial_balance', 'title', 'Trial balance balances', 'ok', dr = cr,
                       'detail', format('Debits ₹%s · credits ₹%s', {{schema}}.fmt_inr(dr), {{schema}}.fmt_inr(cr)), 'link', null),
    jsonb_build_object('key', 'balance_sheet', 'title', 'Balance sheet balances', 'ok', bs,
                       'detail', format('Assets ₹%s', {{schema}}.fmt_inr(a_asset)), 'link', null),
    jsonb_build_object('key', 'lock', 'title', 'Lock the month', 'ok', lk.locked_at is not null,
                       'detail', case when lk.locked_at is not null
                                      then 'Closed ' || left({{schema}}.iso_ts(lk.locked_at), 10) || case when coalesce(lk.reason, '') <> '' then ' · ' || lk.reason else '' end
                                      else 'Ledger proposes the close; a person approves it' end,
                       'link', null));
  return {{schema}}.read_head(n, '{}', format('bank lines, invoices and all entries up to %s', {{schema}}.iso_date(t)), 'INR')
    || jsonb_build_object('month', m, 'closed', lk.locked_at is not null,
                          'done', (select count(*)::int from jsonb_array_elements(items) i where (i->>'ok')::boolean), 'of', 6, 'items', items);
end $$;

create function {{schema}}.read_periods_status(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  closed jsonb;
  cnt integer;
  unrec jsonb;
begin
  perform {{schema}}.require_line_on('ledger.periods.status');
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(month, 'YYYY-MM'), 'locked_at', {{schema}}.iso_ts(locked_at), 'locked_by', locked_by, 'reason', reason) order by month), '[]'::jsonb),
         count(*)::int
    into closed, cnt from {{schema}}.period_locks;
  select coalesce(jsonb_agg(jsonb_build_object('month', month, 'n', n) order by month), '[]'::jsonb) into unrec
    from (select to_char(date_trunc('month', txn_date), 'YYYY-MM') as month, count(*)::int as n from {{schema}}.bank_transactions where status = 'unmatched' group by 1) u;
  return {{schema}}.read_head(cnt, '{}', 'period locks and unreconciled bank lines by month', 'INR')
    || jsonb_build_object('closed', closed, 'unreconciled_by_month', unrec);
end $$;

-- ── inherited: the cash forecast and the tax return ───────────────────────────────────────────────────────────────
create function {{schema}}.read_cash_forecast(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  as_of text := coalesce(p->>'as_of', to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD'));
  d date := coalesce({{schema}}.arg_date(p, 'as_of'), (now() at time zone 'UTC')::date);
  s record;
  weeks integer;
  opening bigint;
  src record;
  n_ar integer;
  n_ap integer;
  bal bigint;
  lowest bigint;
  runway integer;
  runway_end text;
  rows_ jsonb := '[]'::jsonb;
  w integer;
  wfrom date;
  wto date;
  inflow bigint;
  outflow bigint;
begin
  perform {{schema}}.require_line_on('ledger.report.cash_forecast');
  select * into s from {{schema}}.settings_now();
  weeks := coalesce((p->>'weeks')::int, s.forecast_weeks);
  select coalesce(sum({{schema}}.natural_balance(t.type, t.debit_minor, t.credit_minor)) filter (where t.subtype in ('bank', 'cash')), 0)::bigint
    into opening from {{schema}}.account_totals(null, d, cur) t;
  select count(*) filter (where kind = 'invoice')::int, count(*) filter (where kind = 'bill')::int into n_ar, n_ap
    from {{schema}}.documents where status = 'open' and currency = cur and total_minor > paid_minor and kind in ('invoice', 'bill');
  bal := opening;
  lowest := opening;
  for w in 1..weeks loop
    wfrom := d + 7 * (w - 1);
    wto := d + 7 * w;
    select coalesce(sum(total_minor - paid_minor) filter (where kind = 'invoice'), 0)::bigint,
           coalesce(sum(total_minor - paid_minor) filter (where kind = 'bill'), 0)::bigint
      into inflow, outflow
      from {{schema}}.documents
     where status = 'open' and currency = cur and total_minor > paid_minor and kind in ('invoice', 'bill')
       and due_date <= wto and (w = 1 or due_date > wfrom);
    bal := bal + inflow - outflow;
    lowest := least(lowest, bal);
    if runway is null and bal < s.min_cash_buffer_minor then
      runway := w;
      runway_end := {{schema}}.iso_date(wto);
    end if;
    rows_ := rows_ || jsonb_build_array(jsonb_build_object('week', w, 'week_ending', {{schema}}.iso_date(wto), 'inflow_minor', inflow, 'outflow_minor', outflow,
                                                           'net_minor', inflow - outflow, 'balance_minor', bal));
  end loop;
  select * into src from {{schema}}.entry_sources(null, d, cur);
  return {{schema}}.read_head(src.n + n_ar + n_ap, src.ids, format('cash and bank balances up to %s; open invoices (in) and bills (out) by due date', as_of), cur)
    || jsonb_build_object(
      'as_of', as_of,
      'opening_cash_minor', opening,
      'min_cash_buffer_minor', s.min_cash_buffer_minor,
      'weeks', rows_,
      'closing_minor', bal,
      'lowest_balance_minor', lowest,
      'runway_week', runway,
      'week_ending_below_buffer', runway_end,
      'warning', case when runway is null then null
                      else format('Cash is projected to fall below the ₹%s buffer in week %s (week ending %s).', {{schema}}.fmt_inr(s.min_cash_buffer_minor), runway, runway_end) end,
      'assumptions', 'Only documents in the books move this forecast: customers pay open invoices on their due date and open bills are paid on theirs; anything already overdue lands in week 1. Salaries, rent and other costs without a bill are not included.');
end $$;

create function {{schema}}.read_tax_return(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  cur text := coalesce(p->>'currency', 'INR');
  f date := {{schema}}.arg_date(p, 'from');
  t date := {{schema}}.arg_date(p, 'to');
  s record;
  src record;
  x record;
  reclaim bigint;
  net bigint;
  name text;
  boxes jsonb;
  due text;
  blockers jsonb := '[]'::jsonb;
  inv_tax bigint;
  bill_tax bigint;
begin
  perform {{schema}}.require_line_on('ledger.report.tax_return');
  select * into s from {{schema}}.settings_now();
  select * into src from {{schema}}.entry_sources(f, t, cur);
  select coalesce(sum(a.credit_minor - a.debit_minor) filter (where a.subtype = 'tax_output'), 0)::bigint as output,
         coalesce(sum(a.debit_minor - a.credit_minor) filter (where a.subtype = 'tax_input'), 0)::bigint as input_booked,
         coalesce(sum(a.credit_minor - a.debit_minor) filter (where a.type = 'income'), 0)::bigint as sales,
         coalesce(sum(a.debit_minor - a.credit_minor) filter (where a.type = 'expense'), 0)::bigint as purchases
    into x from {{schema}}.account_totals(f, t, cur) a;
  reclaim := case when s.tax_regime = 'US_SALES_TAX' then 0 else x.input_booked end;
  net := x.output - reclaim;
  name := case s.tax_regime when 'IN_GST' then 'GST' when 'UK_VAT' then 'VAT' when 'EU_VAT' then 'VAT' when 'US_SALES_TAX' then 'Sales tax' else 'Tax' end;
  if s.tax_regime in ('UK_VAT', 'EU_VAT') then
    boxes := jsonb_build_array(
      jsonb_build_object('box', '1', 'label', 'VAT due on sales and other outputs', 'amount_minor', x.output),
      jsonb_build_object('box', '2', 'label', 'VAT due on acquisitions (NI)', 'amount_minor', 0),
      jsonb_build_object('box', '3', 'label', 'Total VAT due', 'amount_minor', x.output),
      jsonb_build_object('box', '4', 'label', 'VAT reclaimed on purchases and other inputs', 'amount_minor', reclaim),
      jsonb_build_object('box', '5', 'label', 'Net VAT to pay (or reclaim)', 'amount_minor', net),
      jsonb_build_object('box', '6', 'label', 'Total value of sales excluding VAT', 'amount_minor', x.sales),
      jsonb_build_object('box', '7', 'label', 'Total value of purchases excluding VAT', 'amount_minor', x.purchases),
      jsonb_build_object('box', '8', 'label', 'Goods supplied to the EU (NI)', 'amount_minor', 0),
      jsonb_build_object('box', '9', 'label', 'Goods acquired from the EU (NI)', 'amount_minor', 0));
  else
    boxes := jsonb_build_array(
      jsonb_build_object('box', 'output', 'label', format('Output %s on sales', name), 'amount_minor', x.output),
      jsonb_build_object('box', 'input', 'label', case when reclaim <> 0 or s.tax_regime <> 'US_SALES_TAX' then format('Input %s credit on purchases', name)
                                                        else format('Input credit (not reclaimable under %s)', name) end, 'amount_minor', reclaim),
      jsonb_build_object('box', 'net', 'label', format('Net %s payable', name), 'amount_minor', net),
      jsonb_build_object('box', 'sales', 'label', 'Total sales (excl. tax)', 'amount_minor', x.sales),
      jsonb_build_object('box', 'purchases', 'label', 'Total purchases (excl. tax)', 'amount_minor', x.purchases));
  end if;
  -- GSTR-3B: the 20th of the next month; UK VAT: one month and seven days after the period (the last day of the next month + 7).
  due := case s.tax_regime
           when 'IN_GST' then {{schema}}.iso_date((date_trunc('month', t) + interval '1 month')::date + 19)
           when 'UK_VAT' then {{schema}}.iso_date((date_trunc('month', t) + interval '2 months' - interval '1 day')::date + 7)
         end;
  if s.tax_regime = 'none' then blockers := blockers || to_jsonb('No tax regime is set; set it in the company settings (ledger.settings.update).'::text); end if;
  if s.tax_regime = 'UK_VAT' and s.return_frequency <> 'quarterly' then
    blockers := blockers || to_jsonb('UK VAT returns are normally quarterly; check the return frequency in the settings.'::text);
  end if;
  select coalesce(sum(tax_minor) filter (where kind = 'invoice'), 0)::bigint, coalesce(sum(tax_minor) filter (where kind = 'bill'), 0)::bigint
    into inv_tax, bill_tax
    from {{schema}}.documents where status <> 'void' and currency = cur and issue_date between f and t;
  return {{schema}}.read_head(src.n, src.ids, format('journal entries dated %s..%s; tax accounts by subtype', p->>'from', p->>'to'), cur)
    || jsonb_build_object(
      'period', jsonb_build_object('from', p->>'from', 'to', p->>'to'),
      'regime', s.tax_regime,
      'frequency', s.return_frequency,
      'tax_name', name,
      'boxes', boxes,
      'output_tax_minor', x.output,
      'input_tax_minor', reclaim,
      'input_tax_booked_minor', x.input_booked,
      'net_payable_minor', net,
      'sales_ex_tax_minor', x.sales,
      'purchases_ex_tax_minor', x.purchases,
      'due_date', due,
      'blockers', blockers,
      'documents', jsonb_build_object('invoices_tax_minor', inv_tax, 'bills_tax_minor', bill_tax,
                                      'output_difference_minor', x.output - inv_tax, 'input_difference_minor', x.input_booked - bill_tax));
end $$;

-- ── declared: what the NEOS screens may read (template t018's block_read runs only these) ────────────────────────
insert into {{schema}}.declared_reads (ability, fn) values
  ('ledger.accounts.list', 'read_accounts_list'),
  ('ledger.account.ledger', 'read_account_ledger'),
  ('ledger.journal.list', 'read_journal_list'),
  ('ledger.documents.list', 'read_documents_list'),
  ('ledger.parties.list', 'read_parties_list'),
  ('ledger.bank.unreconciled', 'read_bank_unreconciled'),
  ('ledger.coding_rules.list', 'read_coding_rules_list'),
  ('ledger.home.summary', 'read_home_summary'),
  ('ledger.close.checklist', 'read_close_checklist'),
  ('ledger.periods.status', 'read_periods_status'),
  ('ledger.report.pnl', 'read_pnl'),
  ('ledger.report.balance_sheet', 'read_balance_sheet'),
  ('ledger.report.cash_flow', 'read_cash_flow'),
  ('ledger.report.trial_balance', 'read_trial_balance'),
  ('ledger.report.aging', 'read_aging'),
  ('ledger.report.vat_summary', 'read_vat_summary'),
  ('ledger.report.cash_forecast', 'read_cash_forecast'),
  ('ledger.report.tax_return', 'read_tax_return');

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = '{{schema}}'
              and p.proname in ('require_line_on', 'arg_date', 'iso_ts', 'iso_date', 'company_today', 'fmt_inr', 'read_head', 'account_totals', 'natural_balance', 'entry_sources',
                                'open_documents', 'settings_now', 'report_lines', 'read_pnl', 'read_balance_sheet', 'read_trial_balance', 'read_vat_summary',
                                'read_cash_flow', 'read_aging', 'read_accounts_list', 'read_account_ledger', 'read_journal_list', 'read_documents_list',
                                'read_parties_list', 'read_bank_unreconciled', 'read_coding_rules_list', 'read_home_summary', 'read_close_checklist',
                                'read_periods_status', 'read_cash_forecast', 'read_tax_return') loop
    execute format('revoke all on function %s from public', r.f);
    execute format('grant execute on function %s to {{schema}}_app, {{schema}}_runner', r.f);
  end loop;
end $$;
