/**
 * scripts/auto.mjs — ONE command, end-to-end: launch → login → REAL → build → place.
 *
 *   node scripts/auto.mjs [--live] [--budget 5000] [--target 500000] [--books sportybet]
 *                         [--window 45] [--legs N] [--base http://localhost:3000] [--min 1 --max 3]
 *
 * Steps (all automated, no clicks):
 *   1. LAUNCH  — ensure debug Chrome on :9222 (scripts/cdp-launch-chrome.ps1).
 *   2. PREP    — CDP: auto-login (SPORTY_NUMBER/SPORTY_PASSWORD) and, for --live, flip to REAL mode;
 *                read the balance and sanity-check it.
 *   3. APP     — ensure the Next app is up (start `npm run dev` if needed) so the engine is reachable.
 *   4. BUILD   — POST /api/sessions: coverage book (legs computed from target/odds/boost, K=budget/min),
 *                persisted under a session id; prints the HONEST P(≥1 win).
 *   5. PLACE   — scripts/place-session.mjs <code>: exports the slips and runs the CDP placer.
 *
 * SAFETY: DRY-RUN by default — nothing is staked. Real money needs --live (which also flips REAL mode).
 * Placement is truth-confirmed per slip (balance drop + "Submission Successful"); no blind retry.
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const LIVE   = has('--live')
const BUDGET = Number(val('--budget', '5000'))
const TARGET = Number(val('--target', '500000'))
const BOOKS  = val('--books', 'sportybet').split(',').map(s => s.trim()).filter(Boolean)
const WINDOW = Number(val('--window', '120'))
const LEGS   = val('--legs', '')
const BASE   = val('--base', 'http://localhost:3000')
const MIN    = val('--min', '1'), MAX = val('--max', '3')
const MODE   = val('--mode', 'dedicated')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (s = '') => process.stdout.write(s + '\n')
const naira = (n) => '₦' + Math.round(n).toLocaleString()

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
    p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))))
  })
}
const ping = async (url, ms = 2500) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok } catch { return false } }

// ── 1. Chrome on :9222 ────────────────────────────────────────────────────────────
async function ensureChrome() {
  if (await ping('http://127.0.0.1:9222/json/version')) { line('1/5 launch  · debug Chrome already up on :9222'); return }
  line(`1/5 launch  · starting debug Chrome (${MODE}) on :9222 …`)
  spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/cdp-launch-chrome.ps1', '-Mode', MODE], { stdio: 'inherit', detached: true }).unref()
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await ping('http://127.0.0.1:9222/json/version')) { line('            · :9222 up'); return } }
  throw new Error('debug Chrome did not come up on :9222')
}

// ── 2. login + REAL (CDP) ───────────────────────────────────────────────────────────
async function prep() {
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  try {
    const ctx = browser.contexts()[0]
    let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
    if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(3500)
    const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }

    if (Number.isNaN(await balNum())) {
      const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
      if (phone && psd) {
        line('2/5 prep    · logging in…')
        const pb = page.locator('input[name=phone]').first()
        if (await pb.count()) { await pb.fill(phone.replace(/^\+?234/, '0')).catch(() => {}); await page.fill('input[name=psd]', psd).catch(() => {}); await page.locator('button.m-btn-login').first().click().catch(() => {}); await page.waitForTimeout(7000) }
      }
    }
    if (LIVE) {
      const real = page.locator('[data-op=switch-box-left]').first()
      if (await real.count()) {
        const b = await real.boundingBox()
        if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(2000) }
        line('2/5 prep    · switched to REAL mode')
      } else line('2/5 prep    · REAL/SIM toggle not found (already REAL, or shows once a slip is loaded)')
    }
    const bal = await balNum()
    line(`2/5 prep    · balance ${Number.isNaN(bal) ? 'UNREADABLE (not logged in?)' : naira(bal)}`)
    if (LIVE) {
      if (Number.isNaN(bal)) throw new Error('LIVE aborted: not logged in (no balance visible)')
      if (bal > 100000) line('            · ⚠ balance > ₦100k looks like SIM play-money — check the REAL/SIM toggle')
      if (bal < 10) throw new Error(`LIVE aborted: balance ${naira(bal)} below min stake`)
    }
    return bal
  } finally { await browser.close() }
}

// ── 3. Next app ─────────────────────────────────────────────────────────────────────
async function ensureApp() {
  if (await ping(`${BASE}/api/books`)) { line('3/5 app     · already up at ' + BASE); return }
  line('3/5 app     · starting `npm run dev` …')
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
  for (let i = 0; i < 60; i++) { await sleep(2000); if (await ping(`${BASE}/api/books`, 4000)) { line('            · app up'); return } }
  throw new Error('Next app did not come up — run `npm run dev` manually')
}

// ── 4. build coverage session ────────────────────────────────────────────────────────
async function build() {
  const today = new Date().toISOString().slice(0, 10)
  const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
  const body = { books: BOOKS, date_from: today, date_to: to, budget: BUDGET, target_win: TARGET, selection_window_min: WINDOW }
  if (LEGS) body.leg_pref = Number(LEGS)
  line(`4/5 build   · POST /api/sessions · ${naira(BUDGET)} → target ${naira(TARGET)} · window ${WINDOW}m · ${BOOKS.join(',')}`)
  const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) })
  const j = await r.json()
  if (!r.ok) throw new Error(`build failed: ${j.error ?? r.status}${j.issues ? ' — ' + j.issues.join('; ') : ''}`)
  const b0 = (j.books || []).find(b => b.pAnyWin != null) || {}
  line(`            · session ${j.session.code} · ${j.session.slipCount} slips · ${j.session.legCount} legs · pool ${j.session.poolSize}`)
  line(`            · HONEST P(≥1 win) ${b0.pAnyWin != null ? (100 * b0.pAnyWin).toFixed(1) + '%' : '—'} · median payout ${b0.medianPayout != null ? naira(b0.medianPayout) : '—'}`)
  for (const b of j.books || []) if (b.error) line(`            · ${b.bookId}: ${b.error}${b.detail ? ' — ' + b.detail : ''}`)
  if (!j.session.slipCount) throw new Error('no slips built')
  return j.session.code
}

async function main() {
  line('')
  line(`PEDLA auto · ${naira(BUDGET)} → ${naira(TARGET)} · ${LIVE ? '🔴 LIVE (real money)' : '🟢 DRY-RUN (no money)'}`)
  line('─'.repeat(74))
  await ensureChrome()
  await prep()
  await ensureApp()
  const code = await build()
  line(`5/5 place   · scripts/place-session.mjs ${code} ${LIVE ? '(LIVE)' : '(dry)'}`)
  const placeArgs = ['scripts/place-session.mjs', code, '--base', BASE, '--min', MIN, '--max', MAX, ...(LIVE ? ['--live'] : [])]
  await run('node', placeArgs)
  line('─'.repeat(74))
  line(`done · session ${code} · ${LIVE ? 'placed' : 'rehearsed'}. Track it at ${BASE}/sessions/${code}`)
}

main().catch((e) => { line(''); console.error('auto: ' + (e?.message ?? e)); process.exit(1) })
