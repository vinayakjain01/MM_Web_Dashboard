# MM Dispatch — Live Order Dashboard

Google Sheet → GitHub Actions (pull sync) → Supabase Postgres → Next.js on Vercel.

Architecture and rationale: see `claude_code_prompt_supabase.md` in the repo root. This
README covers day-to-day setup and operation.

## Why pull-based sync

The Google account available here only has **Viewer** access to the source spreadsheet,
not Editor. That rules out a container-bound Apps Script `onEdit`/`onChange` trigger
(Google requires Editor access just to create one, and installable triggers don't fire on
a file opened read-only). So a GitHub Actions job polls the sheet every 10 minutes using
OAuth as your own Google account, which works fine with Viewer access. See
`claude_code_prompt_supabase.md` section 0 and the upgrade path below.

## One-time setup

1. **Install and configure**
   ```
   npm install
   cp .env.example .env.local   # then fill in the values below
   ```

2. **Supabase** — already provisioned for this project. `.env.local` needs:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
   - `SUPABASE_DB_URL` — direct Postgres connection, used only by `scripts/run-migrations.mjs`.
     If `db.<ref>.supabase.co` doesn't resolve/connect (it's IPv6-only; common on IPv4-only
     networks), use the session pooler instead — get the exact host from the Supabase
     dashboard's Connect page (it's region-specific, e.g. `aws-0-ap-southeast-2.pooler.supabase.com`)
     and use `postgres.<project-ref>` as the username:
     ```
     postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
     ```
   - Run migrations: `npm run migrate` (idempotent — safe to re-run; tracks what's applied
     in a `schema_migrations` table).

3. **Google OAuth** (Sheets API, read-only)
   - `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — from a Desktop-app OAuth
     client in Google Cloud Console, with the Sheets API enabled.
   - Run `npm run auth` **on your own machine** (not in CI) — it opens a browser consent
     screen for the Google account that has Viewer access to the sheet, then prints
     `GOOGLE_OAUTH_REFRESH_TOKEN=...` to the terminal. Add that to `.env.local`.

4. **GitHub Actions secrets** — add these under repo Settings → Secrets and variables →
   Actions, so `.github/workflows/sync.yml` can run unattended:
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `SHEET_SPREADSHEET_ID`.
   (`SUPABASE_URL` here is the same value as `NEXT_PUBLIC_SUPABASE_URL` locally — no
   `NEXT_PUBLIC_` prefix needed in Actions since nothing there goes into a browser bundle.)
   Also add `APPS_SCRIPT_IMAGE_BRIDGE_URL` / `APPS_SCRIPT_SHARED_SECRET` here once you've
   done the one-time setup below, if you want photo-detection to run in the scheduled sync
   too (optional — the sync works fine without it).

5. **Try a sync manually**: `npm run sync`. Check the `sync_runs` table in Supabase for
   the outcome, and `raw_orders` for row counts per `source_sheet`.

6. **Run the dashboard**: `npm run dev`, open http://localhost:3000.

## Adding a new month tab

Add one entry to the `MONTH_SHEETS` array in `scripts/sync-sheets.mjs` (title + gid). No
SQL migration needed — `raw_orders` is one table for every tab, discriminated by
`source_sheet`; a new tab just becomes a new `source_sheet` value on the next sync.

## Apps Script image bridge (optional)

Some measurement photos are pasted into the sheet as **floating images** (Insert > Image
> Insert image over cells), not as cell values or `=IMAGE()` formulas. Confirmed directly:
that kind of cell reads back 100% empty from the Sheets REST API — there is no way for
`scripts/sync-sheets.mjs` to see these on its own. `Sheet.getImages()` in Google Apps
Script *can* see them, so a small standalone Apps Script, deployed as a Web App, bridges
that gap. The sync job works fine without this — it just can't tell "a photo was pasted
here" from "genuinely nothing was provided" until it's set up.

One-time setup:

1. Go to [script.google.com](https://script.google.com) → **New project**. (Standalone —
   don't create it from inside the spreadsheet; no Editor access to the sheet is needed,
   only whatever access this account already has, which is at least Viewer.)
2. Delete the placeholder code and paste in the contents of `apps-script/image-bridge.gs`
   from this repo.
3. **Project Settings** (gear icon) → **Script Properties** → add one:
   `SHARED_SECRET` = the value already in your `.env.local` as
   `APPS_SCRIPT_SHARED_SECRET` (a random value was generated for you there — copy it
   verbatim, don't invent a new one, or the two ends won't match).
4. **Deploy** → **New deployment** → type **Web app** → Execute as **Me**, Who has access
   **Anyone**. Authorize the requested permissions (it only asks for spreadsheet *read*
   access). Copy the resulting web app URL.
5. Paste that URL into `.env.local` as `APPS_SCRIPT_IMAGE_BRIDGE_URL` (and as a GitHub
   Actions secret of the same name, if you want this in the scheduled sync too).
6. Re-run `npm run sync` — you should no longer see the "image bridge not configured" log
   line.

If you ever edit `image-bridge.gs`, you have to **create a new deployment version**
(Deploy → Manage deployments → edit → new version) for the change to take effect at the
existing URL — saving the file alone doesn't update a published Web App.

## Data pipeline

- `raw_orders` — physical table, one row per sheet row, written only by
  `scripts/sync-sheets.mjs` via full delete-and-reinsert per run (see that file's header
  comment for why, and `supabase/migrations/0001`).
- `stg_orders_filled` / `stg_orders_filtered` / `stg_orders_measurement` — views doing
  fill-forward, per-sheet row filtering, and measurement-status derivation
  (`supabase/migrations/0002`).
- `fact_orders` — materialized view, deduped to one row per order line
  (`supabase/migrations/0003`). Refreshed immediately after each sync via the
  `refresh_fact_orders()` RPC, and every 10 minutes by `pg_cron` as a backstop
  (`supabase/migrations/0004`, `0005`).
- The Next.js API route (`app/api/dashboard/route.ts`) reads `fact_orders` with the
  service-role key (server-only — never reaches the browser), applies the user's filters,
  and computes KPIs/chart aggregates/table rows in the route handler. `anon`/`authenticated`
  have no grants on `raw_orders` or `fact_orders` at all, so none of this is reachable
  directly from the browser.

## Known data-quality facts about the live sheet

Found by inspecting real data after the first sync (2026-08-04) — not guesses, and worth
knowing before "fixing" something that's actually working as designed:

- **There is no dispatch/operational-status *column* anywhere in the sheet** (all 10 tabs
  checked directly; the raw `order_status` field is always null — not a bug). The real
  signal is a **manual row background color** instead: the ops team highlights a whole
  order row red (cancelled) or green (dispatched); no fill means no update yet. This is
  authoritative and overrides the shipping-date guess whenever present — see the next
  section for how it's read and merged. `operational_status` in `lib/orders.ts`
  (`computeOperationalStatus`) falls back to a shipping-date-based guess (`Shipping Soon` /
  `In Progress` / `Delayed` / `Unknown`) only for orders with no color at all.
  **`Delayed`** (added 2026-08-05) means the ship date has passed and the row was never
  marked green — this used to fall back to `Dispatched` (an optimistic guess straight from
  the original build spec), corrected once it was clear staff only mark a row green once
  it's actually gone out, so an uncolored overdue row means it genuinely hasn't shipped,
  not that it probably has. Surfaced as its own "Delayed orders" table tab.

### The manual row-color status signal

Added 2026-08-04. Read carefully before changing anything here — the obvious
implementation (read column A, fill continuation rows down from their parent order) is
**not** what the code does, because real data ruled it out:

- **Order No / Order Date / Shipping Date / Customer Name cells are vertically merged**
  across a multi-line order in this sheet. Merged cells only report background color on
  their anchor (top-left) cell via the Sheets API, so a continuation row reads as
  uncolored in those specific columns even when the row genuinely is colored. Reading
  color from **Product Name onward** (`mapping.productName` in `scripts/sync-sheets.mjs`
  — the first non-merged, never-blank column) instead of column A avoids that trap
  entirely, for every tab, since each tab's column layout differs.
- Even so, **17 of 138 real multi-line orders had inconsistent colors across their own
  lines** when checked directly (`scripts/lib/color.mjs` classification, verified against
  live data before writing any aggregation logic) — always a `Dispatched` vs `No Update`
  mix on different lines of the same order, never a real `Cancelled` vs `Dispatched`
  conflict. A sequential "fill down from the previous row" approach would have been fragile
  against this. Instead, `sheet_status_color` is stored per raw row, and
  `stg_orders_measurement` (`supabase/migrations/0002`) aggregates it to one **order-level**
  `sheet_status` via `bool_or(... = 'Cancelled') / bool_or(... = 'Dispatched')` — the same
  pattern already used for `measurement_status` — with Cancelled taking precedence if
  somehow both appear on one order.
- Validated against the live sheet, not just "runs without errors": the 4 orders in April
  2026 that `fact_orders` reports as `Cancelled` (`#5572`, `#5582`, `#5611`, `#5612`) were
  independently confirmed as red rows by direct inspection first. `fact_orders`'s total row
  count (1291) is unchanged from before this feature — Total Orders must never be filtered
  by cancellation status; only the "Shipping in 5 days" and "Missing measurements" views
  exclude `Cancelled` orders (confirmed, deliberate — see `rowsForTab` and `computeKpis` in
  `lib/orders.ts`).
- **The dedicated Country cell is frequently blank, especially from April 2026 onward**
  (July and August tabs were ~100% blank before the fallback below). Country info still
  exists for most of those orders, just embedded in the free-text Address field instead.
  `scripts/lib/clean.mjs`'s `extractCountryFromAddress` recovers a lot of it via a
  whitelist-only match (never guesses from city/state names), bringing overall null-country
  down from 67% to ~19% of orders. Some will legitimately stay `null` — the ops team simply
  didn't record a country for every order.
  - `scripts/sync-sheets.mjs` uses `normalizeCountry(country cell) || extractCountryFromAddress(address cell)`
    — a country value from the address block is treated as a fallback, not an override.
- **Country values need normalization even when the dedicated cell is filled in**:
  "USA"/"US"/"United states"/"United States" and "INDIA"/"India" and "UK"/"United Kingdom"
  all appear in the raw data as separate strings for the same country. `normalizeCountry`
  in `scripts/lib/clean.mjs` canonicalizes known variants (same whitelist as the address
  fallback) and passes through anything not recognized rather than discarding it — a small
  long tail of typos/rare values (e.g. one-off city names mistakenly entered as country)
  will still show up unmerged; that's a deliberate "don't guess" tradeoff, not an oversight.
- **May 2026's order-number column header is corrupted in the live sheet** — the header
  cell contains a stray pasted product-link URL instead of the label "Order No". This
  broke a naive header-name lookup (it silently fell through to matching "Order Date"
  instead, since the generic synonym fallback included a bare `'order'` token — removed
  now). Fixed by matching column **position** (index 0) for that tab specifically, same as
  `June 2026 / EOSS`'s blank header. See `TAB_OVERRIDES` in `scripts/lib/sheet-columns.mjs`.
- **Fill-forward (order_no, customer_name, shipping_date across multi-line orders) applies
  to every sheet, not just the subset the original build spec named.** The spec scoped
  `customer_name` fill-forward to "Mehfill orders only" and `shipping_date` to "Mehfill
  orders, June 2026 / EOSS only" — but every one of the 10 tabs shows the identical
  continuation-row pattern (a blank `order_no` row is ~100% correlated with a blank
  `customer_name`/`shipping_date` row on that same tab). Applying it universally
  (`supabase/migrations/0002`) recovered real data: `July 2026` was silently losing every
  product line after the first on each multi-line order (its row filter requires
  `shipping_date is not null`, and continuation rows had a blank one before the fix).
  **Important nested bug found later (2026-08-05):** that fill-forward must be scoped
  *within* each order (`partition by source_sheet, order_grp, ...`), not just by
  `source_sheet` — a row can start its own new order (non-null `order_no`) while still
  having a blank `shipping_date`/`customer_name` for an unrelated reason (see the MMVM
  banner rows below), and without the `order_grp` boundary it would silently inherit a
  *different, unrelated* order's shipping date. Confirmed against real data: order #6025
  (July 2026) was inheriting order #6024's ship date before this fix.
  `order_date` and `country` were each missed from this same fill-forward set entirely
  (not scoped wrong, just absent) in two later passes — same merged-cell block, same fix.
  Confirmed via order #5988 (null `order_date` on its 2nd line) and order #5240 (its 1st
  line correctly showed "Oman", its 2nd/3rd lines showed no country at all). If a field
  from this block (Order No / Order Date / Shipping Date / Customer Name / Country) shows
  unexpected nulls again later, check whether it's in `stg_orders_filled`'s fill-forward
  list before assuming it's a new bug class — it's happened three times now.
- **"MMVM" is a sister product line (`shopmmvm.com`, not `mahimamahajan.in`) with its own
  tab, `MMVM 2026`** — added as an 11th entry in `MONTH_SHEETS` on 2026-08-05, 118+ real
  orders, previously never synced at all. The other tabs sometimes have a giant merged
  banner row that just says "MMVM" (April 2026 alone had 23 of these) — that's a
  cross-reference marker meaning "this order number belongs to the MMVM line, see that
  tab", not a real order in its host tab. Confirmed directly: order #6025 showed as such a
  banner in July 2026 while its real data (customer, product, measurements, amounts) lived
  in `MMVM 2026`.
- **Marker/banner rows (the MMVM cross-references above, plus month-name section-label
  rows like "MARCH"/"APRIL" within `MMVM 2026` itself) are dropped at ingestion**, not
  treated as broken/incomplete orders. The rule in `scripts/sync-sheets.mjs`: a row with
  *both* a blank product name and a blank customer name is not a real order line,
  regardless of what marker text sits in its order-number cell — a genuine order or
  continuation line always has at least one of those two filled in.
- **Some measurement photos are floating images the Sheets API cannot see as cell data at
  all** (confirmed: querying that cell returns completely empty — no value, no formula, no
  merge). This is a hard API limitation, not a classification bug. Optional fix: the
  [Apps Script image bridge](#apps-script-image-bridge-optional), which uses
  `Sheet.getImages()` (only available inside Apps Script) to detect them. Without it, a
  measurement provided *only* as a floating photo (no text in the cell) will show as
  "Missing" — e.g. order #5217 (Feb 2026) until the bridge is deployed and re-synced.

## Freshness

- `app/page.tsx` sets `export const revalidate = 90` — first paint is ISR-cached, refreshed
  at most every 90 seconds.
- The client (`components/dashboard/DashboardClient.tsx`) layers SWR on top: it refetches
  in the background every 90s and immediately whenever a filter changes.
- Supabase Realtime was deliberately **not** wired up. Realtime only fires on physical
  tables added to a publication — it cannot fire on a view or materialized view like
  `fact_orders`, so subscribing to it directly (as a literal reading of the original spec
  suggests) would connect successfully and then just never receive an event. Adding it
  properly would mean a small physical `sync_state` table touched at the end of each sync,
  with the browser treating any change on it as "refetch through the normal API" — worth
  doing if 90-second staleness ever becomes a real complaint, not before.

## GitHub Actions vs. Vercel Cron

The sync job runs on GitHub Actions (`.github/workflows/sync.yml`), not Vercel Cron.
Vercel's Hobby-tier cron is capped at once per day — any more frequent schedule fails at
deploy time — while GitHub Actions supports the 5–10 minute cadence this needs for free.
If this ever moves to a paid Vercel plan, Vercel Cron would be a reasonable place for
anything that only needs to run daily; it's not a fit for the sheet sync regardless of plan.

## Upgrade path: push-based ingestion

If someone with **Editor** access to the sheet is willing to do a 5-minute one-time setup,
they can install a container-bound Apps Script with an installable `onEdit` + `onChange`
trigger (this requires Editor access to create) calling the same Supabase tables directly,
with a 15-minute time-driven trigger as a backup. That replaces GitHub Actions polling with
near-instant push. Nothing else in this architecture (Postgres schema, RLS, Next.js) would
need to change.

## Supabase free-tier notes

- Projects auto-pause after 7 days with zero activity. The `pg_cron` job running every 10
  minutes counts as activity and should prevent this — worth spot-checking against current
  Supabase policy if the project ever sits idle for a stretch.
- `pg_cron` availability was confirmed working on this project at setup time
  (`supabase/migrations/0004`); if it's ever unavailable, enable the "pg_cron" extension
  from the Supabase dashboard under Database → Extensions and re-run that migration.
