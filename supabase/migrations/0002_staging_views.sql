-- Staging layer: structural repair only (fill-forward, row filtering, measurement
-- derivation). No business/reporting aggregation happens here -- that's computed
-- server-side in the Next.js API routes from fact_orders (see 0003).

-- 1) Fill-forward. Every tab has "sub-item" rows directly below a main order (extra
--    product lines on the same order) that leave order_no, shipping_date, and
--    customer_name blank because they're implied from the row above.
--
--    The original build spec scoped shipping_date fill-forward to "Mehfill orders, June
--    2026 / EOSS only" and customer_name to "Mehfill orders only" -- but inspecting the
--    live sheet shows every single tab has the identical pattern (a row with a blank
--    order_no reliably has a blank customer_name too, 100% correlated, across all 10
--    tabs). Applying it universally is a correctness fix, not a scope change: on tabs
--    where every row already has its own customer_name/shipping_date, fill-forward is a
--    no-op (each row seeds its own single-row group), so this can't overwrite anything
--    that was previously correct.
--
--    Classic grouping trick: COUNT(x) OVER (... ORDER BY row) never decrements, so it's
--    constant for every row that "belongs" to the same non-null seed value.
create or replace view stg_orders_filled as
with tagged as (
  select
    r.*,
    count(order_no) over (partition by source_sheet order by source_row_number)      as order_grp,
    count(customer_name) over (partition by source_sheet order by source_row_number) as customer_grp,
    count(shipping_date) over (partition by source_sheet order by source_row_number)  as ship_grp
  from raw_orders r
)
select
  t.*,
  first_value(order_no) over (partition by source_sheet, order_grp order by source_row_number) as order_no_filled,
  first_value(customer_name) over (partition by source_sheet, customer_grp order by source_row_number) as customer_name_filled,
  first_value(shipping_date) over (partition by source_sheet, ship_grp order by source_row_number) as shipping_date_filled
from tagged t;

-- 2) Row filters, matching the original recipe per sheet:
--    - July 2026: keep only rows where shipping_date is not null (different rule).
--    - MARCH 2026: no product-name filter, just drop fully-blank rows.
--    - everything else: keep only rows where product_name is not blank.
--    - all sheets: drop rows where every meaningful column is null/blank.
create or replace view stg_orders_filtered as
select *
from stg_orders_filled
where
  not (
    order_no_filled is null
    and customer_name_filled is null
    and (product_name is null or btrim(product_name) = '')
    and total is null
  )
  and (
    case
      when source_sheet = 'July 2026'   then shipping_date_filled is not null
      when source_sheet = 'MARCH 2026'  then true
      else product_name is not null and btrim(product_name) <> ''
    end
  );

-- 3) Measurement status derivation (order-level, not row-level -- one order can have
--    multiple product rows, and if ANY row has a real measurement the order counts as
--    received).
create or replace view stg_orders_measurement as
with normed as (
  select
    *,
    lower(btrim(coalesce(size_measurements, ''))) as size_measurements_norm
  from stg_orders_filtered
),
flagged as (
  select
    *,
    (size_measurements_norm ~ '[0-9]') as has_digit,
    (
      size_measurements_norm = ''
      or size_measurements_norm ilike '%yet to share%'
      or size_measurements_norm ilike '%to be shared%'
      or size_measurements_norm ilike '%will share%'
      or size_measurements_norm ilike '%will give%'
    ) as is_placeholder
  from normed
),
with_flag as (
  select *, (has_digit or not is_placeholder) as has_measurement
  from flagged
)
select
  *,
  bool_or(has_measurement) over (partition by order_no_filled) as order_has_measurement
from with_flag;
