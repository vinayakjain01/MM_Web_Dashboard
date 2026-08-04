import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Service-role client: full read access to fact_orders, bypassing RLS. Importable only
// from server modules (route handlers, server components) -- the `server-only` import
// above makes it a build-time error to pull this into a client component/bundle.
export function getSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY env vars.');
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
