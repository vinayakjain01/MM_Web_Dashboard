-- Callable over PostgREST (via the service_role key) so the ingestion job can refresh
-- fact_orders immediately after a sync lands, instead of waiting on pg_cron's independent
-- schedule -- avoids stacking two 10-minute cycles into a worst-case 20-minute staleness.
-- pg_cron (0004) still runs as a backstop in case a sync run never reaches this call.
create or replace function refresh_fact_orders()
returns void
language sql
security definer
set search_path = public
as $$
  refresh materialized view concurrently fact_orders;
$$;

revoke all on function refresh_fact_orders() from anon, authenticated;
grant execute on function refresh_fact_orders() to service_role;
