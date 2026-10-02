/**
 * scripts/place-session.mjs — bridge a built coverage SESSION to the CDP placer.
 *
 *   node scripts/place-session.mjs <S-CODE|uuid> [--live] [--base http://localhost:3000] [placer args…]
 *
 * Steps:
 *   1. GET <base>/api/sessions/<code>  → the session's slips (pre-flight only).
 *   2. PRE-FLIGHT: every game still upcoming and each leg's exact market/outcome still open (any market).
 *   3. LIVE → place-all-cdp.mjs in QUEUE mode: slips are claimed from the shared database, so this same
 *      command can run on several PCs at once, or be stopped here and continued on another PC.
 *      DRY  → a local book file; every slip is loaded on the betslip, Confirm is never clicked.
 *
 * Started/suspended games simply drop from each slip (the placer places the shorter combo); only a
 * fully-dead pool aborts. --force skips that abort.
 *
 * The app (npm run dev) must be running, and for --live the debug Chrome must be up on :9222 and
 * logged into SportyBet in REAL mode. DRY-RUN is the default — nothing is staked without --live.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const code = args.find(a => !a.startsWith('--'))
const LIVE = args.includes('--live')
const FORCE = args.includes('--force')
const baseI = args.indexOf('--base')
const BASE = baseI >= 0 ? args[baseI + 1] : 'http://localhost:3000'
if (!code) { console.error('usage: node scripts/place-session.mjs <S-CODE|uuid> [--live] [--force] [--base URL]'); process.exit(1) }

const passthrough = args.filter((a, i) =>
  a !== code && a !== '--live' && a !== '--force' && a !== '--base' && !(baseI >= 0 && i === baseI + 1))

// withLegs=1 + a big limit: the placer needs EVERY slip's legs to build booking codes (the UI-facing
// default omits legs and paginates to 50 — which would write an empty book and fail every slip).
const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(code)}?withLegs=1&limit=20000`).catch(() => null)
if (!r || !r.ok) { console.error(`could not fetch session ${code} from ${BASE} (is npm run dev running?)`); process.exit(1) }
const { session, slips: allSlips, summary } = await r.json()
if (!allSlips?.length) { console.error(`session ${code} has no slips`); process.exit(1) }
const legless = allSlips.filter(s => !(s.legs?.length)).length
if (legless > 0) { console.error(`⛔ ${legless}/${allSlips.length} slips returned WITHOUT legs — refusing to place (would fail every booking code). Check the withLegs feed.`); process.exit(1) }
// Only slips not yet placed. (In LIVE queue mode the database decides who places what; this list is only
// for the pre-flight and the dry-run file.)
const slips = allSlips.filter(s => s.status === 'pending' || s.status === 'placing')
console.log(`${slips.length} unplaced of ${allSlips.length} slip(s) (already-placed are never re-placed).`)
if (!slips.length) { console.log('nothing to place — all slips already placed/settled.'); process.exit(0) }

// ── pre-flight: every game still upcoming, and each leg's exact market/outcome still open ──
// Works for every market (Decision Bot legs carry marketId/specifier/outcomeId; legacy legs are Over/Under).
const need = new Map()   // fixtureId → { game, outcomes: Set("marketId|specifier|outcomeId") }
for (const s of slips) for (const l of (s.legs ?? [])) {
  const key = l.marketId ? `${l.marketId}|${l.specifier || ''}|${l.outcomeId}` : `18|total=${l.line}|${l.side === 'Under' ? '13' : '12'}`
  const g = need.get(l.fixtureId) ?? { game: l.game, outcomes: new Set() }
  g.outcomes.add(key); need.set(l.fixtureId, g)
}
const marketIds = [...new Set([...need.values()].flatMap(g => [...g.outcomes].map(k => k.split('|')[0])))]
console.log(`pre-flight: checking ${need.size} game(s) × ${marketIds.length} market type(s) against the live feed…`)
// The feed goes through the debug Chrome when it's up: SportyBet's edge drops a script's raw requests at
// times (2026-10-01 — TLS fingerprint, not IP), and a tab parked on sportybet.com/robots.txt has a clean,
// unwrapped native fetch (the same tab the app's cdp-fetch uses). The raw fetch is only the fallback.
const portI = args.indexOf('--port')
const CDP_PORT = portI >= 0 ? Number(args[portI + 1]) : 9222
let feedTab = null
async function feedJson(url) {
  try {
    if (!feedTab) {
      const { chromium } = await import('playwright')
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 5000 })
      const ctx = browser.contexts()[0]
      let page = ctx.pages().find(pg => pg.url() === 'https://www.sportybet.com/robots.txt')
      if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 20_000 }) }
      feedTab = { browser, page }
    }
    const j = await feedTab.page.evaluate(async u => { const r = await fetch(u, { signal: AbortSignal.timeout(15_000) }); return r.ok ? r.json() : { httpStatus: r.status } }, url)
    if (j?.data) return { j, via: 'browser' }
  } catch { /* no browser up / tab gone → raw fetch below */ }
  // the feed rejects requests without a full browser user-agent (HTTP 403)
  const fr = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(e => ({ error: e?.cause?.code || e?.message }))
  const j = fr?.json ? await fr.json().catch(() => null) : null
  return { j, via: 'raw', status: fr?.status ?? fr?.error ?? '—' }
}
const status = new Map()   // fixtureId → { upcoming, closed: n }
for (let pg = 1; pg <= 10; pg++) {
  const { j, via, status: st } = await feedJson(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=${encodeURIComponent(marketIds.join(','))}&pageSize=100&pageNum=${pg}`)
  if (!j?.data?.tournaments) { if (pg === 1) console.error(`⚠ pre-flight: feed unreachable (${via}${st ? `, ${st}` : ''}) — continuing; the placer checks every slip on the betslip anyway`); break }
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    const id = Number((ev.eventId || '').split(':').pop())
    const g = need.get(id); if (!g) continue
    let closed = 0
    for (const k of g.outcomes) {
      const [mid, spec, oid] = k.split('|')
      const m = (ev.markets || []).find(x => String(x.id) === mid && (x.specifier || '') === spec)
      const o = m?.outcomes?.find(x => String(x.id) === oid)
      if (!m || (m.status !== undefined && m.status !== 0) || !o || o.isActive === 0) closed++
    }
    status.set(id, { upcoming: ev.estimateStartTime > Date.now() + 10 * 60 * 1000, closed })
  }
  if (pg * 100 >= (j.data.totalNum ?? 0)) break
}
await feedTab?.browser.close().catch(() => {})   // disconnects only — the parked tab stays for reuse
if (status.size) {
  const gone = [...need.entries()].filter(([id]) => !status.get(id)?.upcoming)
  const partly = [...need.entries()].filter(([id]) => status.get(id)?.upcoming && status.get(id).closed > 0)
  if (gone.length) {
    // Started/suspended games just DROP from each slip — the placer places the remaining legs (shorter combo).
    console.error(`\n⚠ pre-flight: ${gone.length}/${need.size} game(s) started or suspended — those legs drop; each slip places its remaining games:`)
    for (const [id, g] of gone) console.error(`   ✗ ${g.game} (fixture ${id})`)
    if (gone.length >= need.size) { console.error('\n⛔ every game is gone — nothing to place. Rebuild fresh.'); if (!FORCE) process.exit(2) }
  }
  if (partly.length) console.error(`⚠ pre-flight: ${partly.length} game(s) have a market closed for some slips — those legs drop on the betslip.`)
  if (!gone.length && !partly.length) console.log('pre-flight OK: every game upcoming and every leg\'s market open')
}

console.log(`session ${session.code}: ${slips.length} slip(s) to place · pending ${summary.pending} · staked-so-far ₦${summary.staked}`)
const reportUrl = `${BASE}/api/sessions/${encodeURIComponent(session.code)}/slip-status`
let placerArgs
// The floor a drifted payout must still clear (see place-all-cdp.mjs): the session's own budget is always
// the absolute floor (never place for less than what was risked to build the pool); --floor-pct (passed
// through from the caller, default 100 = old exact-target behaviour) sets the target-relative side of it.
const floorArgs = ['--budget-floor', String(session.budget)]
if (LIVE) {
  // LIVE → the shared database queue: any number of PCs can run this same command for the same session.
  console.log('Placing 🔴 LIVE (real money) from the shared queue — safe to run on several PCs at once, or to continue on another PC.')
  placerArgs = ['scripts/place-all-cdp.mjs', '--queue', '--session', session.code, '--base', BASE, '--min-payout', String(session.targetWin), ...floorArgs, ...passthrough]
} else {
  const bookFile = `session-${session.code}.json`
  writeFileSync(bookFile, JSON.stringify({ book: { slips: slips.map(s => ({ legs: s.legs, stake: s.stake, slipId: s.slipId, combinedOdds: s.combinedOdds, payout: s.potentialPayout })), stakePerSlip: slips[0].stake } }, null, 2))
  console.log(`wrote ${bookFile}. 🟢 DRY-RUN via place-all-cdp (loads every slip on the betslip, never clicks Confirm, changes nothing in the queue)…`)
  placerArgs = ['scripts/place-all-cdp.mjs', bookFile, '--report', reportUrl, '--session', session.code, '--dry', '--min-payout', String(session.targetWin), ...floorArgs, ...passthrough]
}
const p = spawn(process.execPath, placerArgs, { stdio: 'inherit' })   // no shell: keeps our stdout (the run log) attached
p.on('close', c => process.exit(c ?? 0))
