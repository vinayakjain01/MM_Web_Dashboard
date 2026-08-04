import { DashboardClient } from '@/components/dashboard/DashboardClient';
import { getDashboardData } from '@/lib/dashboard-data';

// ISR: first paint is served from a cached render refreshed at most every 90s: the first
// of the two required freshness layers. The client then layers SWR on top (see
// DashboardClient) for background refetch and filter-driven refetches in between.
export const revalidate = 90;

export default async function Page() {
  const initialData = await getDashboardData({}, 'all');
  return <DashboardClient initialData={initialData} />;
}
