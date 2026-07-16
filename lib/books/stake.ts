// lib/books/stake.ts
// Stake adapter — REGISTERED BUT UNVERIFIED. Stake's sportsbook API is a Cloudflare-gated
// GraphQL endpoint (probed 2026-07-13: bare requests are rejected); a working feed needs a
// real browser session (Playwright + logged-in cookies), which has not been built/verified yet.
// The adapter exists so configs/UI can list the book; fetching fails with a clear message
// instead of silently returning nothing.

import 'server-only'
import type { BookAdapter } from './types'
import { noBoost } from '../pedlas/boost'

export const stake: BookAdapter = {
  id: 'stake',
  label: 'Stake',
  currency: 'NGN',
  minStake: 100,          // placeholder — verify against the live betslip
  maxPayout: 50_000_000,  // placeholder — verify against the live betslip
  boostFor: noBoost,
  boostVerified: false,
  feedVerified: false,
  credentialEnv: { username: 'STAKE_USERNAME', password: 'STAKE_PASSWORD' },

  async fetchFixtures() {
    throw new Error(
      'Stake feed not yet implemented: stake.com is Cloudflare-gated GraphQL and needs a live ' +
      'Playwright session to scrape. Deselect Stake, or build/verify lib/books/stake.ts first.',
    )
  },
}
