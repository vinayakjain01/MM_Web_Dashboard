import { daysBetween, kolkataToday } from './kolkata';

export type OrderRow = {
  order_no: string | null;
  customer_name: string | null;
  country: string | null;
  product_name: string | null;
  sku: string | null;
  order_date: string | null; // ISO date
  shipping_date: string | null; // ISO date
  order_status: string | null; // always null in the live sheet -- no such column exists
  sheet_status: 'Cancelled' | 'Dispatched' | 'No Update'; // manual row-color signal, order-level aggregated in SQL
  measurement_status: string | null; // 'Received' | 'Missing'
  size_measurements: string | null;
  source_sheet: string | null;
  payment_mode: string | null;
  order_amount_mrp: number;
  shipping_charges: number;
  customization_charges: number;
  discount: number;
  total: number;
  payment_received: number;
  balance: number;
};

// The manually-applied row color (red = cancelled, green = dispatched) is real,
// authoritative signal -- it overrides the shipping-date guess whenever present. The
// date-based guess is used only as a fallback for orders with no color at all ('No
// Update'), since the sheet has no other dispatch/status column (confirmed by inspecting
// every tab's headers directly).
export type OperationalStatus = 'Cancelled' | 'Dispatched' | 'Shipping Soon' | 'In Progress' | 'Unknown';
export const OPERATIONAL_STATUSES: OperationalStatus[] = [
  'Cancelled',
  'Dispatched',
  'Shipping Soon',
  'In Progress',
  'Unknown',
];

export type EnrichedOrderRow = OrderRow & { operational_status: OperationalStatus };

export function computeOperationalStatus(
  sheetStatus: OrderRow['sheet_status'],
  shippingDate: string | null,
  today: string,
): OperationalStatus {
  if (sheetStatus === 'Cancelled') return 'Cancelled';
  if (sheetStatus === 'Dispatched') return 'Dispatched';
  // No color signal at all for this order -- fall back to a guess from shipping_date.
  if (!shippingDate) return 'Unknown';
  const d = daysBetween(today, shippingDate);
  if (d < 0) return 'Dispatched';
  if (d <= 5) return 'Shipping Soon';
  return 'In Progress';
}

// Enrichment must happen server-side, once per request, using the business ("Asia/Kolkata")
// clock -- never recomputed client-side, where "today" would mean the visitor's own
// timezone. See lib/kolkata.ts.
export function enrichRows(rows: OrderRow[], today = kolkataToday()): EnrichedOrderRow[] {
  return rows.map((r) => ({
    ...r,
    operational_status: computeOperationalStatus(r.sheet_status, r.shipping_date, today),
  }));
}

export type OrderFilters = {
  from?: string;
  to?: string;
  country?: string;
  opStatus?: string;
  measStatus?: string;
  search?: string;
};

export function isMeasurementComplete(r: OrderRow): boolean {
  return r.measurement_status === 'Received';
}

export function isCancelled(r: EnrichedOrderRow): boolean {
  return r.operational_status === 'Cancelled';
}

export function operationalStatusPillClass(status: OperationalStatus): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'Dispatched') return 'good';
  if (status === 'Shipping Soon') return 'warn';
  if (status === 'Cancelled' || status === 'Unknown') return 'bad';
  return 'neutral'; // In Progress
}

function groupCount(rows: EnrichedOrderRow[], key: (r: EnrichedOrderRow) => string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) || 'Unspecified';
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

function groupSum(
  rows: EnrichedOrderRow[],
  key: (r: EnrichedOrderRow) => string,
  val: (r: EnrichedOrderRow) => number,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) || 'Unspecified';
    map[k] = (map[k] || 0) + val(r);
  }
  return map;
}

function topEntries(map: Record<string, number>, n: number): [string, number][] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function monthKey(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export function applyFilters(rows: EnrichedOrderRow[], f: OrderFilters): EnrichedOrderRow[] {
  const search = (f.search || '').toLowerCase().trim();
  return rows.filter((r) => {
    if (f.from && r.order_date && r.order_date < f.from) return false;
    if (f.to && r.order_date && r.order_date > f.to) return false;
    if (f.country && r.country !== f.country) return false;
    if (f.opStatus && r.operational_status !== f.opStatus) return false;
    if (f.measStatus && r.measurement_status !== f.measStatus) return false;
    if (search) {
      const hay = `${r.customer_name || ''} ${r.order_no || ''} ${r.product_name || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export function computeKpis(rows: EnrichedOrderRow[]) {
  // Total Orders counts every order, cancelled included -- never filter this one.
  const total = rows.length;
  const cancelled = rows.filter(isCancelled).length;
  const dispatched = rows.filter((r) => r.operational_status === 'Dispatched').length;
  const shippingSoon = rows.filter((r) => r.operational_status === 'Shipping Soon').length;

  // Missing-measurements and its completion % exclude cancelled orders -- a cancelled
  // order's measurements are no longer operationally relevant, and this must match the
  // "Missing measurements" table tab's own count (see rowsForTab).
  const active = rows.filter((r) => !isCancelled(r));
  const missingMeasurements = active.filter((r) => !isMeasurementComplete(r)).length;
  const completionPct = active.length
    ? Math.round(((active.length - missingMeasurements) / active.length) * 100)
    : 0;

  const revenue = rows.reduce((s, r) => s + r.total, 0);
  const balanceDue = rows.reduce((s, r) => s + r.balance, 0);
  const countries = new Set(rows.map((r) => r.country).filter(Boolean)).size;

  return {
    totalOrders: total,
    cancelledOrders: cancelled,
    dispatchedOrders: dispatched,
    shippingIn5Days: shippingSoon,
    missingMeasurements,
    measurementCompletionPct: completionPct,
    totalRevenue: revenue,
    balanceDue,
    countriesServed: countries,
  };
}

export function computeCharts(rows: EnrichedOrderRow[]) {
  const statusCounts = groupCount(rows, (r) => r.operational_status);

  const revenue = rows.reduce((s, r) => s + r.total, 0);
  const balance = rows.reduce((s, r) => s + r.balance, 0);
  const collected = Math.max(revenue - balance, 0);

  const measurementCounts = groupCount(rows, (r) => r.measurement_status || '');

  const topProducts = topEntries(
    groupCount(rows, (r) => r.product_name || ''),
    8,
  );

  const monthlyOrdersMap: Record<string, number> = {};
  const monthlyRevenueMap: Record<string, number> = {};
  for (const r of rows) {
    if (!r.order_date) continue;
    const k = monthKey(r.order_date);
    monthlyOrdersMap[k] = (monthlyOrdersMap[k] || 0) + 1;
    monthlyRevenueMap[k] = (monthlyRevenueMap[k] || 0) + r.total;
  }
  const monthKeys = Object.keys(monthlyOrdersMap).sort();

  const countryOrders = topEntries(
    groupCount(rows, (r) => r.country || ''),
    8,
  );
  const countryRevenue = topEntries(
    groupSum(
      rows,
      (r) => r.country || '',
      (r) => r.total,
    ),
    8,
  );

  return {
    ordersByStatus: { labels: Object.keys(statusCounts), data: Object.values(statusCounts) },
    balanceVsCollected: { labels: ['Collected', 'Balance due'], data: [collected, balance] },
    measurementBreakdown: {
      labels: Object.keys(measurementCounts),
      data: Object.values(measurementCounts),
    },
    topProducts: { labels: topProducts.map((e) => e[0]), data: topProducts.map((e) => e[1]) },
    monthlyOrders: { labels: monthKeys.map(monthLabel), data: monthKeys.map((k) => monthlyOrdersMap[k]) },
    monthlyRevenue: {
      labels: monthKeys.map(monthLabel),
      data: monthKeys.map((k) => monthlyRevenueMap[k]),
    },
    ordersByCountry: { labels: countryOrders.map((e) => e[0]), data: countryOrders.map((e) => e[1]) },
    revenueByCountry: {
      labels: countryRevenue.map((e) => e[0]),
      data: countryRevenue.map((e) => e[1]),
    },
  };
}

export type TableTab = 'all' | 'shipping5' | 'missing' | 'balance';

export function rowsForTab(rows: EnrichedOrderRow[], tab: TableTab): EnrichedOrderRow[] {
  // 'all' and 'balance' intentionally do NOT exclude cancelled orders -- only the two
  // views below do, matching an explicit, confirmed decision (not a default guess).
  if (tab === 'shipping5') return rows.filter((r) => r.operational_status === 'Shipping Soon');
  if (tab === 'missing') return rows.filter((r) => !isMeasurementComplete(r) && !isCancelled(r));
  if (tab === 'balance') return rows.filter((r) => r.balance > 0);
  return rows;
}

export function filterOptions(rows: EnrichedOrderRow[]) {
  return {
    countries: Array.from(new Set(rows.map((r) => r.country).filter(Boolean))).sort() as string[],
    opStatuses: OPERATIONAL_STATUSES,
    measStatuses: Array.from(
      new Set(rows.map((r) => r.measurement_status).filter(Boolean)),
    ).sort() as string[],
  };
}

// Shared with lib/dashboard-data.ts (server-only). Kept in this client-safe module so
// components can import the type without pulling in the `server-only` guard.
export type DashboardResponse = {
  kpis: ReturnType<typeof computeKpis>;
  charts: ReturnType<typeof computeCharts>;
  filterOptions: ReturnType<typeof filterOptions>;
  table: {
    tab: TableTab;
    rows: EnrichedOrderRow[];
    count: number;
    filteredTotal: number;
  };
  meta: {
    dataAsOf: string;
    appliedFilters: OrderFilters;
    totalOrdersUnfiltered: number;
  };
};
