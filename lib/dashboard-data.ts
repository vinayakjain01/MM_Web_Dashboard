import 'server-only';
import { getSupabaseServerClient } from './supabase/server';
import {
  applyFilters,
  computeCharts,
  computeKpis,
  enrichRows,
  filterOptions,
  rowsForTab,
  type DashboardResponse,
  type OrderFilters,
  type OrderRow,
  type TableTab,
} from './orders';
import { kolkataToday } from './kolkata';

const SELECT_COLUMNS =
  'order_no, customer_name, country, product_name, sku, order_date, shipping_date, ' +
  'order_status, measurement_status, size_measurements, source_sheet, payment_mode, ' +
  'order_amount_mrp, shipping_charges, customization_charges, discount, total, payment_received, balance';

const PAGE_SIZE = 1000;

// fact_orders is a materialized view with no RLS of its own (materialized views can't
// have RLS -- see supabase/migrations/0003). This service-role client is the only
// consumer, and it's never imported into a client component (enforced by `server-only`).
async function fetchAllFactOrders(): Promise<OrderRow[]> {
  const supabase = getSupabaseServerClient();
  const rows: OrderRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('fact_orders')
      .select(SELECT_COLUMNS)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`fact_orders query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    rows.push(...(data as unknown as OrderRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

export async function getDashboardData(filters: OrderFilters, tab: TableTab): Promise<DashboardResponse> {
  const rawRows = await fetchAllFactOrders();
  // One "today" for the whole request so every row's estimated_status is consistent,
  // computed in Asia/Kolkata regardless of server or visitor timezone.
  const allRows = enrichRows(rawRows, kolkataToday());
  const filtered = applyFilters(allRows, filters);
  const tableRows = rowsForTab(filtered, tab);

  return {
    kpis: computeKpis(filtered),
    charts: computeCharts(filtered),
    filterOptions: filterOptions(allRows),
    table: {
      tab,
      rows: tableRows,
      count: tableRows.length,
      filteredTotal: filtered.length,
    },
    meta: {
      dataAsOf: new Date().toISOString(),
      appliedFilters: filters,
      totalOrdersUnfiltered: allRows.length,
    },
  };
}
