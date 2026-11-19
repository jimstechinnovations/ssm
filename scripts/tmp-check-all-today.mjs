import { readFileSync } from 'node:fs'

const files = [
  ['slip-bball5-5x.json', 'bb'], ['slip-bball5-10x.json', 'bb'], ['slip-bball5-20x.json', 'bb'], ['slip-bball5-100x.json', 'bb'],
  ['slip-fbtoday-5x.json', 'fb'], ['slip-fbtoday-10x.json', 'fb'], ['slip-fbtoday-20x.json', 'fb'], ['slip-fbtoday-100x.json', 'fb'],
  ['slip-fbunder-6.json', 'fb'], ['slip-fb10x-sure.json', 'fb'],
  ['slip-bball10x-10x.json', 'bb'], ['slip-bball10x-20x.json', 'bb'],
  ['slip-fbtonight-full.json', 'fb'],
  ['slip-combo1000.json', 'mixed'],
  ['slip-5102-5x.json', 'fb'], ['slip-5102-100x.json', 'fb'],
  ['slip-bb1020-10x.json', 'bb'], ['slip-bb1020-20x.json', 'bb'],
]

function parseOutcome(outcome) {
  const m = outcome.match(/(Over|Under)\s*([\d.]+)/i)
  if (!m) return null
  return { dir: m[1].toLowerCase(), line: parseFloat(m[2]) }
}

async function getStatus(fid, productId) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${fid}&productId=${productId}`)
  const j = await r.json()
  return j.data
}

for (const [file, defaultSport] of files) {
  let s
  try { s = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { console.log(file, 'MISSING'); continue }
  console.log(`\n========== ${file} (${s.legs.length} legs) ==========`)
  let anyLost = false, allDone = true
  for (const l of s.legs) {
    const sport = l.sport || defaultSport
    const productId = sport === 'basketball' || sport === 'bb' ? 3 : 1
    let d
    try { d = await getStatus(l.fid || l.fixtureId, productId) } catch (e) { console.log(' ', l.game, 'FETCH ERROR'); continue }
    const score = d?.setScore || '-'
    const status = d?.matchStatus || '?'
    const parsed = parseOutcome(l.outcome)
    let verdict = 'pending'
    if (score !== '-' && parsed) {
      const [a, b] = score.split(':').map(Number)
      const total = a + b
      const cleared = parsed.dir === 'over' ? total > parsed.line : total < parsed.line
      const decided = status === 'Ended' || (parsed.dir === 'over' && cleared)
      if (status === 'Ended') verdict = cleared ? 'WON' : 'LOST'
      else if (parsed.dir === 'over' && cleared) verdict = 'clinched'
      else verdict = 'pending'
    }
    if (verdict === 'LOST') anyLost = true
    if (status !== 'Ended' && verdict !== 'clinched') allDone = false
    console.log(' ', l.game.padEnd(45), '|', l.outcome.padEnd(14), '| status:', status.padEnd(10), '| score:', score.padEnd(7), '|', verdict)
    await new Promise(r => setTimeout(r, 80))
  }
  console.log(`  >>> SLIP VERDICT: ${anyLost ? 'LOST' : (allDone ? 'WON (all cleared)' : 'still pending')}`)
}
