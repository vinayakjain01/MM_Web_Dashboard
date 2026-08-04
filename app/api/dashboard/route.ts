import { NextRequest, NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/dashboard-data';
import type { TableTab } from '@/lib/orders';

const VALID_TABS: TableTab[] = ['all', 'shipping5', 'missing', 'balance'];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tabParam = params.get('tab') || 'all';
  const tab = (VALID_TABS.includes(tabParam as TableTab) ? tabParam : 'all') as TableTab;

  try {
    const data = await getDashboardData(
      {
        from: params.get('from') || undefined,
        to: params.get('to') || undefined,
        country: params.get('country') || undefined,
        opStatus: params.get('opStatus') || undefined,
        measStatus: params.get('measStatus') || undefined,
        search: params.get('search') || undefined,
      },
      tab,
    );
    return NextResponse.json({ data, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ data: null, error: message }, { status: 500 });
  }
}
