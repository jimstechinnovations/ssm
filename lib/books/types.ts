// lib/books/types.ts
// The bookmaker adapter contract. Each supported book implements this; the PEDLA engine
// stays book-agnostic and receives odds (Fixture[]) + payout rules (boost/caps) through it.

import type { Fixture } from '../pedlas/types'
import type { BoostFn } from '../pedlas/boost'

export interface FetchFixturesOptions {
  dateFrom: string              // YYYY-MM-DD
  dateTo: string                // YYYY-MM-DD
  scanLimit: number             // max fixtures to return
  minKickoffGapMinutes: number  // only fixtures kicking off at least this far in the future
}

export interface FetchFixturesResult {
  fixtures: Fixture[]
  source: string                // human-readable odds source tag
  feedUrl?: string
}

export interface BookAdapter {
  id: string                    // stable id used in configs, saved books, API payloads
  label: string                 // display name, e.g. "Betway Nigeria"
  currency: string              // e.g. "NGN"
  minStake: number              // book minimum stake per slip
  maxPayout: number             // book max-win cap
  boostFor: BoostFn             // Win Boost table (noBoost until verified — pedla_v1.md §3)
  boostVerified: boolean        // true only when the table was checked against a live betslip
  feedVerified: boolean         // true when fetchFixtures works against the live site today
  /** Env var names holding placement credentials (values are NEVER stored anywhere else). */
  credentialEnv: { username: string; password: string }
  fetchFixtures(opts: FetchFixturesOptions): Promise<FetchFixturesResult>
}

/** Safe metadata for client/UI use (no functions, no secrets). */
export interface BookInfo {
  id: string
  label: string
  currency: string
  minStake: number
  maxPayout: number
  boostVerified: boolean
  feedVerified: boolean
  credentialsConfigured: boolean
}
