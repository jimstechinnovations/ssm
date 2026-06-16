/**
 * lib/env.ts
 *
 * Typed, non-nullable environment variable accessors.
 *
 * Rules:
 *  - Server-only variables are accessed directly from `process.env` without any
 *    NEXT_PUBLIC_ prefix — they are never inlined into the client bundle.
 *  - Public variables use the NEXT_PUBLIC_ prefix so Next.js inlines them at
 *    build time for browser-safe access (see env var docs).
 *  - Every accessor throws a descriptive error at runtime if the variable is
 *    missing, so misconfiguration is caught immediately rather than surfacing
 *    as a cryptic downstream failure.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: "${name}". ` +
        `Ensure it is set in your .env file or deployment environment.`
    )
  }
  return value.trim()
}

// ---------------------------------------------------------------------------
// Server-side-only accessors (no NEXT_PUBLIC_ prefix)
// These MUST NOT be imported by any client-side module.
// ---------------------------------------------------------------------------

/**
 * API-Football v3 API key.
 * Maps to env var FOOTBAL_API_KEY (note: intentional single-L typo in the
 * env var name — matches the key as it appears in the .env file).
 */
export const FOOTBALL_API_KEY: string = requireEnv('FOOTBAL_API_KEY')

/**
 * API-Football v3 base URL.
 * Maps to env var FOOTBALL_URL.
 */
export const FOOTBALL_URL: string = requireEnv('FOOTBALL_URL')

/**
 * Supabase service role key (full database access, server-only).
 * Maps to env var SUPABASE_SERVICE.
 */
export const SUPABASE_SERVICE_KEY: string = requireEnv('SUPABASE_SERVICE')

/**
 * Supabase project URL (server-only accessor without NEXT_PUBLIC_ prefix).
 * Maps to env var SUPABASE_URL.
 */
export const SUPABASE_SERVICE_URL: string = requireEnv('SUPABASE_URL')

// ---------------------------------------------------------------------------
// Public (browser-safe) accessors — also available server-side.
// The NEXT_PUBLIC_ prefix causes Next.js to inline these into the client bundle.
// ---------------------------------------------------------------------------

/**
 * Supabase project URL, browser-safe.
 * Maps to env var SUPABASE_URL (re-exported under the NEXT_PUBLIC_ name so
 * Next.js inlines it for client components).
 */
export const NEXT_PUBLIC_SUPABASE_URL: string = requireEnv('SUPABASE_URL')

/**
 * Supabase anonymous (public) key, browser-safe.
 * Maps to env var SUPABASE_ANON.
 */
export const NEXT_PUBLIC_SUPABASE_ANON_KEY: string = requireEnv('SUPABASE_ANON')
