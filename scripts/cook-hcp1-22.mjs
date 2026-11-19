import { readFileSync, writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.02
const targets = new Set(JSON.parse(readFileSync('.target22-oct25.json', 'utf8')).map(t => t.fixtureId))

const out = new Map()
for (let pg = 1; pg <= 25; pg++) {
  const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=16&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    pageEvents++
    const fid = Number(String(ev.eventId).split(':').pop())
    if (!targets.has(fid)) continue
    // whole-number ±1 line only ("match already 1-0 / 0-1")
    const line = (ev.markets || []).find(m => m.id === '16' && (m.specifier === 'hcp=-1' || m.specifier === 'hcp=1') && (m.status === undefined || m.status === 0))
    if (!line) continue
    const home = line.outcomes.find(o => /^home/i.test(o.desc))
    const away = line.outcomes.find(o => /^away/i.test(o.desc))
    const cands = []
    for (const o of [home, away]) if (o?.isActive === 1 && +o.odds >= MIN_ODDS) cands.push({ desc: o.desc, side: o === home ? ev.homeTeamName : ev.awayTeamName, odds: +o.odds, trueProb: +o.probability, specifier: line.specifier, outcomeId: o.id })
    if (!cands.length) continue
    const best = cands.sort((a, b) => b.trueProb - a.trueProb)[0]
    out.set(fid, {
      fixtureId: fid, game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, kickoff: new Date(ev.estimateStartTime).toISOString(),
      odds: best.odds, bookProb: best.trueProb, blendProb: best.trueProb, outcome: `${best.desc} [${best.side}]`,
      market: 'HCP1', rawMarketId: '16', rawSpecifier: best.specifier, rawOutcomeId: best.outcomeId,
    })
  }
  if (pageEvents === 0 || out.size >= targets.size) break
}
const legs = [...out.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
console.log(`${legs.length} of ${targets.size} target games have the whole-number ±1 handicap line`)
const odds = legs.reduce((p, l) => p * l.odds, 1)
for (const l of legs) console.log(l.kickoff.slice(5, 16) + 'Z', l.game, '|', l.outcome, '@', l.odds, (l.bookProb * 100).toFixed(0) + '%')
writeFileSync('slip-oct25-hcp1.json', JSON.stringify({ legs, combinedOdds: odds }, null, 2))
console.log(`Wrote slip-oct25-hcp1.json, combined ${odds.toFixed(2)}x`)
