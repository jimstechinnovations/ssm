// lib/placement/place-betway.ts
// LIVE Betway Nigeria slip placement — phase-5 skeleton (pedla_v1.md §7).
//
// The dry-run bot is fully operational; this live path stays locked until its login/betslip
// selectors are verified in a supervised session against the real site. Guessing selectors
// blind would fail mid-slip with real money — so it refuses loudly instead.

import 'server-only'
import type { PedlasSlip } from '../pedlas/types'
import type { PlacementJob } from './queue'
import type { PlacementReceipt } from './receipt'

export async function placeBetwaySlipLive(_job: PlacementJob, _slip: PedlasSlip): Promise<PlacementReceipt> {
  const user = process.env.BETWAY_NUMBER
  const pass = process.env.BETWAY_PASSWORD
  if (!user || !pass) {
    throw new Error('BETWAY_NUMBER / BETWAY_PASSWORD env vars are not set.')
  }
  // Planned flow (to implement in a supervised live session):
  //   1. playwright chromium (persistent context, reuse the feed scraper's launch options)
  //   2. betway.com.ng → login with env creds → verify balance visible
  //   3. for each leg: open the fixture's total-goals market, click the Under/Over 4.5 price,
  //      verify the betslip leg count and each leg's odds match slip.legs (abort on drift)
  //   4. enter stake, verify displayed boosted payout ≈ slip.payout (±1%), submit, capture ref
  //   5. return; caller records the idempotency key
  throw new Error(
    'Betway LIVE placement is not yet verified: the login/betslip selectors must be confirmed ' +
    'in a supervised session first (pedla_v1.md §7 phase 5). Use dry-run until then.',
  )
}
