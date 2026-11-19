/**
 * scripts/multimarket-booking-code.mjs — generic SportyBet booking-code builder + LOAD-ONLY verify.
 * Extends the existing booking-code pattern (lib/placement/place-sportybet.ts only knows marketId 18)
 * to the 5-market scheme confirmed live via scripts/probe-sporty-multimarket.mjs:
 *
 *   U45 -> marketId 18, specifier total=4.5, outcomeId 13 (Under)
 *   O15 -> marketId 18, specifier total=1.5, outcomeId 12 (Over)
 *   DC  -> marketId 10, no specifier,        outcomeId 9|10|11 depending which combo was picked
 *   DNB -> marketId 11, no specifier,        outcomeId 4 (Home) | 5 (Away)
 *   HCP -> marketId 16, specifier hcp=X,     outcomeId 1714 (Home) | 1715 (Away)
 *   1X2 -> marketId 1,  no specifier,        outcomeId 1 (Home) | 3 (Away) — straight win, draw loses
 *
 * This script does NOT place anything. It creates a booking code (public, no-auth /orders/share)
 * from multimarket-book.json and — if a debug Chrome is up on :9222 (scripts/cdp-launch-chrome.ps1) —
 * loads it into the real betslip and reports the leg count + site odds so we can VERIFY the mapping
 * is correct before any stake is ever typed in. No stake is entered, no Place Bet is clicked.
 *
 * Run: node scripts/multimarket-booking-code.mjs [bookFile=multimarket-book.json] [slipIndex=0]
 */
import { readFileSync } from 'node:fs'

const bookFile = process.argv[2] || 'multimarket-book.json'
const slipIndex = Number(process.argv[3] || 0)

const book = JSON.parse(readFileSync(bookFile, 'utf8'))
const slip = book.slips[slipIndex]
if (!slip) { console.error(`No slip at index ${slipIndex} in ${bookFile}`); process.exit(1) }

/** DC outcomeId depends on WHICH combo was picked — parse it back out of the outcome description. */
function dcOutcomeId(desc) {
  if (/home.*draw/i.test(desc)) return '9'   // "Home or Draw"
  if (/home.*away/i.test(desc)) return '10'  // "Home or Away"
  if (/draw.*away/i.test(desc)) return '11'  // "Draw or Away"
  throw new Error(`unrecognised Double Chance outcome desc: "${desc}"`)
}

/** HCP outcome desc was built as "Home (-0.5) [Team]" or "Away (-0.5) [Team]" — recover the side. */
function hcpSelection(leg) {
  const favIsHome = /^home/i.test(leg.outcome)
  const specifier = favIsHome ? 'hcp=-0.5' : 'hcp=0.5'
  const outcomeId = favIsHome ? '1714' : '1715'
  return { specifier, outcomeId }
}

function legToSelection(leg) {
  const eventId = `sr:match:${leg.fixtureId}`
  // Markets whose outcome ids are opaque per-event strings (e.g. Goal Range) carry their real
  // marketId/specifier/outcomeId straight from the build step instead of being re-derived here.
  if (leg.rawMarketId) return { eventId, marketId: leg.rawMarketId, specifier: leg.rawSpecifier || '', outcomeId: leg.rawOutcomeId }
  switch (leg.market) {
    case 'U45': return { eventId, marketId: '18', specifier: 'total=4.5', outcomeId: '13' }
    case 'O15': return { eventId, marketId: '18', specifier: 'total=1.5', outcomeId: '12' }
    case 'DC':  return { eventId, marketId: '10', specifier: '', outcomeId: dcOutcomeId(leg.outcome) }
    case 'DNB': return { eventId, marketId: '11', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '4' : '5' }
    case 'HCP': { const h = hcpSelection(leg); return { eventId, marketId: '16', specifier: h.specifier, outcomeId: h.outcomeId } }
    case '1X2': return { eventId, marketId: '1', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '1' : '3' }
    case 'BTTS': return { eventId, marketId: '29', specifier: '', outcomeId: /^yes/i.test(leg.outcome) ? '74' : '76' }
    default:
      if (/^OU/.test(leg.market)) {
        const lineNum = leg.market.slice(2)
        const outcomeId = /^under/i.test(leg.outcome) ? '13' : '12'
        return { eventId, marketId: '18', specifier: `total=${lineNum}`, outcomeId }
      }
      if (/^HOU/.test(leg.market) || /^AOU/.test(leg.market)) {
        const marketId = /^HOU/.test(leg.market) ? '19' : '20'
        const lineNum = leg.market.slice(3)
        const outcomeId = /^under/i.test(leg.outcome) ? '13' : '12'
        return { eventId, marketId, specifier: `total=${lineNum}`, outcomeId }
      }
      throw new Error(`unknown market ${leg.market}`)
  }
}

const selections = slip.legs.map(legToSelection)
console.log(`Building booking code for slip #${slipIndex + 1}: ${slip.legs.length} legs, combined odds ${slip.combinedOdds.toFixed(2)}`)
console.log('selections:', JSON.stringify(selections, null, 1))

const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', platform: 'web' },
  body: JSON.stringify({ selections, shareType: 1 }),
})
const json = await res.json()
if (json.bizCode !== 10000 || !json.data?.shareCode) {
  console.error(`Booking code FAILED (bizCode ${json.bizCode}):`, JSON.stringify(json).slice(0, 500))
  process.exit(1)
}
console.log(`\nBooking code: ${json.data.shareCode}`)
console.log(`URL: ${json.data.shareURL ?? `https://www.sportybet.com/ng/?shareCode=${json.data.shareCode}`}`)
console.log('\nThis code is PUBLIC and no-auth — pasting it into any SportyBet session loads exactly these selections.')
console.log('No stake has been entered and no bet has been placed by this script.')
