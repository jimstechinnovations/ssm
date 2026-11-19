/**
 * scripts/cook-tennis-1stset-slip.mjs — LIVE tennis: finds matches currently in Set 2 where
 * one player already won Set 1 cleanly (setScore 1:0 or 0:1), and backs that player to win
 * the match outright (marketId 186 "Winner", live in-play price — already encodes the set lead,
 * far sharper signal than any pre-match form). Ranked by true probability, greedy-fills to target.
 *
 * LIVE ODDS MOVE FAST — build, verify, and hand over the code in one quick pass.
 *
 * Usage:
 *   node scripts/cook-tennis-1stset-slip.mjs --target=5 --out=slip-tennis.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/liveOrPrematchEvents'
const MIN_ODDS = 1.05

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const TARGET = Number(arg('target', '5'))
const OUT = arg('out', 'slip-tennis.json')

console.log(`Live tennis — Set 2, one player up 1 set to 0 — back that player to win the match`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 10; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:5')}&productId=2&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  const tournaments = json.data
  if (json.bizCode !== 10000 || !tournaments?.length) break
  for (const t of tournaments) {
    for (const ev of t.events || []) {
      if (ev.status !== 1) continue
      if (ev.matchStatus !== 'Set 2') continue
      if (ev.setScore !== '1:0' && ev.setScore !== '0:1') continue
      const winnerMkt = (ev.markets || []).find(m => m.id === '186' && (m.status === undefined || m.status === 0))
      if (!winnerMkt) continue
      const home = winnerMkt.outcomes.find(o => /^home/i.test(o.desc))
      const away = winnerMkt.outcomes.find(o => /^away/i.test(o.desc))
      const leaderIsHome = ev.setScore === '1:0'
      const pick = leaderIsHome ? home : away
      if (!pick || pick.isActive !== 1 || +pick.odds < MIN_ODDS) continue
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        tournament: t.name,
        leader: leaderIsHome ? ev.homeTeamName : ev.awayTeamName,
        setScore: ev.setScore,
        gameScore: (ev.gameScore || []).join(', '),
        odds: +pick.odds,
        trueProb: +pick.probability,
        outcomeId: pick.id,
      })
    }
  }
  if (tournaments.length < 100) break
}
all.sort((a, b) => b.trueProb - a.trueProb)
console.log(`\n${all.length} live matches qualify (Set 2, one player up 1-0 in sets)`)

const legs = []
let product = 1
for (const row of all) {
  if (product >= TARGET) break
  legs.push(row)
  product *= row.odds
}

console.log(`\nCooked slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) console.log(`[${l.tournament}] ${l.game} — ${l.leader} leads ${l.setScore} in sets (${l.gameScore}) -> Winner @ ${l.odds} (${(l.trueProb * 100).toFixed(1)}%)`)

const combinedProb = legs.reduce((p, l) => p * l.trueProb, 1)
console.log(`\nCombined true probability: ${(combinedProb * 100).toFixed(2)}%`)

const ticket = {
  generatedAt: new Date().toISOString(),
  sport: 'Tennis (live)',
  rule: 'Back the player leading 1 set to 0 (currently in Set 2) to win the match outright',
  target: TARGET,
  combinedOdds: product,
  combinedTrueProbability: combinedProb,
  note: 'Preview only. LIVE ODDS — verify/place within minutes of generation or re-fetch.',
  legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, tournament: l.tournament, leader: l.leader, setScore: l.setScore, gameScore: l.gameScore, market: 'Winner', odds: l.odds, trueProb: l.trueProb, rawMarketId: '186', rawSpecifier: '', rawOutcomeId: l.outcomeId })),
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)
