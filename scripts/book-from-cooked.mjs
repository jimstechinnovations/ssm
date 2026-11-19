/**
 * scripts/book-from-cooked.mjs — read a cook-slip.mjs output JSON and get a public SportyBet
 * booking code for its legs. Places nothing.
 *
 * Run: node scripts/book-from-cooked.mjs slip-3000x.json
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'cooked-slip.json'
const ticket = JSON.parse(readFileSync(file, 'utf8'))

function dcOutcomeId(desc) {
  if (/home.*draw/i.test(desc)) return '9'
  if (/home.*away/i.test(desc)) return '10'
  if (/draw.*away/i.test(desc)) return '11'
  throw new Error(`unrecognised DC outcome: "${desc}"`)
}

function legToSelection(leg) {
  const eventId = `sr:match:${leg.fixtureId}`
  if (leg.rawMarketId) return { eventId, marketId: leg.rawMarketId, specifier: leg.rawSpecifier || '', outcomeId: leg.rawOutcomeId }
  switch (leg.market) {
    case 'U45': return { eventId, marketId: '18', specifier: 'total=4.5', outcomeId: '13' }
    case 'O15': return { eventId, marketId: '18', specifier: 'total=1.5', outcomeId: '12' }
    case 'DC': return { eventId, marketId: '10', specifier: '', outcomeId: dcOutcomeId(leg.outcome) }
    case 'DNB': return { eventId, marketId: '11', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '4' : '5' }
    case 'HCP': return { eventId, marketId: '16', specifier: /^home/i.test(leg.outcome) ? 'hcp=-0.5' : 'hcp=0.5', outcomeId: /^home/i.test(leg.outcome) ? '1714' : '1715' }
    case '1X2': return { eventId, marketId: '1', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '1' : '3' }
    default: throw new Error(`unknown market ${leg.market}`)
  }
}

console.log(`${ticket.legs.length} legs, combined odds ${ticket.combinedOdds.toFixed(2)}x`)
const selections = ticket.legs.map(legToSelection)

const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', platform: 'web' },
  body: JSON.stringify({ selections, shareType: 1 }),
})
const json = await res.json()
if (json.bizCode !== 10000 || !json.data?.shareCode) {
  console.error(`Booking code FAILED (bizCode ${json.bizCode}):`, JSON.stringify(json).slice(0, 800))
  process.exit(1)
}
console.log(`\nBooking code: ${json.data.shareCode}`)
console.log(`URL: ${json.data.shareURL ?? `https://www.sportybet.com/ng/?shareCode=${json.data.shareCode}`}`)
