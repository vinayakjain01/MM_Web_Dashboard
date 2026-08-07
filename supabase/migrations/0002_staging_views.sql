-- Staging layer: structural repair only (fill-forward, row filtering, measurement
-- derivation). No business/reporting aggregation happens here -- that's computed
-- server-side in the Next.js API routes from fact_orders (see 0003).

-- 1) Fill-forward. Every tab has "sub-item" rows directly below a main order (extra
--    product lines on the same order) that leave order_no, order_date, shipping_date,
--    customer_name, and country blank because they're implied from the row above (all
--    five sit in the same vertically-merged block in the live sheet -- order_date and
--    country were each missed in an earlier pass since the original spec never named
--    them, but both need the identical treatment; confirmed against real data: order
--    #5988's second line had a null order_date despite its first line carrying the real
--    date, and order #5240's 2nd/3rd product lines (ZARA, CHAYA) showed no country while
--    its 1st line (Masuma) correctly showed "Oman").
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
--
--    IMPORTANT: customer_grp/ship_grp must be nested INSIDE order_grp (partition by
--    source_sheet, order_grp, ...), not just source_sheet. A row can have its OWN
--    order_no (starting a new order_grp) while still having a blank shipping_date/
--    customer_name for an unrelated structural reason -- e.g. a giant merged "banner" row
--    (see the MMVM cross-reference rows in April/May/June/July 2026) swallows every cell
--    except the merge's anchor column. Without the order_grp boundary, such a row
--    incorrectly inherits the *previous, unrelated* order's shipping_date/customer_name
--    instead of correctly staying blank. Confirmed against real data: order #6025 (July
--    2026, a pure MMVM marker row) was inheriting order #6024's ship date before this fix.
create or replace view stg_orders_filled as
with tagged as (
  select
    r.*,
    count(order_no) over (partition by source_sheet order by source_row_number)      as order_grp,
    count(customer_name) over (partition by source_sheet order by source_row_number) as customer_grp_raw,
    count(order_date) over (partition by source_sheet order by source_row_number)     as order_date_grp_raw,
    count(shipping_date) over (partition by source_sheet order by source_row_number)  as ship_grp_raw,
    count(country) over (partition by source_sheet order by source_row_number)        as country_grp_raw
  from raw_orders r
)
select
  t.*,
  first_value(order_no) over (partition by source_sheet, order_grp order by source_row_number) as order_no_filled,
  first_value(customer_name) over (partition by source_sheet, order_grp, customer_grp_raw order by source_row_number) as customer_name_filled,
  first_value(order_date) over (partition by source_sheet, order_grp, order_date_grp_raw order by source_row_number) as order_date_filled,
  first_value(shipping_date) over (partition by source_sheet, order_grp, ship_grp_raw order by source_row_number) as shipping_date_filled,
  first_value(country) over (partition by source_sheet, order_grp, country_grp_raw order by source_row_number) as country_filled
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
--    received). Same view also derives order-level sheet_status from the manual row
--    color (see 0001): checked against real data, individual lines within one order
--    sometimes disagree (a line can be missing its color while a sibling line has it --
--    never seen a real order with conflicting Cancelled-vs-Dispatched lines, only
--    "colored vs not colored yet" gaps), so this is a bool_or aggregate up to the whole
--    order -- the same pattern as order_has_measurement below -- rather than a sequential
--    fill-down. Cancelled takes precedence over Dispatched if somehow both appear.
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
  bool_or(has_measurement) over (partition by order_no_filled) as order_has_measurement,
  case
    when bool_or(sheet_status_color = 'Cancelled') over (partition by order_no_filled) then 'Cancelled'
    when bool_or(sheet_status_color = 'Dispatched') over (partition by order_no_filled) then 'Dispatched'
    else 'No Update'
  end as sheet_status
from with_flag;
