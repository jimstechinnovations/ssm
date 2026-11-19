import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|Reserves|Premier League Cup/

const fbPool = JSON.parse(readFileSync('.riskycombo-fbpool.json', 'utf8'))
const fbPicks = []
for (const g of fbPool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  if (!m) continue
  const o = (m.outcomes || []).find(x => x.desc === 'Over 1.5' && x.isActive)
  if (!o) continue
  const odds = parseFloat(o.odds), prob = parseFloat(o.probability)
  if (odds < 1.05) continue
  fbPicks.push({ sport: 'football', fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=1.5', outcomeId: o.id, label: 'Over 1.5', odds, prob })
}

const bbPool = JSON.parse(readFileSync('.riskycombo-bbpool.json', 'utf8'))
const bbPicks = []
for (const g of bbPool) {
  let best = null
  for (const m of g.markets) {
    if (m.id !== '225' || m.status !== 0) continue
    for (const o of m.outcomes || []) {
      if (!o.isActive) continue
      const prob = parseFloat(o.probability), odds = parseFloat(o.odds)
      if (odds < 1.08) continue
      if (!best || prob > best.prob) best = { label: o.desc, odds, prob, specifier: m.specifier, outcomeId: o.id }
    }
  }
  if (best) bbPicks.push({ sport: 'basketball', fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '225', specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}

const all = [...fbPicks, ...bbPicks].sort((a, b) => b.prob - a.prob)
writeFileSync('.riskycombo-picks.json', JSON.stringify(all, null, 2))
console.log('football picks:', fbPicks.length, '| basketball picks:', bbPicks.length, '| total:', all.length)
let c = 1
for (const p of all) c *= p.odds
console.log('max achievable odds if ALL used:', c.toFixed(2))
