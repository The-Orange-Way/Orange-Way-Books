import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

// VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required at
// build time. Earlier versions of this file shipped hardcoded fallbacks
// pointing at the original cloud project, that risk became
// real once OWB moved to its own Supabase projects (dev + prod):
// a misconfigured build would silently talk to the wrong database.
// Fail loudly instead.

const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!envUrl || !envKey) {
  throw new Error(
    'Supabase client misconfigured: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must both be set at build time. ' +
      'For local dev, copy .env.example to .env and fill them in. ' +
      'For Cloudflare Pages, set them in the project Environment Variables panel.',
  );
}

/** Same values passed to createClient, use everywhere that builds Supabase URLs/headers. */
export const SUPABASE_URL = envUrl;
export const SUPABASE_PUBLISHABLE_KEY = envKey;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
