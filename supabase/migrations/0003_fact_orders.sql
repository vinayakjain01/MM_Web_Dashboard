-- Fact layer: one row per (order, product line), deduped, numerics defaulted, and the
-- trailing-space column name from the sheet ("Size & Measurements - Yes / No ") cleaned up.
-- Materialized so the dashboard never pays the fill-forward/window-function cost per request;
-- refreshed on a schedule by pg_cron (see 0004).

create materialized view if not exists fact_orders as
select distinct on (order_no_filled, product_name, sku, order_date)
  order_no_filled           as order_no,
  customer_name_filled      as customer_name,
  country,
  product_name,
  sku,
  order_date,
  shipping_date_filled      as shipping_date,
  order_status,
  case when order_has_measurement then 'Received' else 'Missing' end as measurement_status,
  sheet_status,
  size_measurements,
  source_sheet,
  payment_mode,
  coalesce(order_amount_mrp, 0)      as order_amount_mrp,
  coalesce(shipping_charges, 0)      as shipping_charges,
  coalesce(customization_charges, 0) as customization_charges,
  coalesce(discount, 0)              as discount,
  coalesce(total, 0)                 as total,
  coalesce(payment_received, 0)      as payment_received,
  coalesce(balance, 0)               as balance
from stg_orders_measurement
where order_no_filled is not null
order by order_no_filled, product_name, sku, order_date, source_row_number desc;

-- Needed so `REFRESH MATERIALIZED VIEW CONCURRENTLY` (no read lock during refresh) works.
create unique index if not exists fact_orders_uidx
  on fact_orders (order_no, product_name, sku, order_date);

create index if not exists fact_orders_order_date_idx on fact_orders (order_date);
create index if not exists fact_orders_country_idx on fact_orders (country);
create index if not exists fact_orders_status_idx on fact_orders (order_status);

-- Materialized views can't have RLS at all (Postgres limitation) -- the only real
-- protection is that anon/authenticated are never granted SELECT on it. The Next.js app
-- reads this exclusively through the service_role key server-side, which bypasses RLS
-- and grants alike, so this is enough.
revoke all on fact_orders from anon, authenticated;
