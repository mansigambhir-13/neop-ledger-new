-- 007_views.sql · app-team-owned. Expand-only. WP v3 §11: "heavy reads are declared views in the
-- migration file — real SQL, reviewed once, not improvised at runtime". These are the basis views the
-- trial balance and ageing reads stand on; the reads' own filters (as-of date, currency) apply on top.
-- security_invoker: a view reads with the caller's rights, so row-level security scopes it to the
-- caller's company exactly as the tables do.

-- Posted amounts per account per day and currency. A trial balance as of D is
--   select code, sum(debit_minor), sum(credit_minor) … where entry_date <= D and currency = C group by account.
create view {{schema}}.v_account_balances with (security_invoker = true) as
select l.company_id,
       a.id as account_id,
       a.code,
       a.name,
       a.type,
       a.subtype,
       e.currency,
       e.entry_date,
       sum(l.debit_minor)::bigint as debit_minor,
       sum(l.credit_minor)::bigint as credit_minor,
       count(distinct e.id)::int as entries
  from {{schema}}.journal_lines l
  join {{schema}}.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
  join {{schema}}.accounts a on a.company_id = l.company_id and a.id = l.account_id
 group by l.company_id, a.id, a.code, a.name, a.type, a.subtype, e.currency, e.entry_date;

-- Every open invoice or bill with something still owed. Ageing as of D is
--   … where issue_date <= D and currency = C, bucketed by D - due_date.
create view {{schema}}.v_ageing with (security_invoker = true) as
select d.company_id,
       d.id as document_id,
       d.kind,
       case d.kind when 'invoice' then 'receivable' else 'payable' end as ageing_kind,
       d.number,
       p.id as party_id,
       p.name as party,
       d.issue_date,
       d.due_date,
       d.currency,
       (d.total_minor - d.paid_minor)::bigint as outstanding_minor
  from {{schema}}.documents d
  join {{schema}}.parties p on p.company_id = d.company_id and p.id = d.party_id
 where d.status = 'open' and d.total_minor > d.paid_minor;

grant select on {{schema}}.v_account_balances, {{schema}}.v_ageing to {{schema}}_app;
