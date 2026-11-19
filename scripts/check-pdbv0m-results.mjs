import { readFileSync, writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const legs = JSON.parse(readFileSync('.pdbv0m-legs.json', 'utf8'))

function settleMarket(market, outcome, homeScore, awayScore) {
  const total = homeScore + awayScore
  switch (market) {
    case 'O15': return total > 1.5
    case 'U45': return total < 4.5
    case 'DC': {
      if (/home or draw/i.test(outcome)) return homeScore >= awayScore
      if (/draw or away/i.test(outcome)) return awayScore >= homeScore
      if (/home or away/i.test(outcome)) return homeScore !== awayScore
      return null
    }
    case 'DC1UP': {
      if (/home or draw/i.test(outcome)) return homeScore >= awayScore
      if (/draw or away/i.test(outcome)) return awayScore >= homeScore
      return null
    }
    case 'HOU05': return homeScore > 0.5
    case 'AOU05': return awayScore > 0.5
    default: return null
  }
}

const results = []
for (const l of legs) {
  try {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${l.fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    const j = await r.json()
    const ev = j.data
    const status = ev?.matchStatus
    let home = null, away = null
    if (ev?.setScore && /^\d+:\d+$/.test(ev.setScore)) { const [h, a] = ev.setScore.split(':'); home = +h; away = +a }
    let win = null
    if (status === 'Ended' && home != null && away != null) win = settleMarket(l.market, l.outcome, +home, +away)
    results.push({ ...l, status, home, away, win })
  } catch (e) {
    results.push({ ...l, status: 'ERR', error: String(e) })
  }
  await new Promise(r => setTimeout(r, 80))
}
writeFileSync('.pdbv0m-results.json', JSON.stringify(results, null, 2))
const ended = results.filter(r => r.status === 'Ended')
const wins = ended.filter(r => r.win === true)
const losses = ended.filter(r => r.win === false)
const unclear = ended.filter(r => r.win === null)
const notEnded = results.filter(r => r.status !== 'Ended')
console.log(`Ended: ${ended.length}/${results.length} | wins ${wins.length} | losses ${losses.length} | unclear ${unclear.length} | not-ended ${notEnded.length}`)
console.log('\n-- LOSSES --')
for (const r of losses) console.log(`${r.game} [${r.market} ${r.outcome}] final ${r.home}-${r.away}`)
console.log('\n-- UNCLEAR (need manual check) --')
for (const r of unclear) console.log(`${r.game} [${r.market} ${r.outcome}] status=${r.status} score=${r.home}-${r.away}`)
console.log('\n-- NOT ENDED --')
for (const r of notEnded) console.log(`${r.game} status=${r.status}`)
