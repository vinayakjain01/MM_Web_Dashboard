-- Keep fact_orders fresh after every ingestion cycle. Idempotent: safe to re-run this
-- migration (unschedules and reschedules rather than accumulating duplicate cron jobs).
--
-- NOTE: requires the pg_cron extension to be available on your Supabase plan. If
-- `create extension` fails, enable "pg_cron" from the Supabase dashboard under
-- Database -> Extensions, then re-run just this file.
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'refresh-fact-orders') then
    perform cron.unschedule('refresh-fact-orders');
  end if;
end $$;

select cron.schedule(
  'refresh-fact-orders',
  '*/10 * * * *',
  $$refresh materialized view concurrently fact_orders$$
);
