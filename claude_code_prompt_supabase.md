# Build prompt for Claude Code — Mahima Mahajan Live Dispatch Dashboard (Supabase architecture)

Paste everything below into Claude Code as-is.

---

## 0. Context

I have a working static prototype dashboard (`MM_Dispatch_Web_Dashboard.html`) with a bright,
professional design: plum (#4B2E83) + gold (#C6922E) palette, Fraunces serif for headings, Manrope for
body/data, rounded KPI cards with a colored top accent, 8 charts, a tabbed table section, and a 2-button
segmented toggle ("Visuals" / "Tables") that shows one section and hides the other while filters and KPI
cards stay visible in both. **Reuse that visual design exactly** — I'm copying that file into this
project as the frontend starting point. Replace its demo-data generator with the live pipeline below.

## 1. Architecture

```
Google Sheet (10 tabs, VIEW-ONLY access — see note below)
        ↓  pulled every 5–10 min via GitHub Actions (OAuth, my own account)
        ▼
Supabase Postgres — raw_* tables (one per tab)
        ↓  SQL views + materialized views (business logic, fill-forward, dedup, derive)
        ▼
fact_orders + reporting views  (RLS: only server can read raw tables; anon can read reporting views only)
        ↓
Next.js on Vercel — API routes (service_role key, server-side only)
        ↓  ISR (~90s revalidate) + SWR background refetch + optional Supabase Realtime
        ▼
Dashboard (reuses MM_Dispatch_Web_Dashboard.html design)
```

**Important constraint — read this before building the ingestion step**: I only have Viewer (view-only)
access to the source Google Sheet, not Editor. That rules out a container-bound Apps Script with an
`onChange`/`onEdit` installable trigger as the ingestion mechanism — Google's own documentation states
installable triggers "don't run if a file is opened in read-only (view or comment) mode," and a
container-bound script can't even be created without Editor access to the file. So ingestion here is
**pull-based** (a scheduled job reading via my own OAuth-authorized read access, which does work with
Viewer permission), not push-based. Section 3 has the full mechanism and an optional upgrade path if
Editor access becomes available later.

Also note: if this deploys on Vercel's free Hobby plan, **do not use `vercel.json` cron for the sync
job** — Hobby-tier cron is capped at once per day (anything more frequent fails at deploy time). Use
GitHub Actions for the 5–10 minute schedule instead (free, supports 5-minute cadence, best-effort
timing). Vercel Cron is fine to use for anything that only needs to run daily.

## 2. Data source & sheet map

Spreadsheet: `https://docs.google.com/spreadsheets/d/19g0hXf71pX5Oh0bGeaN-nJifU-jkPExTvgdnl1CUCd8/`

| # | Tab name (exact)     | gid        | Verified |
|---|-----------------------|------------|----------|
| 1 | `Mehfill orders`      | 511481291  | confirmed |
| 2 | `EOSS 26`             | 2015662649 | confirmed |
| 3 | `Jan 2026`            | 1741516118 | confirmed |
| 4 | `Feb 2026`            | 289962841  | confirmed |
| 5 | `MARCH 2026`          | 1662273297 | inferred from naming pattern |
| 6 | `April 2026`          | 34623728   | inferred |
| 7 | `May 2026`            | 2071087076 | inferred |
| 8 | `June 2026 / EOSS`    | 1789133391 | inferred |
| 9 | `July 2026`           | 1617166096 | inferred |
| 10| `August 2026`         | 1628602740 | **confirmed** — new tab, orders from 01.08.2026, new "payglocal" payment mode |

At startup (or first ingestion run), call `spreadsheets.get` (metadata) and confirm these tab names
actually exist; log a warning (don't hard-fail) if any of the "inferred" ones don't match — fall back to
matching by `gid`/`sheetId` from the metadata response instead.

New month tabs (e.g. September 2026) should be addable by appending one entry to a `MONTH_SHEETS`
config array — build the ingestion script so that's the only change needed.

## 3. Ingestion layer (pull-based — works with view-only access today)

**Auth**: OAuth2 using my own Google account (has Viewer access to the sheet).
1. In Google Cloud Console: enable the Sheets API, create an OAuth 2.0 Client ID (Desktop app type is
   simplest), scope `https://www.googleapis.com/auth/spreadsheets.readonly`.
2. A one-time local script (`npm run auth`) opens a consent screen, I sign in, and it outputs a refresh
   token. Store `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and the refresh token as
   encrypted GitHub Actions secrets (plus `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`).

**Schedule**: GitHub Actions workflow, `on: schedule: - cron: '*/10 * * * *'` (every 10 minutes; GitHub
enforces a practical minimum around 5 minutes and schedules are best-effort/can slip during high load —
fine for this use case), plus `workflow_dispatch:` so I can trigger a manual sync from the GitHub UI.

**What the job does, per run**:
1. `sheets.spreadsheets.values.batchGet` across all 10 tabs (one batched call, ranges like
   `'{Sheet Name}'!A1:AB2000` — wrap names containing spaces or `/` in single quotes).
2. Per tab, do only *light structural cleaning* in JS (heavier business logic belongs in Postgres views,
   section 4) — this is the natural split since JS/date libraries handle messy real-world text far
   better than raw SQL string parsing:
   - Locate the real header row (scan first 3 rows for one containing an order-number-like column and
     `Order Date` — some tabs, e.g. `Jan 2026` and `Feb 2026`, have a spurious blank/placeholder row
     above the real header).
   - Map each tab's differently-named order-number column to a canonical `order_no`:
     `Mehfill orders`→`order no`, `EOSS 26`→`EOSS`, `Jan 2026`→`order no`, `Feb 2026`→`order no`,
     `MARCH 2026`→`Order Numer ` (sheet has this typo/trailing space), `April 2026`→`Order Number `,
     `May 2026`→`Order No`, `June 2026 / EOSS`→ blank header (first column), `July 2026`→`Order No`,
     `August 2026`→`Order No`.
   - Strip literal `"EOSS"` and `"#"` substrings from the order-number value; trim; empty string → null.
   - Normalize `Order Date` / `Shipping Date`: replace `.` with `/`, parse as `DD/MM/YYYY` (UK/`en-GB`,
     day-first — not US month-first), store as ISO date string or `null` if unparseable (don't throw —
     real data has typos like `"7th feb"`, `20.02.2206`).
   - Drop noisy columns before upload (don't even store them): `Outfit Image`,
     `Customization picture for color and other details`, `Customization NOTE for color and other
     details`, `Additional note- DIVYA`, `Additional (Online Team)` (also appears with a literal
     line-break), `WA conversation`.
   - Where `Size & Measurements - Yes / No` is an unreadable/image reference rather than text, store
     the literal string `"photo"`.
   - Numeric fixups on `Order Amount (MRP)`, `Shipping charges`, `Customization Charges`, `Discount`,
     `Total`, `Payment Received`, `Balance`: strip commas (Indian-style grouping, e.g. `1,38,000`), take
     the leading numeric portion of noisy values (`"37500   Cleared"` → `37500`), parse as float,
     default to `0` on failure — never throw.
3. **Full refresh per raw table**: `TRUNCATE` each `raw_<tab>` table and bulk-insert the freshly pulled
   rows (simpler and more correct than row-level upsert here — it's a few thousand rows total, so cost
   is negligible, and a full refresh correctly handles rows that were *deleted* in the sheet, which a
   keyed upsert alone would leave orphaned). Tag every row with `source_row_number` (its position in the
   tab, needed for fill-forward ordering in section 4) and `synced_at = now()`.
   - If incremental upsert is preferred instead (e.g. to preserve row history), use PostgREST's
     `Prefer: resolution=merge-duplicates` header against a natural key of
     `(source_sheet, source_row_number)` — but default to full-refresh unless there's a reason not to.

**Upgrade path (document in the README, don't build yet)**: if someone with Editor access on the sheet
is willing to do a 5-minute one-time setup, they can install a container-bound Apps Script with an
installable `onEdit` + `onChange` trigger (requires Edit access to create) that calls the same Supabase
upsert endpoint immediately on every change, with a 15-minute time-driven trigger as a backup. That
replaces the GitHub Actions polling with true near-instant push — nothing else in this architecture
(Postgres, RLS, Next.js) needs to change.

## 4. Supabase Postgres layer

**Raw tables** — one per tab (`raw_mehfill_orders`, `raw_eoss_26`, `raw_jan_2026`, ... `raw_august_2026`),
lightly typed (`order_no text`, `order_date date`, `shipping_date date`, numeric columns `numeric`,
everything else `text`), plus `source_row_number int`, `synced_at timestamptz`.

**`stg_all_orders` view** — `UNION ALL` of all 10 raw tables mapped to one canonical column set, each
row tagged `source_sheet`.

**Fill-forward** — several tabs have "sub-item" rows directly below a main order that leave `order_no`
(all sheets), `shipping_date` (`Mehfill orders`, `June 2026 / EOSS` only), and `customer_name`
(`Mehfill orders` only) blank because they're implied from the row above. Implement with the grouping
technique (portable across PG versions, doesn't depend on `IGNORE NULLS` support):
```sql
WITH tagged AS (
  SELECT *,
    COUNT(order_no) OVER (PARTITION BY source_sheet ORDER BY source_row_number) AS grp
  FROM stg_all_orders
)
SELECT *,
  FIRST_VALUE(order_no) OVER (PARTITION BY source_sheet, grp ORDER BY source_row_number) AS order_no_filled
FROM tagged
```
Repeat the same pattern for `shipping_date`/`customer_name` only within the sheets noted above (gate
with a `CASE WHEN source_sheet IN (...)` rather than applying to every sheet).

**Row filters** (apply per sheet, matching the original recipe):
- `EOSS 26`, `Jan 2026`, `Feb 2026`, `April 2026`, `May 2026`, `June 2026 / EOSS`, `August 2026`: keep
  only rows where `product_name` is not blank.
- `July 2026`: keep only rows where `shipping_date` is not null (different rule).
- `MARCH 2026`: no product-name filter — just drop fully-blank rows.
- All sheets: drop rows where every column is null/blank.

**Measurement status derivation** (order-level, not row-level — one order can have multiple product
rows):
```sql
-- hasMeasurement per row
val = lower(trim(size_measurements))
hasDigit = val ~ '[0-9]'
isPlaceholder = val = '' OR val ILIKE '%yet to share%' OR val ILIKE '%to be shared%'
                OR val ILIKE '%will share%' OR val ILIKE '%will give%'
hasMeasurement = hasDigit OR NOT isPlaceholder

-- then, grouped by order_no:
measurement_status = CASE WHEN bool_or(hasMeasurement) OVER (PARTITION BY order_no)
                          THEN 'Received' ELSE 'Missing' END
```

**`fact_orders` materialized view** — from the filled/filtered/derived staging view: `DISTINCT ON
(order_no, product_name, sku, order_date)` for dedup, final numeric cleanup pass (regexp-strip commas,
cast numeric) on `order_amount_mrp`, `total`, `payment_received` in case the union reintroduced
text-typed values, rename `"Size & Measurements - Yes / No "` (trailing space) → no trailing space.
Needs a unique index (e.g. on `order_no, product_name, sku, order_date`) to support
`REFRESH MATERIALIZED VIEW CONCURRENTLY`.

**Timezone-aware date logic** — anything computing "today" (overdue orders, shipping-in-next-5-days,
etc.) must use `(now() AT TIME ZONE 'Asia/Kolkata')::date`, never bare `CURRENT_DATE` (UTC-based) —
apply consistently in every view/query that needs "today."

**Reporting views** (the only objects exposed to `anon`): `v_kpi_summary` (total orders, total revenue
`sum(total)`, balance due `sum(balance)`, orders missing measurements, measurement completion %,
countries served, shipping-in-5-days count, overdue count), `v_orders_by_status`,
`v_orders_by_country`, `v_revenue_by_country`, `v_monthly_orders`, `v_monthly_revenue`,
`v_balance_breakdown`, `v_top_products`.

**pg_cron**: refresh the materialized view(s) every 5–10 minutes, after the ingestion job has landed:
```sql
SELECT cron.schedule('refresh-fact-orders', '*/10 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY fact_orders$$);
```
Note: confirm pg_cron is enabled/available on your current Supabase plan, and check current Supabase
docs on free-tier project auto-pause behavior after inactivity — recurring PostgREST calls from the
ingestion job count as external API activity, which should keep the project active, but this is worth
verifying against current policy before relying on it.

## 5. Security / RLS

- Enable RLS on every `raw_*` table and on `fact_orders` — default-deny, no policies granting `anon`
  access.
- Grant `SELECT` + a permissive RLS policy (`USING (true)`) on the reporting views only, scoped to the
  `anon` role — used only for an optional Supabase Realtime subscription so the browser gets pushed
  updates without polling.
- `service_role` key (bypasses RLS) is used only server-side: by the GitHub Actions ingestion job
  (writing raw tables) and by Next.js API routes (reading anything beyond the public reporting views).
  It must never reach the browser bundle.

## 6. Frontend (Next.js on Vercel)

- API routes query Supabase with the `service_role` key, server-side only.
- Pages use ISR with `revalidate: 90` (within the 60–120s window).
- SWR on the client for background refetch as a second freshness layer.
- Optional: subscribe to Supabase Realtime on the reporting views for push updates that bypass polling
  entirely. Running ISR + SWR + Realtime together is a bit belt-and-suspenders (three overlapping
  freshness mechanisms) — fine to ship all three now, but any one of them alone would also be enough if
  you want to simplify later.
- Reuse `MM_Dispatch_Web_Dashboard.html`'s design exactly: plum/gold palette, Fraunces + Manrope, the
  2-button Visuals/Tables toggle (filters + KPI cards stay visible in both modes), 8 charts (orders by
  status, balance due vs collected, measurement breakdown, top products, monthly orders, monthly
  revenue, orders by country, revenue by country), tabbed tables (All orders / Shipping in 5 days /
  Missing measurements / Balance due), each searchable.

## 7. Deliverables

1. GitHub Actions workflow (`.github/workflows/sync.yml`) implementing section 3.
2. Supabase SQL migrations: raw tables, staging/derivation views, `fact_orders` materialized view,
   reporting views, RLS policies, pg_cron schedule.
3. Next.js app: API routes + dashboard UI per section 6.
4. `.env.example` covering `GOOGLE_OAUTH_CLIENT_ID/SECRET` + refresh token var, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.
5. README covering: the one-time OAuth login flow, Supabase project setup, how to add a new month tab
   (edit `MONTH_SHEETS`), how to switch to Apps Script push later if Editor access becomes available,
   the GitHub Actions vs. Vercel-cron distinction (and why Hobby-tier Vercel cron won't work for this),
   and current Supabase free-tier pause policy to double-check.
