-- Raw layer: one unified table for all sheet tabs, discriminated by source_sheet.
-- Deliberately NOT one physical table per tab (10 tables) as a literal reading of the
-- build spec suggests -- a single table with a source_sheet column lets a brand new
-- month tab (e.g. "September 2026") be onboarded by adding one line to MONTH_SHEETS in
-- the ingestion script, with zero migrations required. That's the spec's own stated
-- goal for extensibility; 10 separate tables plus a UNION view would work against it.
--
-- Written by the ingestion job (scripts/sync-sheets.mjs) using the service_role key only.
-- Dates/numerics arrive already lightly cleaned (see spec section 3); everything else is
-- structural repair happens in the views layer below, not here.

create table if not exists raw_orders (
  id                     bigint generated always as identity primary key,
  source_sheet           text not null,
  source_row_number      int not null,
  order_no               text,
  customer_name          text,
  country                text,
  product_name           text,
  sku                    text,
  order_date             date,
  shipping_date          date,
  order_status           text,
  size_measurements      text,
  payment_mode           text,
  order_amount_mrp       numeric,
  shipping_charges       numeric,
  customization_charges  numeric,
  discount               numeric,
  total                  numeric,
  payment_received       numeric,
  balance                numeric,
  synced_at              timestamptz not null default now()
);

create index if not exists raw_orders_sheet_row_idx on raw_orders (source_sheet, source_row_number);
create index if not exists raw_orders_order_no_idx on raw_orders (order_no);

-- Defence in depth: RLS on, no policies -> default deny for anon/authenticated.
-- (service_role bypasses RLS by design, which is how the ingestion job and the
-- Next.js server-side API routes are able to read/write regardless.)
alter table raw_orders enable row level security;
revoke all on raw_orders from anon, authenticated;

-- Ingestion run log, for observability into the unattended GitHub Actions sync job.
create table if not exists sync_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running', -- running | success | error
  rows_ingested  int,
  error_message  text
);
alter table sync_runs enable row level security;
revoke all on sync_runs from anon, authenticated;
