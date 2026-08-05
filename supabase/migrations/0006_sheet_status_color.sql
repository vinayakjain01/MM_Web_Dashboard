-- 0001's CREATE TABLE IF NOT EXISTS already has this column for a fresh install, but
-- raw_orders already exists on this project -- ALTER it directly for the live database.
alter table raw_orders add column if not exists sheet_status_color text not null default 'No Update';
