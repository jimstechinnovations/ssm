import { readFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function settleMarket(market, outcome, h, a) {
  const total = h + a
  switch (market) {
    case 'O15': return total > 1.5
    case 'OU': { const m = outcome.match(/(Over|Under)\s+([\d.]+)/i); if (!m) return null; const line = +m[2]; return /over/i.test(m[1]) ? total > line : total < line }
    case 'HOU05': return h > 0.5
    case 'AOU05': return a > 0.5
    case 'O05': return total > 0.5
    case 'DC': case 'DC1UP': {
      if (/home or draw/i.test(outcome)) return h >= a
      if (/draw or away/i.test(outcome)) return a >= h
      if (/home or away/i.test(outcome)) return h !== a
      return null
    }
    case 'BTTS': return /yes/i.test(outcome) ? (h > 0 && a > 0) : !(h > 0 && a > 0)
    case 'DRAW10': return null
    case 'HCP': case 'HCP1': {
      const m = outcome.match(/\(([+-]?[\d.]+)\)/)
      if (!m) return null
      const line = +m[1]
      const isHome = /^home/i.test(outcome)
      const adj = isHome ? (h + line) - a : (a + line) - h
      if (adj > 0) return true
      if (adj < 0) return false
      return null // push
    }
    default: return null
  }
}

const files = [
  ['slip-oct25-22games.json', 'L97G14'],
  ['slip-oct25-mixed2.json', 'Z1P4MD'],
  ['slip-oct25-o15vsteam.json', 'NKJG5Y'],
  ['slip-oct25-draw10only.json', 'KYTHC9'],
  ['slip-oct25-gg.json', 'QCQTFV'],
  ['slip-oct25-hcp.json', 'UCKR6G'],
  ['slip-oct25-hcp1.json', 'HL1PG8'],
  ['slip-oct25-safe100.json', 'TJEPW5'],
]
for (const [file, code] of files) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  let wins = 0, losses = 0, unresolved = 0
  const lossRows = []
  for (const l of s.legs) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${l.fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    const j = await r.json()
    const ev = j.data
    const status = ev?.matchStatus
    let h = null, a = null
    if (ev?.setScore && /^\d+:\d+$/.test(ev.setScore)) { const [hh, aa] = ev.setScore.split(':'); h = +hh; a = +aa }
    let win = null
    if ((status === 'Ended' || status === 'AET' || status === 'AP') && h != null) win = settleMarket(l.market, l.outcome, h, a)
    if (win === true) wins++
    else if (win === false) { losses++; lossRows.push(`${l.game} [${l.market} ${l.outcome}] -> ${h}-${a}`) }
    else unresolved++
    await new Promise(r => setTimeout(r, 50))
  }
  console.log(`${code}: ${wins}W ${losses}L ${unresolved} pending -> ${losses > 0 ? 'CUT' : unresolved > 0 ? 'STILL ALIVE' : 'FULL WIN'}`)
  for (const row of lossRows) console.log('  LOSS:', row)
}
