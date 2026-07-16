/**
 * scripts/auto.mjs — ONE command: launch → build → place. The whole PEDLA pipeline autonomously.
 *
 *   node scripts/auto.mjs [--legs 35] [--slips 200] [--stake 10] [--live] [--min 45 --max 180]
 *                         [--mode dedicated|default] [--out todaybook.json]
 *
 * What it does, in order:
 *   1. LAUNCH — ensure a debug Chrome is up on :9222 (scripts/cdp-launch-chrome.ps1). If it is
 *      already up we reuse it (your logged-in SportyBet session persists in the .chrome-bot profile).
 *   2. BUILD  — scripts/build-pedla-book.mjs → <out>: N-leg Under-4.5 slips, K covering, 3h+ kickoff
 *      buffer so nothing suspends mid-run.
 *   3. PLACE  — scripts/place-all-cdp.mjs <out>: pure-CDP real placement, truth-confirmed per slip.
 *
 * SAFETY: DRY-RUN by default (rehearses everything, places nothing). Real money needs BOTH the
 * --live flag here AND a logged-in REAL-mode SportyBet session in the debug Chrome. There is no
 * blind retry: a failed/unconfirmed slip stops at that slip for a human to look.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// ── args ─────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const LEGS  = val('--legs', '35')
const SLIPS = val('--slips', '200')
const STAKE = val('--stake', '10')
const OUT   = val('--out', 'todaybook.json')
const MODE  = val('--mode', 'dedicated')
const MIN   = val('--min', '45')
const MAX   = val('--max', '180')
const LIVE  = has('--live')

const CDP = 'http://127.0.0.1:9222/json/version'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (s = '') => process.stdout.write(s + '\n')

/** Run a child process to completion, inheriting stdio; reject on non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
  })
}

/** True once the CDP debug endpoint answers. */
async function cdpUp() {
  try { const r = await fetch(CDP, { signal: AbortSignal.timeout(2000) }); return r.ok } catch { return false }
}

async function ensureChrome() {
  if (await cdpUp()) { line('1/3 launch  · debug Chrome already up on :9222 — reusing it'); return }
  line(`1/3 launch  · starting debug Chrome (${MODE} profile) on :9222 …`)
  // Fire-and-forget: the ps1 returns once Chrome has forked; Chrome keeps running.
  spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/cdp-launch-chrome.ps1', '-Mode', MODE],
    { stdio: 'inherit', detached: true }).unref()
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await cdpUp()) { line('            · :9222 is up'); return } }
  throw new Error('debug Chrome did not come up on :9222 — run scripts/cdp-launch-chrome.ps1 manually and log into SportyBet')
}

async function main() {
  line('')
  line(`PEDLA auto · legs=${LEGS} slips=${SLIPS} stake=₦${STAKE} · ${LIVE ? '🔴 LIVE (real money)' : '🟢 DRY-RUN (no money)'}`)
  line('─'.repeat(72))

  await ensureChrome()
  if (LIVE) {
    line('            · LIVE mode — the debug Chrome MUST be logged into SportyBet in REAL mode.')
    line('            · placement is truth-confirmed (balance drop + "Submission Successful"); no blind retry.')
  }

  line(`2/3 build   · scripts/build-pedla-book.mjs → ${OUT}`)
  await run('node', ['scripts/build-pedla-book.mjs', LEGS, SLIPS, STAKE, OUT])
  if (!existsSync(OUT)) throw new Error(`build produced no ${OUT}`)
  const book = JSON.parse(readFileSync(OUT, 'utf8'))
  const nSlips = (book.book?.slips ?? book.slips ?? []).length
  line(`            · built ${nSlips} slip(s)`)

  const placeArgs = ['scripts/place-all-cdp.mjs', OUT, '--min', MIN, '--max', MAX]
  if (!LIVE) placeArgs.push('--dry')
  line(`3/3 place   · scripts/place-all-cdp.mjs ${OUT} ${LIVE ? '(LIVE)' : '(--dry)'}`)
  await run('node', placeArgs)

  line('─'.repeat(72))
  line(`done · ${LIVE ? 'placed' : 'rehearsed'} ${nSlips} slip(s). Track them under /placements.`)
}

main().catch((e) => { line(''); console.error('auto: ' + (e?.message ?? e)); process.exit(1) })
