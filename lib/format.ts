const CURRENCY = '₹';

export function fmtMoney(n: number): string {
  return CURRENCY + Math.round(n).toLocaleString('en-IN');
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtRelativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
