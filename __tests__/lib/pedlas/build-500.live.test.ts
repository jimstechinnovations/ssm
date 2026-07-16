// Live standalone build of the real 500-slip coverage book from SportyBet — NO placement.
// Run: PEDLA_LIVE=1 npx vitest --run build-500.live
// Captures what actually happens with the real pool + real odds (₦5000 budget, ₦10 min stake).

import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { sportybet } from '@/lib/books/sportybet'
import { selectAxes, PEDLA_LINES } from '@/lib/pedlas/market-select'
import { buildCoverageBook, planCoverage } from '@/lib/pedlas/coverage'

const LIVE = process.env.PEDLA_LIVE === '1'
const naira = (n: number) => '₦' + Math.round(n).toLocaleString()

describe.skipIf(!LIVE)('LIVE: build 500 slips from the real SportyBet pool', () => {
  it('fetch → select Under 4.5 @≥1.20 → scatter 500 slips (₦5000 / ₦10), capture the result', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10)

    const feed = await sportybet.fetchFixtures({ dateFrom: today, dateTo: to, scanLimit: 120, minKickoffGapMinutes: 45 })
    const axes = selectAxes(feed.fixtures, { lines: PEDLA_LINES, requireDominantSide: 'Under' })

    // eslint-disable-next-line no-console
    console.log(`\n  SportyBet pool: ${feed.fixtures.length} fixtures scanned → ${axes.length} qualifying Under-4.5 @≥1.20 games`)
    expect(axes.length).toBeGreaterThan(3)

    const book = buildCoverageBook(axes, {
      budget: 5000, stake: 10, maxPayout: sportybet.maxPayout,
      boost: sportybet.boostFor, targetWin: 500_000,
    })

    /* eslint-disable no-console */
    console.log(`  budget ₦5000 · min stake ₦10 · target ₦500,000`)
    console.log(`  → pool N=${book.poolSize} · legs/slip L=${book.L} (computed) · slips K=${book.K}`)
    console.log(`  → median odds ${book.medianOdds.toFixed(1)} · median payout ${naira(book.medianPayout)} · max-win cap ${naira(sportybet.maxPayout)}`)
    console.log(`  → mean cutters ${book.meanCutters.toFixed(1)} · β ${book.beta.toFixed(2)} · P(≥1 win) ${(100 * book.pAnyWin).toFixed(1)}%`)
    if (book.note) console.log(`  ! ${book.note}`)
    console.log(`  sample slip #1: ${book.slips[0].legs.length} legs, odds ${book.slips[0].combinedOdds.toFixed(1)}, payout ${naira(book.slips[0].payout)}`)
    /* eslint-enable no-console */

    const out = '500-slips.json'
    writeFileSync(out, JSON.stringify({
      builtAt: new Date().toISOString(),
      params: { budget: 5000, minStake: 10, targetWin: 500_000, book: 'sportybet' },
      poolSize: book.poolSize, legs: book.L, slips: book.K, beta: book.beta,
      pAnyWin: book.pAnyWin, medianPayout: book.medianPayout, medianOdds: book.medianOdds, meanCutters: book.meanCutters,
      book: { slips: book.slips.map(s => ({ legs: s.legs, stake: s.stake, combinedOdds: s.combinedOdds, payout: s.payout })), stakePerSlip: 10 },
    }, null, 2))
    // eslint-disable-next-line no-console
    console.log(`  wrote ${out} (${book.slips.length} slips)\n`)

    // ── the REAL frontier on this real pool: P(≥1 win) vs payout across leg-counts ──
    const plan = planCoverage(axes, { budget: 5000, stake: 10, maxPayout: sportybet.maxPayout, boost: sportybet.boostFor, trials: 1200 })
    /* eslint-disable no-console */
    console.log('  L   medianPayout   P(≥1 win)   (real SportyBet pool, no boost)')
    for (const c of plan.candidates.filter(c => c.L % 3 === 0 || c.L === plan.candidates.at(-1)!.L)) {
      console.log(`  ${String(c.L).padStart(2)}   ₦${Math.round(c.medianPayout).toLocaleString().padStart(10)}   ${(100 * c.pAnyWin).toFixed(1).padStart(6)}%`)
    }
    console.log(`  → best P(≥1 win): L=${plan.best.L} @ ${(100 * plan.best.pAnyWin).toFixed(1)}% (payout ${naira(plan.best.medianPayout)})\n`)
    /* eslint-enable no-console */

    expect(book.slips.length).toBe(book.K)
  }, 120_000)
})
