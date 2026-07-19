/**
 * scripts/place-session.mjs — bridge a built coverage SESSION to the CDP placer.
 *
 *   node scripts/place-session.mjs <S-CODE|uuid> [--live] [--base http://localhost:3000] [placer args…]
 *
 * Steps:
 *   1. GET <base>/api/sessions/<code>  → the persisted 500 slips.
 *   2. Write them to session-<code>.json in the shape scripts/place-all-cdp.mjs expects.
 *   3. Invoke place-all-cdp.mjs on that file (DRY-RUN unless --live is passed).
 *
 * PRE-FLIGHT: before placing anything it re-checks EVERY pool game against the live feed — with
 * ~all-leg slips a single suspended/started game poisons every slip, so we abort with the list
 * (rebuild is cheap) rather than burn an hour skipping 500 slips. --force skips the abort.
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
const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(code)}?withLegs=1&limit=1000`).catch(() => null)
if (!r || !r.ok) { console.error(`could not fetch session ${code} from ${BASE} (is npm run dev running?)`); process.exit(1) }
const { session, slips: allSlips, summary } = await r.json()
if (!allSlips?.length) { console.error(`session ${code} has no slips`); process.exit(1) }
const legless = allSlips.filter(s => !(s.legs?.length)).length
if (legless > 0) { console.error(`⛔ ${legless}/${allSlips.length} slips returned WITHOUT legs — refusing to place (would fail every booking code). Check the withLegs feed.`); process.exit(1) }
// Only place slips not already placed (idempotency also guards, but this keeps the book small + fast).
const slips = allSlips.filter(s => s.status === 'pending' || s.status === 'placing')
console.log(`${slips.length} unplaced of ${allSlips.length} slip(s) to place (already-placed are skipped).`)
if (!slips.length) { console.log('nothing to place — all slips already placed/settled.'); process.exit(0) }

// ── pre-flight: every pool game must still be upcoming + its Under-4.5 market active ──
const poolGames = new Map() // fixtureId → game label
for (const s of slips) for (const l of (s.legs ?? [])) if (!poolGames.has(l.fixtureId)) poolGames.set(l.fixtureId, { game: l.game, line: l.line, kickoff: l.kickoff })
console.log(`pre-flight: checking ${poolGames.size} pool game(s) against the live feed…`)
const liveOk = new Map()
for (let pg = 1; pg <= 10; pg++) {
  const fr = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null)
  const j = fr ? await fr.json().catch(() => null) : null
  if (!j?.data?.tournaments) break
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    const id = Number((ev.eventId || '').split(':').pop())
    if (!poolGames.has(id)) continue
    const line = poolGames.get(id).line
    const m = (ev.markets || []).find(x => x.specifier === `total=${line}`)
    const active = m && (m.status === undefined || m.status === 0) && (m.outcomes || []).every(o => o.isActive !== 0)
    const upcoming = ev.estimateStartTime > Date.now() + 10 * 60 * 1000
    liveOk.set(id, Boolean(active && upcoming))
  }
  const total = j.data.totalNum ?? 0
  if (pg * 100 >= total) break
}
const bad = [...poolGames.entries()].filter(([id]) => liveOk.get(id) !== true)
if (bad.length > 0) {
  // Suspended games just DROP from each slip — the placer places the remaining legs (shorter combos).
  // So a few dead games are fine; only a fully-dead pool (nothing to place) is fatal.
  console.error(`\n⚠ pre-flight: ${bad.length}/${poolGames.size} game(s) suspended — those legs drop; each slip places its remaining games (shorter combo):`)
  for (const [id, g] of bad) console.error(`   ✗ ${g.game} (fixture ${id})`)
  if (bad.length >= poolGames.size) { console.error('\n⛔ ALL pool games suspended — nothing to place. Rebuild fresh.'); if (!FORCE) process.exit(2) }
  else console.error('→ continuing: placing the live legs of every slip.')
} else {
  console.log('pre-flight OK: all pool games live + markets active')
}

const bookFile = `session-${session.code}.json`
writeFileSync(bookFile, JSON.stringify({
  book: {
    slips: slips.map(s => ({ legs: s.legs, stake: s.stake, slipId: s.slipId, combinedOdds: s.combinedOdds })),
    stakePerSlip: slips[0].stake,
  },
}, null, 2))

console.log(`session ${session.code}: ${slips.length} slips · ${session.legCount} legs · pool ${session.poolSize} · ` +
  `pending ${summary.pending} · staked-so-far ₦${summary.staked}`)
console.log(`wrote ${bookFile}. Placing ${LIVE ? '🔴 LIVE (real money)' : '🟢 DRY-RUN'} via place-all-cdp…`)

const reportUrl = `${BASE}/api/sessions/${encodeURIComponent(session.code)}/slip-status`
const placerArgs = ['scripts/place-all-cdp.mjs', bookFile, '--report', reportUrl, ...(LIVE ? [] : ['--dry']), ...passthrough]
const p = spawn('node', placerArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
p.on('close', c => process.exit(c ?? 0))
