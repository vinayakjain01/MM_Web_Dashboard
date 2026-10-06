// Pulls every configured tab from the Google Sheet, lightly cleans each row, and does a
// full-refresh replace of the `raw_orders` table in Supabase. Run manually with
// `npm run sync`, or on a schedule via .github/workflows/sync.yml.
//
// Why full refresh and not incremental upsert: rows deleted in the sheet must disappear
// here too, and a batch that fails partway must never leave raw_orders holding a mixture
// of old and new data. At a few thousand rows total, truncate + reinsert costs nothing
// and is trivially correct; see claude_code_prompt_supabase.md section 3.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { detectMapping, findHeaderRowIndex, resolveOrderNoColumnIndex } from './lib/sheet-columns.mjs';
import {
  cleanOrderNo,
  cleanText,
  cleanSizeMeasurements,
  extractCountryFromAddress,
  normalizeCountry,
  parseAmount,
  parseSheetDate,
} from './lib/clean.mjs';
import { classifyRowColor } from './lib/color.mjs';
import { fetchImageAnchorsByTab, hasImageNear, isImageBridgeConfigured } from './lib/image-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

// New month tabs are added here -- and nowhere else. No SQL migration needed; a fresh
// tab just starts showing up as a new `source_sheet` value in raw_orders.
export const MONTH_SHEETS = [
  { title: 'Mehfill orders', gid: 511481291 },
  { title: 'EOSS 26', gid: 2015662649 },
  { title: 'Jan 2026', gid: 1741516118 },
  { title: 'Feb 2026', gid: 289962841 },
  { title: 'MARCH 2026', gid: 1662273297 },
  { title: 'April 2026', gid: 34623728 },
  { title: 'May 2026', gid: 2071087076 },
  { title: 'June 2026 / EOSS', gid: 1789133391 },
  { title: 'July 2026', gid: 1617166096 },
  { title: 'August 2026', gid: 1628602740 },
  // Sister product line (shopmmvm.com, not mahimamahajan.in) with its own order-number
  // sequence, some of it shared with the main brand's. Its own tab, not previously
  // synced. Rows in the OTHER tabs that just say "MMVM" in a giant merged banner are
  // cross-reference markers pointing here, not real orders in their host tab -- those get
  // dropped at ingestion (see the marker-row check below), not counted as broken orders.
  { title: 'MMVM 2026', gid: 1352270413 },
  { title: 'September 2026', gid: 246069390 },
  // Sheet's own tab title has a typo ("Ocotber" not "October") -- use it verbatim, not
  // the corrected spelling, or the exact-title match fails and this falls back to the
  // gid-match warning path for no reason.
  { title: 'Ocotber2026', gid: 1291508831 },
];

const NUMERIC_FIELDS = {
  orderAmountMrp: 'order_amount_mrp',
  shippingCharges: 'shipping_charges',
  customizationCharges: 'customization_charges',
  discount: 'discount',
  total: 'total',
  paymentReceived: 'payment_received',
  balance: 'balance',
};

function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function isRowBlank(row) {
  return !row || row.every((cell) => cell === undefined || cell === null || String(cell).trim() === '');
}

async function getSheetsClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

async function resolveTabTitles(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const actual = meta.data.sheets.map((s) => s.properties);
  const byTitle = new Map(actual.map((p) => [p.title, p]));
  const byGid = new Map(actual.map((p) => [p.sheetId, p]));

  return MONTH_SHEETS.map((configured) => {
    if (byTitle.has(configured.title)) return { ...configured, resolvedTitle: configured.title };
    const byGidMatch = byGid.get(configured.gid);
    if (byGidMatch) {
      console.warn(
        `[sync] tab "${configured.title}" not found by name; matched by gid ${configured.gid} -> "${byGidMatch.title}"`,
      );
      return { ...configured, resolvedTitle: byGidMatch.title };
    }
    console.warn(`[sync] tab "${configured.title}" (gid ${configured.gid}) not found by name or gid -- skipping`);
    return null;
  }).filter(Boolean);
}

// The manual row-highlight (red = cancelled, green = dispatched) is a *format*, not a
// value -- values.batchGet never returns it, so this needs a separate spreadsheets.get
// call with an explicit field mask. One call covers every tab (multiple `ranges`, one per
// sheet); matched back up by title via `sheets.properties.title` in the response, since
// the API doesn't promise the returned sheet order matches the ranges' order.
async function fetchRowColorsByTab(sheets, spreadsheetId, tabs) {
  const ranges = tabs.map((t) => `${quoteSheetName(t.resolvedTitle)}!A1:Z2000`);
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges,
    fields: 'sheets.properties.title,sheets.data.rowData.values.userEnteredFormat.backgroundColor',
  });
  const byTitle = new Map();
  for (const sheet of data.sheets || []) {
    byTitle.set(sheet.properties.title, sheet.data?.[0]?.rowData || []);
  }
  return byTitle;
}

function mapTabRows(tabTitle, values, colorRowData, imageAnchors) {
  if (!values || values.length === 0) return [];
  const headerIdx = findHeaderRowIndex(values);
  const headers = values[headerIdx] || [];
  const mapping = detectMapping(headers);
  const orderNoIdx = resolveOrderNoColumnIndex(tabTitle, headers);
  const sizeMeasurementsColumn1Indexed = mapping.sizeMeasurements + 1; // Sheets rows/cols are 1-indexed

  // Order No / Order Date / Shipping Date / Customer Name cells are vertically merged
  // across a multi-line order in this sheet (confirmed empirically: continuation rows
  // consistently show no background color in those columns specifically, even though the
  // row genuinely is colored). Product Name is the first column after that merged block,
  // never merged, never blank -- reading color there instead of column A is what makes
  // this reliable per-row. See README "Known data-quality facts".
  const colorColumnIdx = mapping.productName;
  if (colorColumnIdx === -1) {
    console.warn(`[sync] "${tabTitle}": no Product Name column found -- cannot read row color, defaulting to "No Update"`);
  }

  const get = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] : null);

  const rows = [];
  let sourceRowNumber = 0;
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i];
    if (isRowBlank(row)) continue;

    const productName = cleanText(get(row, mapping.productName));
    const customerName = cleanText(get(row, mapping.customerName));
    // Not a real order line: a cross-reference banner to another product line/tab (e.g.
    // "MMVM", a giant merged cell spanning most of the row) or a month-name section-label
    // row within a tab (e.g. "MARCH", "APRIL" in MMVM 2026) both have SOME cell filled
    // (often the order-no column) but no actual customer or product -- confirmed by
    // direct inspection, not a guess. A genuine order/continuation line always has at
    // least one of these. See README "Known data-quality facts".
    if (!productName && !customerName) continue;

    sourceRowNumber += 1;

    const record = {
      source_sheet: tabTitle,
      source_row_number: sourceRowNumber,
      order_no: cleanOrderNo(get(row, orderNoIdx)),
      customer_name: customerName,
      // Dedicated Country cell wins when present (normalized -- it's entered
      // inconsistently: "USA"/"US"/"United states"/"INDIA"/"UK" all mean one thing each);
      // otherwise best-effort extraction from the Address block (the ops team stopped
      // filling Country in on later tabs -- see extractCountryFromAddress for what this
      // can and can't recover).
      country: normalizeCountry(get(row, mapping.country)) || extractCountryFromAddress(get(row, mapping.address)),
      product_name: productName,
      sku: cleanText(get(row, mapping.sku)),
      order_date: parseSheetDate(get(row, mapping.orderDate)),
      shipping_date: parseSheetDate(get(row, mapping.shippingDate)),
      order_status: cleanText(get(row, mapping.orderStatus)),
      size_measurements: (() => {
        const text = cleanSizeMeasurements(get(row, mapping.sizeMeasurements));
        if (text) return text;
        // Text cell is blank -- could still be a floating photo of handwritten
        // measurements, which the Sheets API can't see as a cell value at all (see
        // apps-script/image-bridge.gs). Only checked when the bridge is configured.
        const sheetRow1Indexed = i + 1;
        if (imageAnchors && hasImageNear(imageAnchors, sheetRow1Indexed, sizeMeasurementsColumn1Indexed)) {
          return 'photo';
        }
        return text;
      })(),
      payment_mode: cleanText(get(row, mapping.paymentMode)),
      sheet_status_color:
        colorColumnIdx === -1
          ? 'No Update'
          : classifyRowColor(colorRowData?.[i]?.values?.[colorColumnIdx]?.userEnteredFormat?.backgroundColor),
    };
    for (const [field, column] of Object.entries(NUMERIC_FIELDS)) {
      record[column] = parseAmount(get(row, mapping[field]));
    }
    rows.push(record);
  }

  console.log(`[sync] ${tabTitle}: header row ${headerIdx}, ${rows.length} data rows`);
  return rows;
}

async function replaceRawOrders(supabase, allRows) {
  const { error: deleteError } = await supabase.from('raw_orders').delete().gt('id', 0);
  if (deleteError) throw new Error(`delete failed: ${deleteError.message}`);

  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const { error } = await supabase.from('raw_orders').insert(chunk);
    if (error) throw new Error(`insert failed at offset ${i}: ${error.message}`);
  }
}

async function main() {
  const spreadsheetId = process.env.SHEET_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHEET_SPREADSHEET_ID is not set.');
  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('GOOGLE_OAUTH_REFRESH_TOKEN is not set. Run `npm run auth` once to generate it.');
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });

  const { data: runRow, error: runError } = await supabase
    .from('sync_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runError) throw new Error(`could not create sync_runs row: ${runError.message}`);

  try {
    const sheets = await getSheetsClient();
    const tabs = await resolveTabTitles(sheets, spreadsheetId);

    if (!isImageBridgeConfigured()) {
      console.log('[sync] Apps Script image bridge not configured -- skipping floating-photo measurement detection.');
    }

    const ranges = tabs.map((t) => `${quoteSheetName(t.resolvedTitle)}!A1:AZ2000`);
    const [{ data: batch }, colorsByTab, imageAnchorsByTab] = await Promise.all([
      sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
      fetchRowColorsByTab(sheets, spreadsheetId, tabs),
      fetchImageAnchorsByTab(
        spreadsheetId,
        tabs.map((t) => t.resolvedTitle),
      ),
    ]);

    const allRows = [];
    tabs.forEach((tab, i) => {
      const values = batch.valueRanges[i]?.values || [];
      const colorRowData = colorsByTab.get(tab.resolvedTitle) || [];
      const imageAnchors = imageAnchorsByTab[tab.resolvedTitle] || [];
      allRows.push(...mapTabRows(tab.title, values, colorRowData, imageAnchors));
    });

    console.log(`[sync] total rows across ${tabs.length} tabs: ${allRows.length}`);
    await replaceRawOrders(supabase, allRows);

    const { error: refreshError } = await supabase.rpc('refresh_fact_orders');
    if (refreshError) console.warn(`[sync] fact_orders refresh failed (pg_cron will retry): ${refreshError.message}`);

    await supabase
      .from('sync_runs')
      .update({ status: 'success', rows_ingested: allRows.length, finished_at: new Date().toISOString() })
      .eq('id', runRow.id);

    console.log('[sync] done.');
  } catch (err) {
    await supabase
      .from('sync_runs')
      .update({ status: 'error', error_message: String(err.message || err), finished_at: new Date().toISOString() })
      .eq('id', runRow.id);
    throw err;
  }
}

main().catch((err) => {
  console.error('[sync] FAILED:', err);
  process.exit(1);
});
