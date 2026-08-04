// India has a single fixed UTC+5:30 offset year-round (no DST), so "today in Asia/Kolkata"
// can be computed with a constant offset rather than a timezone library. Business-logic
// "today"/"days until ship" must always go through this -- never the server or browser's
// local Date() -- so a laptop/server in a different timezone can't misclassify orders.
const KOLKATA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function kolkataNow(): Date {
  return new Date(Date.now() + KOLKATA_OFFSET_MS);
}

export function kolkataToday(): string {
  return kolkataNow().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function daysBetween(fromISODate: string, toISODate: string): number {
  const a = Date.parse(fromISODate + 'T00:00:00Z');
  const b = Date.parse(toISODate + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}
