-- 003_declared_reads.sql · Expand-only. V3-MIGRATION-PLAN S9: the NEOS home tile's source (marketing.stats.read) is one
-- SQL function, declared for template t018's block_read; the handler calls the same function (one answer).
create function {{schema}}.read_stats(p jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  rows_ jsonb;
  days integer;
  imp bigint;
  clk bigint;
  lds bigint;
begin
  -- Switched off at the company (its switch or the floor): answers nobody, not a screen either (42501 → the desk's 403).
  if exists (select 1 from {{schema}}.switchboard s where s.company_id = nullif(current_setting('neos.company_id', true), '')::uuid
              and s.line = 'marketing.stats.read' and (s.setting = 'off' or s.floor = 'off')) then
    raise exception 'switched_off: marketing.stats.read is switched off at this company' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'impressions', impressions, 'clicks', clicks, 'leads', leads) order by channel), '[]'::jsonb),
         coalesce(sum(n), 0)::int, coalesce(sum(impressions), 0)::bigint, coalesce(sum(clicks), 0)::bigint, coalesce(sum(leads), 0)::bigint
    into rows_, days, imp, clk, lds
    from (select s.channel, sum(s.impressions)::int as impressions, sum(s.clicks)::int as clicks, sum(s.leads)::int as leads, count(*)::int as n
            from {{schema}}.channel_stats s
           where s.day between (p->>'from')::date and (p->>'to')::date and (p->>'channel' is null or s.channel = p->>'channel')
           group by s.channel) x;
  return jsonb_build_object(
    'generatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'empty', days = 0,
    'sources', jsonb_build_object('entries', days, 'entry_ids', '[]'::jsonb, 'basis', format('daily channel stats %s..%s', p->>'from', p->>'to')),
    'rows', rows_,
    'totals', jsonb_build_object('impressions', imp, 'clicks', clk, 'leads', lds));
end $$;
revoke all on function {{schema}}.read_stats(jsonb) from public;
grant execute on function {{schema}}.read_stats(jsonb) to {{schema}}_app, {{schema}}_runner;

insert into {{schema}}.declared_reads (ability, fn) values ('marketing.stats.read', 'read_stats');
