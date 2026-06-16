/**
 * lib/supabase/server.ts
 *
 * Supabase server-side client factory.
 *
 * Uses the service role key which bypasses Row Level Security and grants full
 * database access. This module must NEVER be imported by any client-side code.
 *
 * A factory function is exported rather than a module-level singleton so that
 * each server request gets a fresh client instance, avoiding cross-request
 * state leakage in long-lived Node.js processes.
 */

import { createClient } from '@supabase/supabase-js'
import { SUPABASE_SERVICE_URL, SUPABASE_SERVICE_KEY } from '../env'

/**
 * Creates and returns a Supabase client authenticated with the service role
 * key. Call this function inside server-side request handlers, Route Handlers,
 * or Server Actions — never at module scope.
 *
 * @returns A fully-initialised Supabase client with service role privileges.
 */
export function createServerClient(): ReturnType<typeof createClient> {
  return createClient(SUPABASE_SERVICE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      // Disable session persistence — the service role client is stateless
      // and should not attempt to manage user sessions.
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
