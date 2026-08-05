'use client';

import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Legend,
  Tooltip,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { fmtMoney } from '@/lib/format';

ChartJS.register(
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Filler,
  Legend,
  Tooltip,
);

const PALETTE = ['#4B2E83', '#C6922E', '#1E9E7C', '#8567C4', '#E0972A', '#D6483F', '#6B6280', '#341F5C'];

type ChartKind = 'bar-h' | 'bar-v' | 'doughnut' | 'line';

export function ChartCard({
  title,
  kind,
  labels,
  data,
  color,
  colors,
  valueFormat = 'number',
  wide = false,
}: {
  title: string;
  kind: ChartKind;
  labels: string[];
  data: number[];
  color?: string;
  colors?: string[];
  valueFormat?: 'number' | 'currency';
  wide?: boolean;
}) {
  const formatValue = (v: number) => (valueFormat === 'currency' ? fmtMoney(v) : v.toLocaleString('en-IN'));

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: kind === 'doughnut', labels: { font: { family: 'Manrope' } } },
      tooltip: {
        callbacks: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          label: (ctx: any) => {
            const parsed = ctx.parsed;
            // Doughnut: parsed is a plain number. Otherwise the real value sits on
            // whichever axis is the *value* axis, not the category axis -- for a
            // horizontal bar (indexAxis 'y') that's parsed.x; for a vertical bar/line
            // (indexAxis 'x', the default) that's parsed.y. Using "x ?? y" here previously
            // always grabbed parsed.x first, which for vertical charts is just the
            // category's array index (0, 1, 2...), not the data value -- e.g. hovering
            // "Jun 26" (the 6th month, index 5) showed "5" instead of the real count.
            const raw = typeof parsed === 'number' ? parsed : kind === 'bar-h' ? parsed.x : parsed.y;
            return `${ctx.label ? ctx.label + ': ' : ''}${formatValue(raw)}`;
          },
        },
      },
    },
  };

  let content: React.ReactNode;
  if (labels.length === 0) {
    content = <div className="empty-state">No matching orders</div>;
  } else if (kind === 'doughnut') {
    content = (
      <Doughnut
        data={{ labels, datasets: [{ data, backgroundColor: colors || PALETTE }] }}
        options={baseOptions}
      />
    );
  } else if (kind === 'line') {
    content = (
      <Line
        data={{
          labels,
          datasets: [
            {
              data,
              borderColor: color || PALETTE[0],
              backgroundColor: 'rgba(75,46,131,0.12)',
              fill: true,
              tension: 0.35,
            },
          ],
        }}
        options={{ ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: false } } }}
      />
    );
  } else {
    const isHorizontal = kind === 'bar-h';
    content = (
      <Bar
        data={{
          labels,
          datasets: [{ data, backgroundColor: colors || color || PALETTE[0] }],
        }}
        options={{
          ...baseOptions,
          indexAxis: isHorizontal ? ('y' as const) : ('x' as const),
          plugins: { ...baseOptions.plugins, legend: { display: false } },
        }}
      />
    );
  }

  return (
    <div className={`chart-card${wide ? ' wide' : ''}`}>
      <h3>{title}</h3>
      <div className="chart-box">{content}</div>
    </div>
  );
}
