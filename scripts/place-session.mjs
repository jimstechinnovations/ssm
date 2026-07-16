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
 * The app (npm run dev) must be running, and for --live the debug Chrome must be up on :9222 and
 * logged into SportyBet in REAL mode. DRY-RUN is the default — nothing is staked without --live.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const code = args.find(a => !a.startsWith('--'))
const LIVE = args.includes('--live')
const baseI = args.indexOf('--base')
const BASE = baseI >= 0 ? args[baseI + 1] : 'http://localhost:3000'
if (!code) { console.error('usage: node scripts/place-session.mjs <S-CODE|uuid> [--live] [--base URL]'); process.exit(1) }

const passthrough = args.filter((a, i) =>
  a !== code && a !== '--live' && a !== '--base' && !(baseI >= 0 && i === baseI + 1))

const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(code)}`).catch(() => null)
if (!r || !r.ok) { console.error(`could not fetch session ${code} from ${BASE} (is npm run dev running?)`); process.exit(1) }
const { session, slips, summary } = await r.json()
if (!slips?.length) { console.error(`session ${code} has no slips`); process.exit(1) }

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

const placerArgs = ['scripts/place-all-cdp.mjs', bookFile, ...(LIVE ? [] : ['--dry']), ...passthrough]
const p = spawn('node', placerArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
p.on('close', c => process.exit(c ?? 0))
