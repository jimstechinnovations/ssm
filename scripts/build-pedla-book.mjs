/**
 * scripts/build-pedla-book.mjs — build a PEDLA coverage book: N-leg Under slips, K covering slips.
 * Coverage = the K most-probable outcome vectors (all-Under anchor + best single/double/… flips),
 * so we can't enumerate 2^N — we expand best-first. Under 4.5 @>=1.20 (+5.5 when available).
 *
 *   node scripts/build-pedla-book.mjs [legs=35] [slips=200] [stake=10] [out=todaybook.json]
 */
import { writeFileSync } from 'node:fs'
const N = Number(process.argv[2] || 35), K = Number(process.argv[3] || 200)
const STAKE = Number(process.argv[4] || 10), OUT = process.argv[5] || 'todaybook.json'

// Kickoff window: 2h from now (survives the placement run without suspending) → 24h (fast results).
// Widen the far edge only if we can't find N games. Near edge stays 2h (suspension-safe).
const minKick = Date.now() + 3 * 3600 * 1000   // 3h buffer: the ~60-75min run must finish before ANY game (all slips share the pool) kicks off
let maxHrs = 24
let cands = []
for (const tryHrs of [24, 36, 48, 72]) {
  maxHrs = tryHrs
  const maxKick = Date.now() + maxHrs * 3600 * 1000
  cands = []
  for (let pg = 1; pg <= 10 && cands.length < N + 15; pg++) {
    const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const j = await r.json(); if (!j.data || !j.data.tournaments) break
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      if (ev.estimateStartTime < minKick || ev.estimateStartTime > maxKick) continue
    // prefer 4.5, else 5.5, at >=1.20 dominant Under
    let pick = null
    for (const line of [4.5, 5.5]) {
      const m = (ev.markets || []).find(x => x.specifier === 'total=' + line); if (!m) continue
      const u = m.outcomes.find(o => /under/i.test(o.desc)), o = m.outcomes.find(x => /over/i.test(x.desc))
      if (!u || !o) continue; const uo = +u.odds, oo = +o.odds
      if (uo >= 1.20 && uo < oo) { const pu = (1 / uo) / ((1 / uo) + (1 / oo)); pick = { fixtureId: +ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, line, underOdds: uo, overOdds: oo, pUnder: pu, rOver: (1 - pu) / pu }; break }
    }
      if (pick) cands.push(pick)
    }
  }
  if (cands.length >= N) break   // enough games in this window; don't widen further
}
const legs = cands.sort((a, b) => a.underOdds - b.underOdds).slice(0, N)  // most reliable first
if (legs.length < N) console.log(`(only ${legs.length} qualifying legs within ${maxHrs}h — using those)`)
else console.log(`(window: next ${maxHrs}h · ${cands.length} qualifying games available)`)

// Best-first expansion: outcome = which legs are flipped to OVER. Product of rOver for flipped legs
// (× base all-Under prob) ranks outcomes. Fewest/lowest-ratio flips = most probable. Take top K.
const rs = legs.map((l, i) => ({ i, r: l.rOver })).sort((a, b) => b.r - a.r)  // biggest flip-ratio first
let heap = [{ flips: [], prod: 1, next: 0 }]
const vectors = []
while (vectors.length < K && heap.length) {
  heap.sort((a, b) => b.prod - a.prod)
  const x = heap.shift()
  vectors.push(x.flips)
  for (let k = x.next; k < rs.length; k++) heap.push({ flips: [...x.flips, rs[k].i], prod: x.prod * rs[k].r, next: k + 1 })
  if (heap.length > 6000) heap = heap.sort((a, b) => b.prod - a.prod).slice(0, 3000)
}

const slips = vectors.map(flipSet => {
  const flip = new Set(flipSet)
  const sl = legs.map((l, i) => flip.has(i)
    ? { fixtureId: l.fixtureId, game: l.game, line: l.line, side: 'Over', outcome: `Over ${l.line}`, odds: l.overOdds }
    : { fixtureId: l.fixtureId, game: l.game, line: l.line, side: 'Under', outcome: `Under ${l.line}`, odds: l.underOdds })
  return { legs: sl, stake: STAKE, combinedOdds: sl.reduce((a, x) => a * x.odds, 1), overFlips: flipSet.length }
})
writeFileSync(OUT, JSON.stringify({ book: { slips } }, null, 1))
const flipHist = {}; for (const s of slips) flipHist[s.overFlips] = (flipHist[s.overFlips] || 0) + 1
console.log(`${OUT}: ${slips.length} covering slips × ${legs.length} legs (Under@>=1.20, +5.5 where avail), stake ₦${STAKE}`)
console.log('flip distribution (Over-legs per slip → #slips):', JSON.stringify(flipHist))
console.log('anchor slip (all-Under) combined odds:', slips[0].combinedOdds.toExponential(2))
