'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ChartCard } from './ChartCard';
import { fmtDate, fmtMoney, fmtRelativeTime } from '@/lib/format';
import { estimatedStatusPillClass } from '@/lib/orders';
import type { DashboardResponse, TableTab } from '@/lib/orders';

type Mode = 'visuals' | 'tables';

const TABLE_TABS: { key: TableTab; label: string }[] = [
  { key: 'all', label: 'All orders' },
  { key: 'shipping5', label: 'Shipping in 5 days' },
  { key: 'missing', label: 'Missing measurements' },
  { key: 'balance', label: 'Balance due' },
];

const COLUMNS: { key: string; label: string }[] = [
  { key: 'order_no', label: 'Order no' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'country', label: 'Country' },
  { key: 'product_name', label: 'Product' },
  { key: 'sku', label: 'SKU' },
  { key: 'order_date', label: 'Order date' },
  { key: 'shipping_date', label: 'Ship date' },
  { key: 'estimated_status', label: 'Status (est.)' },
  { key: 'measurement_status', label: 'Measurement' },
  { key: 'total', label: 'Amount' },
  { key: 'balance', label: 'Balance due' },
];

async function fetcher(url: string): Promise<DashboardResponse> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || 'Request failed');
  return json.data;
}

export function DashboardClient({ initialData }: { initialData: DashboardResponse }) {
  const [mode, setMode] = useState<Mode>('visuals');
  const [tab, setTab] = useState<TableTab>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [country, setCountry] = useState('');
  const [opStatus, setOpStatus] = useState('');
  const [measStatus, setMeasStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (country) params.set('country', country);
    if (opStatus) params.set('opStatus', opStatus);
    if (measStatus) params.set('measStatus', measStatus);
    if (search) params.set('search', search);
    params.set('tab', tab);
    return params.toString();
  }, [from, to, country, opStatus, measStatus, search, tab]);

  const isDefaultQuery = queryString === 'tab=all';

  const { data, error, isLoading } = useSWR<DashboardResponse>(
    `/api/dashboard?${queryString}`,
    fetcher,
    {
      fallbackData: isDefaultQuery ? initialData : undefined,
      refreshInterval: 90_000,
      revalidateOnFocus: true,
    },
  );

  const view = data || initialData;

  const kpiCards = [
    { label: 'Total orders', value: view.kpis.totalOrders.toLocaleString('en-IN'), accent: 'var(--primary)' },
    { label: 'Shipped (estimated)', value: view.kpis.dispatchedOrders.toLocaleString('en-IN'), accent: 'var(--teal)' },
    { label: 'Shipping in 5 days', value: view.kpis.shippingIn5Days.toLocaleString('en-IN'), accent: 'var(--amber)' },
    { label: 'Missing measurements', value: view.kpis.missingMeasurements.toLocaleString('en-IN'), accent: 'var(--coral)' },
    { label: 'Measurement completion', value: `${view.kpis.measurementCompletionPct}%`, accent: 'var(--teal)' },
    { label: 'Total revenue', value: fmtMoney(view.kpis.totalRevenue), accent: 'var(--gold)' },
    { label: 'Balance due', value: fmtMoney(view.kpis.balanceDue), accent: 'var(--coral)' },
    { label: 'Countries served', value: view.kpis.countriesServed.toLocaleString('en-IN'), accent: 'var(--primary-light)' },
  ];

  const resetFilters = () => {
    setFrom('');
    setTo('');
    setCountry('');
    setOpStatus('');
    setMeasStatus('');
    setSearchInput('');
    setSearch('');
  };

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">MM</div>
          <div className="brand-text">
            <h1>Mahima Mahajan</h1>
            <p>Dispatch &amp; fulfilment studio — live order dashboard</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`sync-tag${error ? ' stale' : ''}`}>
            <i>&#9679;</i>
            {error ? 'Sync error — showing last good data' : `Synced ${fmtRelativeTime(view.meta.dataAsOf)}`}
          </span>
          <div className="toggle" role="group" aria-label="View switch">
            <button className={mode === 'visuals' ? 'active' : ''} onClick={() => setMode('visuals')}>
              Visuals
            </button>
            <button className={mode === 'tables' ? 'active' : ''} onClick={() => setMode('tables')}>
              Tables
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Couldn&apos;t refresh live data ({error.message}). Showing the last successfully loaded data.
        </div>
      )}

      <div className="filters">
        <div className="field">
          <label>From date</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>To date</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label>Country</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">All countries</option>
            {view.filterOptions.countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label title="Estimated from ship date vs today -- not a confirmed dispatch signal">
            Shipping status (est.)
          </label>
          <select value={opStatus} onChange={(e) => setOpStatus(e.target.value)}>
            <option value="">All statuses</option>
            {view.filterOptions.opStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Measurement status</label>
          <select value={measStatus} onChange={(e) => setMeasStatus(e.target.value)}>
            <option value="">All</option>
            {view.filterOptions.measStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={resetFilters}>
          Reset filters
        </button>
      </div>

      <div className="kpi-grid">
        {kpiCards.map((c) => (
          <div className="kpi-card" key={c.label} style={{ ['--accent' as string]: c.accent }}>
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value">{c.value}</div>
          </div>
        ))}
      </div>

      {mode === 'visuals' ? (
        <div>
          <h2 className="section-title">Visual analysis</h2>
          <div className="visuals-grid">
            <ChartCard title="Orders by shipping status (estimated)" kind="bar-h" labels={view.charts.ordersByStatus.labels} data={view.charts.ordersByStatus.data} colors={undefined} />
            <ChartCard title="Balance due vs collected" kind="doughnut" labels={view.charts.balanceVsCollected.labels} data={view.charts.balanceVsCollected.data} colors={['#1E9E7C', '#D6483F']} valueFormat="currency" />
            <ChartCard title="Measurement status breakdown" kind="doughnut" labels={view.charts.measurementBreakdown.labels} data={view.charts.measurementBreakdown.data} />
            <ChartCard title="Top products" kind="bar-h" labels={view.charts.topProducts.labels} data={view.charts.topProducts.data} color="#4B2E83" />
            <ChartCard title="Monthly order volume" kind="line" labels={view.charts.monthlyOrders.labels} data={view.charts.monthlyOrders.data} color="#4B2E83" />
            <ChartCard title="Monthly revenue" kind="bar-v" labels={view.charts.monthlyRevenue.labels} data={view.charts.monthlyRevenue.data} color="#C6922E" valueFormat="currency" />
            <ChartCard title="Orders by country" kind="bar-h" labels={view.charts.ordersByCountry.labels} data={view.charts.ordersByCountry.data} color="#8567C4" />
            <ChartCard title="Revenue by country" kind="bar-h" labels={view.charts.revenueByCountry.labels} data={view.charts.revenueByCountry.data} color="#1E9E7C" valueFormat="currency" />
          </div>
        </div>
      ) : (
        <div>
          <h2 className="section-title">Order tables</h2>
          <div className="table-card">
            <div className="tab-bar">
              {TABLE_TABS.map((t) => (
                <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="table-toolbar">
              <input
                type="text"
                placeholder="Search customer, order no, product…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, minWidth: 240, background: 'var(--surface-alt)' }}
              />
              <span className="table-count">
                {isLoading ? 'Loading…' : `Showing ${view.table.count} of ${view.table.filteredTotal} orders`}
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.table.rows.map((r, i) => (
                    <tr key={`${r.order_no}-${i}`}>
                      <td>{r.order_no || '—'}</td>
                      <td>{r.customer_name || '—'}</td>
                      <td>{r.country || '—'}</td>
                      <td>{r.product_name || '—'}</td>
                      <td>{r.sku || '—'}</td>
                      <td>{fmtDate(r.order_date)}</td>
                      <td>{fmtDate(r.shipping_date)}</td>
                      <td>
                        <span className={`pill ${estimatedStatusPillClass(r.estimated_status)}`}>
                          {r.estimated_status}
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${r.measurement_status === 'Received' ? 'good' : 'bad'}`}>
                          {r.measurement_status || '—'}
                        </span>
                      </td>
                      <td>{fmtMoney(r.total)}</td>
                      <td>{r.balance > 0 ? fmtMoney(r.balance) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.table.rows.length === 0 && <div className="empty-state">No matching orders</div>}
            </div>
          </div>
        </div>
      )}

      <footer>Live from Google Sheets via Supabase · built for the Dispatch Dashboard</footer>
    </div>
  );
}
