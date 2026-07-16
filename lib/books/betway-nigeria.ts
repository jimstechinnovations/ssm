// lib/books/betway-nigeria.ts
// Betway Nigeria adapter — wraps the existing Playwright public-feed scraper.
// The only book with a MEASURED Win Boost table (lib/pedlas/boost.ts).

import 'server-only'
import type { BookAdapter } from './types'
import { boostFor as betwayNigeriaBoostFor } from '../pedlas/boost'
import { fetchBetwayPedlasFixtures } from '../betway/playwright'

export const betwayNigeria: BookAdapter = {
  id: 'betway_nigeria',
  label: 'Betway Nigeria',
  currency: 'NGN',
  minStake: 100,
  maxPayout: 50_000_000,
  boostFor: betwayNigeriaBoostFor,
  boostVerified: true,
  feedVerified: true,
  credentialEnv: { username: 'BETWAY_NUMBER', password: 'BETWAY_PASSWORD' },
  async fetchFixtures(opts) {
    const r = await fetchBetwayPedlasFixtures({
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      scanLimit: opts.scanLimit,
      minKickoffGapMinutes: opts.minKickoffGapMinutes,
    })
    return { fixtures: r.fixtures, source: r.source, feedUrl: r.feedUrl }
  },
}
