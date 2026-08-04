// Light structural cleaning only -- business logic (fill-forward, filters, measurement
// derivation) lives in the Postgres views (supabase/migrations/0002+), not here. This is
// deliberately permissive: real sheet data has typos, so every parser degrades to
// null/0 rather than throwing.

export function cleanOrderNo(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).replace(/EOSS/gi, '').replace(/#/g, '').trim();
  return s === '' ? null : s;
}

export function cleanText(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

export function cleanSizeMeasurements(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (/=?image\(/i.test(s)) return 'photo';
  return s;
}

// Sheet dates are day-first (DD/MM/YYYY or DD.MM.YYYY); '.' is normalized to '/' first.
// Returns an ISO 'YYYY-MM-DD' string, or null if unparseable -- never throws.
export function parseSheetDate(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().replace(/\./g, '/');
  if (s === '') return null;

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  let year = +m[3];
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null; // rolled over (e.g. 31/02) -> invalid date
  }
  return d.toISOString().slice(0, 10);
}

// Strips Indian-style comma grouping and trailing noise ("37500   Cleared" -> 37500),
// defaults to 0 on failure -- amounts must never throw the whole row out.
export function parseAmount(raw) {
  if (raw === undefined || raw === null) return 0;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const m = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return isNaN(n) ? 0 : n;
}

// Fallback for when the dedicated Country cell is blank (common on the sheet from ~April
// 2026 onward -- the ops team stopped filling it in, relying on the free-text Address
// field instead). Only ever returns a value on an exact, whitelisted match; deliberately
// does NOT guess from city/state names, to avoid a wrong-but-plausible-looking country
// (e.g. "Georgia" the US state vs. the country) ending up in a business metric.
const COUNTRY_ALIASES = {
  india: 'India',
  'united states': 'United States',
  'united states of america': 'United States',
  usa: 'United States',
  us: 'United States',
  'united kingdom': 'United Kingdom',
  uk: 'United Kingdom',
  'united arab emirates': 'United Arab Emirates',
  uae: 'United Arab Emirates',
  canada: 'Canada',
  australia: 'Australia',
  austrailia: 'Australia', // common misspelling in the sheet
  aus: 'Australia',
  dubai: 'United Arab Emirates', // unambiguous -- Dubai is an emirate, not its own country
  singapore: 'Singapore',
  qatar: 'Qatar',
  'saudi arabia': 'Saudi Arabia',
  ksa: 'Saudi Arabia',
  bangladesh: 'Bangladesh',
  pakistan: 'Pakistan',
  kuwait: 'Kuwait',
  bahrain: 'Bahrain',
  oman: 'Oman',
  nepal: 'Nepal',
  'sri lanka': 'Sri Lanka',
  malaysia: 'Malaysia',
  'new zealand': 'New Zealand',
  germany: 'Germany',
  france: 'France',
  italy: 'Italy',
  spain: 'Spain',
  netherlands: 'Netherlands',
  switzerland: 'Switzerland',
  'south africa': 'South Africa',
  kenya: 'Kenya',
  nigeria: 'Nigeria',
};

function countryAliasLookup(s) {
  const key = s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  return COUNTRY_ALIASES[key] || null;
}

// The dedicated Country cell, when present, is entered inconsistently ("USA", "US",
// "United states", "INDIA", "UK", ...). Canonicalize known variants so the country charts
// don't fragment into duplicates of the same country; anything not on the whitelist is
// passed through as-is (trimmed) rather than discarded, since it may still be a genuine,
// just less-common, country name.
export function normalizeCountry(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  return countryAliasLookup(trimmed) || trimmed;
}

function looksLikePhoneNumber(s) {
  const digitsOnly = s.replace(/[\s()+\-.]/g, '');
  return digitsOnly.length >= 6 && /^\d+$/.test(digitsOnly);
}

export function extractCountryFromAddress(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\r\n/g, '\n');
  let lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // A single flat line is often comma-separated ("Name, Street, City, Country, Phone")
  // rather than newline-separated -- try splitting that instead.
  if (lines.length <= 1) {
    const commaParts = text
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (commaParts.length > 1) lines = commaParts;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (looksLikePhoneNumber(line)) continue;
    const match = countryAliasLookup(line);
    if (match) return match;
  }
  return null;
}
