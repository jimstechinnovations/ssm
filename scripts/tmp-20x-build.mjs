import { readFileSync, writeFileSync } from 'node:fs'
const fixtures = JSON.parse(readFileSync('.20x-raw.json', 'utf8'))
const cands = []
for (const f of fixtures) {
  if (f.sport === 'Tennis') {
    const m = f.markets.find(x => x.id === '186')
    if (!m) continue
    const best = m.outcomes.reduce((a, b) => (+a.probability > +b.probability ? a : b))
    const p = +best.probability
    if (p >= 0.65 && p <= 0.93) cands.push({ sport: f.sport, fid: f.fid, game: f.game, league: f.league, kickoff: f.kickoff, outcome: best.desc, odds: +best.odds, prob: p, rawMarketId: '186', rawSpecifier: '', rawOutcomeId: best.id })
  } else {
    // pick best O/U specifier: most lopsided within 65-93% band
    let best = null
    for (const m of f.markets) {
      if (m.id !== '18') continue
      for (const o of m.outcomes) {
        const p = +o.probability
        if (p >= 0.65 && p <= 0.93) {
          if (!best || p > best.prob) best = { outcome: o.desc, odds: +o.odds, prob: p, rawSpecifier: m.specifier, rawOutcomeId: o.id }
        }
      }
    }
    if (best) cands.push({ sport: f.sport, fid: f.fid, game: f.game, league: f.league, kickoff: f.kickoff, outcome: best.outcome, odds: best.odds, prob: best.prob, rawMarketId: '18', rawSpecifier: best.rawSpecifier, rawOutcomeId: best.rawOutcomeId })
  }
}
console.log('candidates', cands.length)
cands.sort((a, b) => b.prob - a.prob) // safest first
let odds = 1, picked = []
for (const c of cands) {
  if (odds >= 20) break
  picked.push(c); odds *= c.odds
}
console.log('legs', picked.length, 'odds', odds.toFixed(2))
const prob = picked.reduce((a, c) => a * c.prob, 1)
console.log('prob', (prob * 100).toFixed(4) + '%')
writeFileSync('.20x-cands.json', JSON.stringify(cands))
writeFileSync('.20x-picked.json', JSON.stringify(picked))
for (const p of picked) console.log(p.sport, p.league, p.game, '|', p.outcome, '@' + p.odds, (p.prob * 100).toFixed(1) + '%')
