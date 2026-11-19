/**
 * scripts/check-multimarket-results.mjs — settle the legs in multimarket-book.json against real
 * final scores (same endpoint lib/pedlas/results.ts uses: factsCenter/event, no auth needed).
 * Reports WIN/LOSS/VOID/PENDING per unique leg, market-aware (U45, O15, DNB).
 * Run: node scripts/check-multimarket-results.mjs [bookFile=multimarket-book.json]
 */
import { readFileSync } from 'node:fs'
const bookFile = process.argv[2] || 'multimarket-book.json'
const book = JSON.parse(readFileSync(bookFile, 'utf8'))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
const FINISHED = /end|finish|\bft\b|full.?time|awarded|closed/i

function parseScore(...vals) {
  for (const v of vals) { const m = (v ?? '').match(/(\d+)\s*[#:\-]\s*(\d+)/); if (m) return { hg: Number(m[1]), ag: Number(m[2]) } }
  return null
}

async function fetchResult(fixtureId) {
  try {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const d = (await r.json())?.data
    if (!d) return null
    const finished = FINISHED.test(d.matchStatus || d.status || '')
    const score = parseScore(d.setScore, d.productStatus, d.gameScore)
    return { finished, score }
  } catch { return null }
}

// unique legs across all slips
const legs = new Map()
for (const slip of book.slips) for (const l of slip.legs) legs.set(l.fixtureId, l)

function judge(market, outcome, score) {
  if (!score) return 'PENDING'
  const total = score.hg + score.ag
  const homeWon = score.hg > score.ag, awayWon = score.ag > score.hg, isDraw = score.hg === score.ag
  if (market === 'U45') return total <= 4 ? 'WIN' : 'LOSS'
  if (market === 'O15') return total >= 2 ? 'WIN' : 'LOSS'
  if (/^OU/.test(market)) {
    const line = Number(market.slice(2))
    const overWin = total > line
    return /^under/i.test(outcome) ? (overWin ? 'LOSS' : 'WIN') : (overWin ? 'WIN' : 'LOSS')
  }
  if (market === 'DNB') {
    if (isDraw) return 'VOID (draw, stake refunded)'
    return /^home/i.test(outcome) ? (homeWon ? 'WIN' : 'LOSS') : (awayWon ? 'WIN' : 'LOSS')
  }
  if (market === 'HCP') {
    // stored as "Home (-0.5) [Team]" / "Away (-0.5) [Team]" — the -0.5 line means a straight win needed
    return /^home/i.test(outcome) ? (homeWon ? 'WIN' : 'LOSS') : (awayWon ? 'WIN' : 'LOSS')
  }
  if (market === '1X2') {
    return /^home/i.test(outcome) ? (homeWon ? 'WIN' : 'LOSS') : (awayWon ? 'WIN' : 'LOSS')
  }
  if (market === 'BTTS') {
    const bothScored = score.hg > 0 && score.ag > 0
    return /^yes/i.test(outcome) ? (bothScored ? 'WIN' : 'LOSS') : (bothScored ? 'LOSS' : 'WIN')
  }
  if (market === 'MARGIN1') {
    const diff = score.hg - score.ag
    return /^home/i.test(outcome) ? (diff === 1 ? 'WIN' : 'LOSS') : (diff === -1 ? 'WIN' : 'LOSS')
  }
  if (market === 'GOALRANGE') {
    const m = /(\d+)-(\d+)/.exec(outcome), plus = /(\d+)\+/.exec(outcome)
    if (m) return (total >= Number(m[1]) && total <= Number(m[2])) ? 'WIN' : 'LOSS'
    if (plus) return total >= Number(plus[1]) ? 'WIN' : 'LOSS'
    return 'UNKNOWN'
  }
  if (/^HOU/.test(market) || /^AOU/.test(market)) {
    const line = Number(market.slice(3))
    const teamGoals = /^HOU/.test(market) ? score.hg : score.ag
    const overWin = teamGoals > line
    return /^under/i.test(outcome) ? (overWin ? 'LOSS' : 'WIN') : (overWin ? 'WIN' : 'LOSS')
  }
  return 'UNKNOWN'
}

console.log(`Checking ${legs.size} unique legs...\n`)
let busted = []
for (const [fid, l] of legs) {
  const res = await fetchResult(fid)
  const status = res?.finished ? judge(l.market, l.outcome, res.score) : 'PENDING/NOT FINISHED'
  const scoreStr = res?.score ? `${res.score.hg}-${res.score.ag} (total ${res.score.hg + res.score.ag})` : 'no score yet'
  console.log(`[${l.market}] ${l.game} — ${l.outcome} @ ${l.odds} — ${scoreStr} — ${status}`)
  if (status === 'LOSS') busted.push({ ...l, score: res.score })
}

console.log(`\n===== ${busted.length} busted leg(s) =====`)
for (const b of busted) console.log(`  [${b.market}] ${b.game}: final ${b.score.hg}-${b.score.ag} (total ${b.score.hg + b.score.ag}) — needed ${b.market === 'U45' ? '<=4' : b.market === 'O15' ? '>=2' : 'Home win'}, picked "${b.outcome}"`)
