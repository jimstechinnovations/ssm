/**
 * lib/supabase/client.ts
 *
 * Browser-safe Supabase client using the anonymous (public) key.
 *
 * The NEXT_PUBLIC_ prefix causes Next.js to inline these values into the
 * client bundle at build time — they are safe to expose to the browser
 * because the anon key is governed by Row Level Security policies.
 *
 * This module-level singleton is safe to import from any client component.
 * Never import the server client (lib/supabase/server.ts) from client
 * components — it carries the service role key.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || supabaseUrl.trim() === '') {
  throw new Error(
    'Missing required environment variable: "NEXT_PUBLIC_SUPABASE_URL". ' +
      'Ensure it is set in your .env file or deployment environment.'
  )
}

if (!supabaseAnonKey || supabaseAnonKey.trim() === '') {
  throw new Error(
    'Missing required environment variable: "NEXT_PUBLIC_SUPABASE_ANON_KEY". ' +
      'Ensure it is set in your .env file or deployment environment.'
  )
}

export const supabaseClient: SupabaseClient = createClient(
  supabaseUrl.trim(),
  supabaseAnonKey.trim()
)
