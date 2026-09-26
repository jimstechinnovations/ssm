/**
 * scripts/place-all-cdp.mjs — PURE-CDP batch placement, now with PARALLEL workers.
 * A CDP click on Place Bet opens "About to pay" and a CDP click on Confirm fires the real
 * /orders/order — so each slip is: load code → stake → click Place → click Confirm.
 *
 *   node scripts/place-all-cdp.mjs <book.json> [--stake N] [--min S --max S] [--dry]
 *                                  [--workers N] [--report URL]              (file mode — dry runs)
 *   node scripts/place-all-cdp.mjs --queue --session S-CODE [--base URL] [--workers N]
 *                                                                              (QUEUE mode — live, multi-PC)
 *
 * QUEUE mode pulls slips from the shared database (migration 008) instead of a local file, so a session
 * can be placed from any PC, moved to another PC mid-run, or placed from several PCs at once:
 *   • each slip is CLAIMED with a lease (renewed every 10s by the heartbeat); a dead PC's unsubmitted
 *     slips go back to the pool automatically,
 *   • right before Confirm the worker takes the per-ACCOUNT submit lock (shared across PCs — SportyBet
 *     rejects simultaneous submits) and calls begin_submit: only the current lease holder can submit,
 *   • a slip that dies mid-submit is never re-placed blindly — it goes to 'verify' and is checked against
 *     the account's bet history (automatically at the next start, or by hand in the UI).
 *
 * --workers N opens N tabs in the SAME logged-in Chrome session and splits the slips round-robin
 * across them (≈N× faster). Prereq: dedicated Chrome on :9222, SportyBet logged in REAL.
 * Keeps: booking codes, stake set+verify, slip verification, idempotency, keepalive, and truth-based
 * confirmation via "Submission Successful" (balance-drop is unreliable when workers run concurrently).
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const bookPath = args.find(a => !a.startsWith('--'))
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d }
const DRY = args.includes('--dry')
const MIN = flag('--min', 1), MAX = flag('--max', 3)
// ONE worker per Chrome. Every tab of a Chrome profile shares ONE betslip (verified), so a second tab could
// load another booking code while this tab is confirming — the site would take the OTHER slip while we
// record this one. Parallelism comes from more PCs / Chromes / accounts through the shared queue instead.
const WORKERS = 1
if (flag('--workers', 1) > 1) console.log('note: --workers > 1 ignored — tabs of one Chrome share a betslip; add another PC/Chrome to place in parallel')
const LIMIT = flag('--limit', 0)   // place only the first N slips (0 = all) — for small live tests
const STAKE_OVERRIDE = args.includes('--stake') ? flag('--stake', NaN) : null
const QUEUE = args.includes('--queue')
const BASE = (i => i >= 0 ? args[i + 1] : 'http://localhost:3000')(args.indexOf('--base'))
const LEASE_SEC = flag('--lease', 180)
// Which placement Chrome this placer drives. One PC can run several (9222, 9223, …), each with its own
// profile and therefore its own betslip — one placer per port, all sharing the DB queue.
const PORT = flag('--port', 9222)
// Never stake a slip whose payout ON THE SITE (odds moved / bonus differs) is below the session's target —
// UNLESS a floor is configured (--floor-pct), in which case a payout that has drifted but is still well
// worth taking is placed instead of skipped outright. The floor is the HIGHER of: --floor-pct% of the
// target, and the session's own budget (never place for less than the budget risked to build the pool).
// floor-pct=100 (the default) reproduces the old all-or-nothing behaviour exactly.
const MIN_PAYOUT = flag('--min-payout', 0)
const FLOOR_PCT = flag('--floor-pct', 100)
const BUDGET_FLOOR = flag('--budget-floor', 0)
const EFFECTIVE_FLOOR = MIN_PAYOUT ? Math.max(BUDGET_FLOOR, MIN_PAYOUT * (FLOOR_PCT / 100)) : 0
const floorNote = FLOOR_PCT < 100 ? ` (floor: ${FLOOR_PCT}% of target = ₦${(MIN_PAYOUT * FLOOR_PCT / 100).toLocaleString()}, or budget ₦${BUDGET_FLOOR.toLocaleString()}, whichever is higher)` : ''
const REPORT_ARG = (i => i >= 0 ? args[i + 1] : null)(args.indexOf('--report'))
// Idempotency is scoped to the SESSION: a cloned/rebuilt session with an identical slip must place its
// own bet, never be "skipped as already placed" with another session's booking code (that reported
// slips as placed that were never staked in this session).
const SESSION = (i => i >= 0 ? args[i + 1] : 'adhoc')(args.indexOf('--session'))
const REPORT = REPORT_ARG ?? (QUEUE ? `${BASE}/api/sessions/${encodeURIComponent(SESSION)}/slip-status` : null)
// Queue identity: one id per tab-worker (host:pid:rand:wN) and a stable, non-reversible key per
// SportyBet ACCOUNT for the cross-PC submit lock (the number itself is never sent anywhere).
const WORKER_BASE = `${hostname()}:${PORT}:${process.pid}:${randomBytes(2).toString('hex')}`
const ACCOUNT = `sportybet:${createHash('sha256').update(String(process.env.SPORTY_NUMBER || 'unknown')).digest('hex').slice(0, 12)}`
const ACCOUNT_LABEL = `…${String(process.env.SPORTY_NUMBER || '????').slice(-4)}`
const QURL = `${BASE}/api/sessions/${encodeURIComponent(SESSION)}/queue`
/** Queue API call with retries (network blips must not strand a slip). */
async function qapi(body, tries = 5) {
  let last
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(QURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (r.ok) return j
      last = new Error(j.error || `queue HTTP ${r.status}`)
    } catch (e) { last = e }
    await sleep(800 * a)
  }
  throw last
}
// A balance above this is assumed to be SIM play-money (best-effort gate; env-configurable so a real
// account with a large balance isn't blocked). Ground truth stays the per-slip confirmation.
const SIM_BALANCE = Number(process.env.PLACEMENT_SIM_BALANCE || 100000)
let stopRequested = false   // set when the session's Stop is hit (read from the report response)
let wrongSlipStreak = 0     // consecutive "wrong slip" failures → a game was suspended mid-run (circuit breaker)
async function report(slipId, status, extra = {}, worker) {
  if (!REPORT || slipId == null) return
  if (worker) extra = { ...extra, worker }   // queue mode: the route only accepts results from the lease holder
  // Retry: a dropped report leaves the DB saying "pending" for a slip the bookmaker actually took.
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slipId, status, live: !DRY, ...extra }) })
      const j = await r.json().catch(() => ({}))
      if (j?.stop) stopRequested = true
      if (r.ok) return
    } catch { /* retry */ }
    await sleep(1500 * a)
  }
  console.log(`  ⚠ could not report slip ${slipId} → ${status} to the app after 4 tries (it IS recorded in ${LOG})`)
}
// HEARTBEAT: touch the session every ~10s so the UI sees a live-but-busy run (colliding/retrying/
// respawning between slips) as "running", not "stalled" — and so a Resume click can't start a 2nd placer.
async function heartbeat() {
  if (!REPORT || DRY) return
  try { const r = await fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ heartbeat: true, live: !DRY }) }); const j = await r.json().catch(() => ({})); if (j?.stop) stopRequested = true } catch { /* best-effort */ }
}
if (QUEUE && SESSION === 'adhoc') { console.error('queue mode needs --session S-CODE'); process.exit(1) }
if (!QUEUE && (!bookPath || !existsSync(bookPath))) { console.error('usage: node scripts/place-all-cdp.mjs <book.json> [--workers N --stake N --min S --max S --dry --report URL]\n       node scripts/place-all-cdp.mjs --queue --session S-CODE [--base URL] [--workers N]'); process.exit(1) }

let slips = []
if (!QUEUE) {
  const raw = JSON.parse(readFileSync(bookPath, 'utf8'))
  const book = raw.results ? raw.results.find(r => r.book)?.book : (raw.book ?? raw)
  slips = book?.slips ?? []
  if (!slips.length) { console.error('no slips in book'); process.exit(1) }
  if (LIMIT > 0) slips = slips.slice(0, LIMIT)
}

const LOG = '.placed-log.json'
const placedLog = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : {}
let saveChain = Promise.resolve()
const savePlaced = () => { saveChain = saveChain.then(() => { try { writeFileSync(LOG, JSON.stringify(placedLog, null, 2)) } catch { /* ignore */ } }); return saveChain } // serialize writes across workers

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
// --trace: time each step of a slip (where the seconds go) — for tuning speed
const TRACE = process.argv.includes('--trace')
/** Poll fn every 100ms until truthy or ms elapse (replaces fixed sleeps: move on the moment the page is ready). */
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { if (await fn().catch(() => false)) return true; if (Date.now() > end) return false; await sleep(100) } }
const rand = (a, b) => Math.round(a + Math.random() * (b - a))

// Submit mutex: SportyBet rejects two orders submitted at the same instant ("Submission Failed").
// So the Place→Confirm step is serialized across workers — everything else (code, load, stake, verify)
// stays parallel. Only ~2s per slip is serial, so N workers still give a big speedup.
let submitLock = Promise.resolve()
async function acquireSubmit() { const prev = submitLock; let rel; submitLock = new Promise(r => (rel = r)); await prev; return rel }

async function bookingCode(legs) {
  const selections = legs.map(l => l.marketId
    ? { eventId: `sr:match:${l.fixtureId}`, marketId: String(l.marketId), specifier: l.specifier || '', outcomeId: String(l.outcomeId) }
    : { eventId: `sr:match:${l.fixtureId}`, marketId: '18', specifier: `total=${l.line}`, outcomeId: l.side === 'Under' ? '13' : '12' })
  // 10s timeout + retries: a network blip ("fetch failed") used to fail the slip, and a hung request with no
  // timeout sat until the 150s slip watchdog killed the worker (seen with 3 windows at once, 2026-09-26).
  let last
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, platform: 'web' }, body: JSON.stringify({ selections, shareType: 1 }), signal: AbortSignal.timeout(10_000) })
      const j = await r.json()
      if (j.bizCode === 10000 && j.data?.shareCode) return j.data.shareCode
      last = new Error(`booking code failed (bizCode ${j.bizCode})`)
      if (j.bizCode === 19000) throw last   // the selections themselves are rejected — retrying won't help
    } catch (e) { last = e; if (/bizCode 19000/.test(e.message)) throw e }
    await sleep(700 * a)
  }
  throw last
}

/** All page-bound placement logic, bound to ONE tab. `parallel` disables the racy balance-drop confirm. */
function makeWorker(page, tag, parallel) {
  const log = (s) => console.log(`${tag}${s}`)
  // A screenshot of the betslip the moment a slip finally FAILS (not every retry — that would spam disk on
  // a bad run). This is how the "1010PAXEBFPAXEBF" / "The code is invalid." bug was actually found — by the
  // operator happening to be looking at the window — so future edge cases like it show up in logs/ instead.
  const shotOnFail = async (idx, reason) => {
    try {
      mkdirSync('logs', { recursive: true })
      const box = page.locator('[class*=betslip]').first()
      await box.screenshot({ path: `logs/fail-${SESSION}-slip${idx}-${Date.now()}.png`, timeout: 4000 })
      log(`  📸 saved a betslip screenshot for slip ${idx} (${reason.slice(0, 60)})`)
    } catch { /* best effort — never let a screenshot failure mask the real error */ }
  }
  // The HEADER balance only (#j_balance). Never "the first NGN on the page": in a narrow window the header
  // balance isn't rendered and that picked up a big-wins widget (₦100,703) → a false "SIM" (2026-09-26).
  const balNum = async () => { const t = await page.evaluate(() => document.querySelector('#j_balance, .m-balance')?.textContent ?? '').catch(() => ''); const m = t.match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
  const readBalance = async () => { for (let i = 0; i < 10; i++) { const b = await balNum(); if (!Number.isNaN(b)) return b; await sleep(1200) } return NaN }
  const bodyHas = re => page.evaluate(rs => new RegExp(rs, 'i').test(document.body.innerText), re.source)
  // Fixture ids currently on the betslip, read from SportyBet's own betslip storage. null if unreadable
  // (callers then fall back to page text).
  const betslipFixtures = () => page.evaluate(() => {
    try {
      let raw = ''
      for (const k of Object.keys(localStorage)) if (/^(betslips|betslipsSelections)$/i.test(k)) raw += localStorage.getItem(k) || ''
      if (!raw) return null
      return [...new Set([...raw.matchAll(/sr:match:(\d+)/g)].map(m => Number(m[1])))]
    } catch { return null }
  }).then(a => a ? new Set(a) : null).catch(() => null)
  // The site's own Odds / Total Stake / Potential Win from the visible betslip (what will really be staked).
  const readReceipt = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]
    const t = p ? p.innerText : ''
    const num = (re) => { const m = t.match(re); const v = m ? parseFloat(m[1].replace(/,/g, '')) : NaN; return Number.isFinite(v) && v > 0 ? v : null }
    const r = { siteOdds: num(/\bOdds\s+([\d,.]+)/i), siteStake: num(/Total Stake\s+([\d,.]+)/i), sitePayout: num(/Potential Win\s*\n?\s*([\d,.]+)/i) }
    return r.siteOdds || r.siteStake || r.sitePayout ? r : null
  }).catch(() => null)
  const codeBoxVisible = () => page.locator('input[placeholder="Booking Code"]:visible').count().then(n => n > 0)

  const clickLeaf = (reSource) => page.evaluate((rs) => {
    const rx = new RegExp(rs, 'i')
    const els = [...document.querySelectorAll('span,div,a,button')].filter(e => e.children.length === 0 && rx.test((e.textContent || '').trim()) && (e.offsetWidth || e.offsetHeight))
    els.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight))
    if (!els[0]) return false
    els[0].click(); return true
  }, reSource)

  const loggedInSignal = () => page.evaluate(() => {
    const t = document.body.innerText
    const pb = document.querySelector('input[name=phone]')
    return /Deposit|Bet History|My Account/i.test(t) && !(pb && (pb.offsetWidth || pb.offsetHeight))
  })

  const ensureLoggedIn = async () => {
    if (!Number.isNaN(await readBalance())) return true
    if (await loggedInSignal()) return true
    const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
    if (!phone || !psd) return false
    const pbVis = page.locator('input[name=phone]:visible').first()
    if (!(await pbVis.count())) return !Number.isNaN(await balNum()) || await loggedInSignal()
    log('  [keepalive] re-logging in…')
    for (let a = 1; a <= 2; a++) {
      await pbVis.fill(phone.replace(/^\+?234/, '0')).catch(() => {})
      await page.fill('input[name=psd]:visible', psd).catch(() => {})
      await page.locator('button.m-btn-login:visible').first().click().catch(() => {})
      await page.waitForTimeout(7000)
      if (!Number.isNaN(await balNum())) return true
    }
    return false
  }

  const successUp = () => bodyHas(/submission successful/)
  const dismissSuccess = async () => {
    for (let i = 0; i < 3 && (await successUp()); i++) {
      await page.keyboard.press('Escape').catch(() => {})
      await page.evaluate(() => { const vis = e => e && (e.offsetWidth || e.offsetHeight); const el = [...document.querySelectorAll('[class*=close],[class*=icon-close],span,div,button,i')].find(e => vis(e) && e.children.length === 0 && /^(ok|close|×|✕|✖|done)$/i.test((e.textContent || '').trim())); if (el) el.click(); else { const m = [...document.querySelectorAll('[class*=mask],[class*=overlay]')].find(vis); if (m) m.click() } })
      await page.waitForTimeout(700)
    }
  }

  const ensureRealView = async () => {
    const sim = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight > 50).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return /virtually simulated/i.test(p?.innerText || '') })
    if (!sim) return
    console.log(`${tag}⚠ betslip says "virtually simulated" — clicking the REAL side of the toggle`)
    await page.evaluate(() => { const el = document.querySelector('[data-op=switch-box-left]'); if (el) ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))) })
    await page.waitForTimeout(1800)
  }

  // GLOBAL BLOCKER SWEEP: dismiss stray dialogs that wedge an unsupervised run — cookie/consent banners,
  // promo/notification popups, session-expired / logged-out notices, generic error modals ("try again").
  // NEVER touches the placement flow (about-to-pay / place bet / accept changes / confirm / betslip).
  const dismissBlockers = async () => page.evaluate(() => {
    const vis = e => e && (e.offsetWidth || e.offsetHeight)
    const boxes = [...document.querySelectorAll('[class*=dialog],[class*=modal],[class*=popup],[class*=mask],[class*=overlay],[class*=toast],[class*=notice],[class*=cookie],[class*=consent]')].filter(vis)
    let n = 0
    for (const b of boxes) {
      const txt = (b.innerText || '')
      if (/about to pay|accept change|place bet|total stake|booking code|potential win|submission/i.test(txt)) continue // placement UI — leave it
      const btn = [...b.querySelectorAll('button,span,div,a,i')].find(e => vis(e) && e.children.length === 0 && /^(ok|okay|got it|close|accept( all)?|agree|allow|dismiss|continue|confirm|try again|reload|retry|×|✕|✖|x)$/i.test((e.textContent || '').trim()))
      if (btn) { btn.click(); n++ }
    }
    return n
  }).catch(() => 0)

  const clearSlip = async () => {
    // FAST PATH (the normal case between slips): Remove All → OK → the code box is back. The full sweep
    // below scans the whole page text several times per pass (~1s each on SportyBet) — only if this fails.
    if (!(await codeBoxVisible())) {
      const ra0 = page.locator('[data-cms-key=remove_all]:visible').first()
      if (await ra0.count()) {
        await ra0.click({ force: true }).catch(() => {})
        const ok = page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap]:visible [class*=dialog-btn]', { hasText: /^OK$/i }).first()
        if (await until(async () => (await ok.count()) > 0 || await codeBoxVisible(), 1000) && await ok.count()) await ok.click({ force: true }).catch(() => {})
        await until(codeBoxVisible, 1000)
      }
    }
    for (let i = 0; i < 9; i++) {
      if (await codeBoxVisible()) return
      await dismissBlockers()                                  // clear stray popups/consent/error modals first
      if (i >= 2 && !(await loggedInSignal()) && Number.isNaN(await balNum())) await ensureLoggedIn()  // session dropped mid-run → re-login
      await ensureRealView()
      if (await successUp()) { await dismissSuccess(); await page.waitForTimeout(500); continue }
      // a rejected submit leaves a "Submission Failed / something went wrong" dialog — click OK to recover
      if (await bodyHas(/submission failed|something went wrong/)) {
        await page.evaluate(() => { const vis = e => e && (e.offsetWidth || e.offsetHeight); const ok = [...document.querySelectorAll('button,span,div')].find(e => e.children.length === 0 && /^OK$/i.test((e.textContent || '').trim()) && vis(e)); if (ok) ok.click() })
        await page.waitForTimeout(700); continue
      }
      if (await bodyHas(/about to pay/)) { await clickLeaf('^cancel$'); await page.waitForTimeout(800); continue }
      const removeConfirm = await page.evaluate(() => { const w = [...document.querySelectorAll('.es-dialog-wrap,[class*=dialog-wrap]')].find(e => e.offsetWidth || e.offsetHeight); return w ? /remove betslip|remove all items/i.test(w.innerText) : false })
      if (removeConfirm) { await page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]', { hasText: /^OK$/i }).first().click({ force: true }).catch(() => {}); await until(codeBoxVisible, 800); continue }
      const ra = page.locator('[data-cms-key=remove_all]:visible').first()
      if (await ra.count()) { await ra.click({ force: true }).catch(() => {}); await until(async () => (await codeBoxVisible()) || (await page.locator('.es-dialog-wrap:visible, [class*=dialog-wrap]:visible').count()) > 0, 800); continue }
      const del = page.locator('[class*=betslip] [class*=icon-delete]:visible').first()
      if (await del.count()) { await del.click({ force: true }).catch(() => {}); await page.waitForTimeout(600); continue }
      // NUCLEAR RESET (last resort): if the buttons can't clear it (e.g. a betslip full of "Unavailable"
      // selections that Remove All won't drop), wipe the betslip localStorage + reload. Auth cookies are
      // untouched, so it stays logged in — this guarantees clearSlip always recovers to the code box.
      if (i === 6) {
        log('  [reset] betslip wedged — clearing selection storage + reloading')
        // ONLY the selection lists — NOT the REAL/SIM or country prefs (clearing those flips to SIM).
        await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^(betslips|betslipsSelections|wapBetslips|betslipsBankers)$/i.test(k)) localStorage.removeItem(k) }).catch(() => {})
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        await page.waitForTimeout(2800); await ensureRealView(); continue
      }
      await page.waitForTimeout(600)
    }
    if (!(await codeBoxVisible())) throw new Error('could not reset betslip to the Booking Code box')
  }

  async function placeOne(slip, idx, hooks = {}) {
    // Only Over/Under legs print "Over/Under" on the betslip; for other markets the betslip storage is the count.
    const allTotals = slip.legs.every(l => !l.rule || l.rule.kind === 'total')
    const stake = STAKE_OVERRIDE ?? slip.stake
    const code = await bookingCode(slip.legs)
    const legSig = slip.legs.map(l => `${l.fixtureId}:${l.outcome}`).sort().join('|')
    const idem = `${SESSION}|sportybet|${stake}|${legSig}`
    if (placedLog[idem]?.placed) { const e = placedLog[idem]; log(`slip ${idx}: SKIP (already placed in this session, ${e.code})`); return { result: 'skip', code: e.code, droppedFixtures: e.droppedFixtures, placedLegs: e.placedLegs, receipt: e.receipt } }

    // hidden page (window minimized/closed) → 'detached' = worker crash → respawn restores a visible window
    await assertVisible(page)
    if (!(await ensureLoggedIn())) throw new Error('not logged in (keepalive failed)')
    const before = await readBalance()
    if (Number.isNaN(before)) throw new Error('balance unreadable (logged out?)')
    if (before < stake) { if (!DRY) throw new Error(`insufficient balance ₦${before} < ₦${stake}`); log(`  (dry run: balance ₦${before} < stake ₦${stake} — fine, nothing is staked)`) }
    if (before > SIM_BALANCE) throw new Error(`balance ₦${before} looks like SIM play-money (> ₦${SIM_BALANCE}; set PLACEMENT_SIM_BALANCE if this is real) — check REAL/SIM toggle`)

    let tt = Date.now(); const tr = label => { if (TRACE) { console.log(`      ⏱ ${label} ${((Date.now() - tt) / 1000).toFixed(1)}s`); tt = Date.now() } }
    await clearSlip(); tr('clear betslip')
    const ci = page.locator('input[placeholder="Booking Code"]').first()
    await ci.waitFor({ timeout: 15000 })
    // The box is NOT guaranteed empty here (a previous attempt's leftover text, a stray stake digit blown
    // in by focus, a paste) — click+type alone APPENDS to whatever is already there, e.g. a real incident:
    // "1010PAXEBFPAXEBF" (stake "1010" + the code typed twice) → SportyBet: "The code is invalid." Every
    // retry after that then appended AGAIN, compounding it. Force-clear and VERIFY empty before typing,
    // then verify the typed value is exactly the code before clicking Load.
    let typed = false
    for (let a = 1; a <= 4 && !typed; a++) {
      await ci.click({ clickCount: 3 }).catch(() => {})           // select-all by triple-click
      await ci.press('Control+A').catch(() => {})                  // belt-and-braces select-all
      await ci.press('Delete').catch(() => {})
      if (!(await until(async () => (await ci.inputValue().catch(() => 'x')) === '', 800))) {
        await ci.fill('').catch(() => {})                          // last resort: force the DOM value
      }
      await ci.type(code, { delay: 20 })
      if ((await ci.inputValue().catch(() => '')) === code) typed = true
      else await page.waitForTimeout(200)
    }
    if (!typed) throw new Error(`could not get the booking code box to read exactly "${code}" — NOT loading`)
    tr('type code')
    await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
    // Wait until the betslip's own storage holds this slip's games — not for "Over/Under" text: Decision
    // Bot slips often have no Over/Under leg, and every such slip used to sit out the full 12s timeout.
    // Stop early if the count holds still for ~1.5s (suspended legs load a shorter slip), or immediately
    // if the site rejects the code outright (no point waiting out the full 12s for games that won't come).
    const codeRejected = () => page.evaluate(() => /the code is invalid|code has expired|code not found/i.test(document.body.innerText)).catch(() => false)
    for (let t = 0, last = -1, still = 0; t < 48; t++) {
      const f = await betslipFixtures(); const n = f ? f.size : 0
      if (n >= slip.legs.length) break
      still = n > 0 && n === last ? still + 1 : 0; last = n
      if (still >= 6) break
      if (t >= 4 && await codeRejected()) { await shotOnFail(idx, 'code rejected'); throw new Error(`SportyBet rejected the booking code "${code}" ("The code is invalid.") — retrying with a freshly-cleared box`) }
      await sleep(250)
    }
    await page.waitForTimeout(500); tr('load games')

    // System tab caps at 15 selections → "Note" dialog blocks everything. Dismiss + force Multiple.
    await page.evaluate(() => {
      const vis = e => e && (e.offsetWidth || e.offsetHeight)
      const note = [...document.querySelectorAll('[class*=dialog],[class*=modal]')].find(d => vis(d) && /cannot be over\s*\d+\s*selections under System/i.test(d.innerText))
      if (note) { const ok = [...note.querySelectorAll('button,span,div')].find(b => b.children.length === 0 && /^OK$/i.test((b.textContent || '').trim())); if (ok) ok.click() }
      return !!note
    }).then(hadNote => hadNote && page.waitForTimeout(500))
    await page.evaluate(() => {
      const vis = e => e && (e.offsetWidth || e.offsetHeight)
      const mult = [...document.querySelectorAll('[class*=betslip] span,[class*=betslip] div')].find(e => e.children.length === 0 && /^Multiple$/i.test((e.textContent || '').trim()) && vis(e))
      if (mult) ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => mult.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })))
    })
    await page.waitForTimeout(300)

    const readStake = () => page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? (p.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1] || '') : '' })
    tr('dialogs/multiple'); let stakeOk = false
    const stakeIs = async () => parseFloat((await readStake() || '0').replace(/,/g, '')) === stake
    stakeOk = await until(stakeIs, 400)   // the betslip usually keeps the last stake → nothing to type
    for (let a = 1; a <= 5 && !stakeOk; a++) {
      const sb = page.locator('input[placeholder^="min."]').first()
      await sb.waitFor({ timeout: 5000 }).catch(() => {})
      await sb.click({ clickCount: 3 }).catch(() => {}); await sb.press('Delete').catch(() => {}); await page.waitForTimeout(100)
      await sb.type(String(stake), { delay: 20 })
      stakeOk = await until(stakeIs, 1000)
    }
    if (!stakeOk) throw new Error(`could not set stake to ${stake}`)
    tr('set stake')

    const betslipText = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText : '' })
    let loadedLegs = (betslipText.match(/Over\/Under/g) || []).length
    // EXACT games on the betslip, from the site's own betslip storage (not page text). Any game that is
    // NOT one of this slip's legs means the betslip holds something else — never place it.
    const slipFix = new Set(slip.legs.map(l => Number(l.fixtureId)))
    const onSlip = await betslipFixtures()
    if (onSlip) {
      const foreign = [...onSlip].filter(id => !slipFix.has(id))
      if (foreign.length) throw new Error(`stale betslip: ${foreign.length} game(s) not in this slip (${foreign.slice(0, 3).join(', ')}) — NOT placing`)
      loadedLegs = onSlip.size
    } else if (!allTotals) loadedLegs = slip.legs.length   // can't count non-Over/Under legs from text; the storage check above is the guard
    // The booking code IS this slip. If it loads SHORTER than built, some legs were suspended mid-run —
    // the combo is still valid, so PLACE whatever games remain (default going forward). Reject ONLY when
    // the slip is fully empty (0 legs — every game suspended / betslip didn't load) or somehow LONGER
    // than built (impossible → wrong betslip).
    if (loadedLegs > slip.legs.length || loadedLegs < 1) throw new Error(`empty/invalid betslip: ${loadedLegs} legs vs ${slip.legs.length} — NOT placing`)
    if (loadedLegs < slip.legs.length) log(`  ℹ ${slip.legs.length - loadedLegs} leg(s) suspended — placing ${loadedLegs}-leg combo anyway`)
    // Lenient staleness guard: at least one of this slip's own teams must be on the betslip (else it's a
    // stale/old betslip, not this code's selections). Checks the first few legs so a dropped game 1 is OK.
    const anyTeam = slip.legs.slice(0, 6).some(l => { const tm = l.game?.split(' vs ')[0]?.trim(); return tm && betslipText.includes(tm) })
    if (!anyTeam) throw new Error(`stale/empty betslip (none of this slip's teams present) — NOT placing`)

    log(`slip ${idx}: code ${code} · ₦${stake} @ ${slip.combinedOdds?.toFixed?.(2) ?? '?'} · ${slip.legs.length} legs`)
    tr('verify games'); if (DRY) {
      // prove the receipt capture on the real betslip: the numbers the site would stake at Confirm
      const r = await readReceipt()
      const guard = MIN_PAYOUT && r?.sitePayout != null ? (r.sitePayout >= EFFECTIVE_FLOOR ? ' · ≥ floor ✓' : ' · BELOW floor — a live run would skip it') : ''
      log(`  [dry] betslip shows odds ${r?.siteOdds ?? '?'} · stake ₦${r?.siteStake ?? '?'} · potential win ₦${r?.sitePayout ?? '?'} (built ₦${slip.payout ?? '?'})${guard} — skipping Place/Confirm`)
      return { result: 'dry', code, receipt: r }
    }

    // Try to REMOVE any suspended/unavailable selections still sitting on the betslip so they don't block
    // the submit — then place whatever remains. (A "suspended" notice must NOT early-skip the whole slip:
    // place-shorter is the default. loadedLegs above already confirmed ≥1 real leg is present.)
    const removed = await page.evaluate(() => {
      let n = 0
      const rows = [...document.querySelectorAll('[class*=betslip] [class*=item], [class*=betslip] [class*=outcome], [class*=betslip] li, [class*=betslip] [class*=row]')]
      for (const row of rows) {
        if (!row.offsetHeight) continue
        if (!/suspend|unavailable|not available|market closed/i.test(row.textContent || '')) continue
        const del = [...row.querySelectorAll('[class*=del],[class*=remove],[class*=close],[class*=trash],svg,i,span')]
          .find(e => (e.offsetWidth || e.offsetHeight) && (/×|✕|✖|remove|delete/i.test(e.textContent || '') || /del|remove|close|trash/i.test(e.className || '')))
        if (del) { del.click(); n++ }
      }
      return n
    })
    if (removed) { log(`  ⏭ removed ${removed} suspended leg(s) from slip — placing the rest`); await page.waitForTimeout(700) }

    // Record WHICH legs are actually being placed vs dropped, so the DB matches reality (not the built
    // 32-leg record). A leg is "dropped" if its home team is no longer on the (post-removal) betslip.
    const finalText = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText : '' })
    const finalFix = await betslipFixtures()
    const droppedFixtures = finalFix && finalFix.size > 0
      ? slip.legs.filter(l => !finalFix.has(Number(l.fixtureId))).map(l => l.fixtureId)
      : slip.legs.filter(l => { const tm = l.game?.split(' vs ')[0]?.trim(); return tm && !finalText.includes(tm) }).map(l => l.fixtureId)
    // The betslip's own leg count must agree with what we'll record — else the DB would describe a
    // different bet than the one staked. Refuse rather than record a wrong slip.
    const finalLegs = finalFix && finalFix.size > 0 ? finalFix.size : allTotals ? (finalText.match(/Over\/Under/g) || []).length : 0
    if (finalLegs > 0 && finalLegs !== slip.legs.length - droppedFixtures.length) throw new Error(`leg mismatch: betslip shows ${finalLegs}, record would say ${slip.legs.length - droppedFixtures.length} — NOT placing`)
    if (droppedFixtures.length) log(`  ↳ dropped fixtures ${droppedFixtures.join(', ')} — recording ${slip.legs.length - droppedFixtures.length}-leg combo to DB`)

    // NOTE: "Accept Changes" is NOT a separate blocker — it's the SAME primary green button relabelled
    // when odds move. Clicking it accepts the new price and relabels back to "Place Bet". So the place/
    // confirm clickers below just target that button by EITHER label; clicking it repeatedly walks
    // Accept Changes → Place Bet → About-to-pay even if the price keeps shifting.

    // Robustly click a betslip button by EXACT label. Finds the label element, then climbs to its
    // clickable BUTTON ancestor and clicks that (clicking a bare text span often doesn't fire SportyBet's
    // handler — which is why it looked "stuck" on Accept Changes). Returns true if it clicked something.
    const clickBtn = async (labelSrc) => page.evaluate((src) => {
      const rx = new RegExp(src, 'i')
      const els = [...document.querySelectorAll('button, [role=button], [class*=btn], [class*=button], span, div, a')]
        .filter(e => (e.offsetWidth || e.offsetHeight) && rx.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 22)
      if (!els.length) return false
      els.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight))   // smallest = the label
      let t = els[0]
      for (let i = 0; i < 4 && t && t.parentElement; i++) { if (t.tagName === 'BUTTON' || /btn|button|wrapper/i.test(t.className || '') || t.getAttribute?.('role') === 'button') break; t = t.parentElement }
      ;(t || els[0]).click(); return true
    }, labelSrc)
    const hasBtn = async (labelSrc) => page.evaluate((src) => { const rx = new RegExp(src, 'i'); return [...document.querySelectorAll('span,div,button,a')].some(e => (e.offsetWidth || e.offsetHeight) && rx.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 22) }, labelSrc)

    // ── payout guard: what the SITE will pay must still reach the target ──
    const pre = await readReceipt()
    if (MIN_PAYOUT && pre?.sitePayout != null && pre.sitePayout < EFFECTIVE_FLOOR) throw new Error(`SKIP: payout on the site is ₦${pre.sitePayout.toLocaleString()} — below the ₦${EFFECTIVE_FLOOR.toLocaleString()} floor${floorNote} (odds moved since the build)`)

    // ── serialize the actual submission so concurrent workers never collide ──
    const release = await acquireSubmit()
    let placed = false, how = '', receipt = await readReceipt(), begun = false
    let unlockAccount = null
    try {
      if (hooks.lock) unlockAccount = await hooks.lock()   // per-ACCOUNT submit lock, shared by every PC
      await page.bringToFront().catch(() => {})   // active tab paints reliably for the Place/Confirm clicks
      const betLegs = async () => { const f = await betslipFixtures(); if (f) return f.size; return page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? (p.innerText.match(/Over\/Under/g) || []).length : 0 }) }
      // STEP 1 — reach the "About to pay" dialog. Each pass: if "Accept Changes" is showing, click it and
      // WAIT for it to become "Place Bet" (separate steps, not one button); then click "Place Bet". If
      // accepting emptied the slip, skip fast (no loop).
      let dialog = false
      for (let a = 1; a <= 8 && !dialog; a++) {
        if (await hasBtn('^accept changes$')) {
          await clickBtn('^accept changes$')
          for (let w = 0; w < 12 && await hasBtn('^accept changes$'); w++) await sleep(300)   // wait for it to clear
          if ((await betLegs()) === 0) throw new Error('SKIP: betslip emptied by odds/leg changes — nothing left to place')
        }
        await clickBtn('^place bet$')
        for (let p = 0; p < 10 && !dialog; p++) { await sleep(300); dialog = await bodyHas(/about to pay/) }
      }
      if (!dialog) throw new Error('SKIP: odds unstable — pay dialog never opened after retries')

      // STEP 2 — confirm. The dialog can also show "Accept Changes"; accept then confirm.
      for (let a = 1; a <= 6 && !placed; a++) {
        if (await hasBtn('^accept changes$')) { await clickBtn('^accept changes$'); await sleep(600) }
        receipt = (await readReceipt()) ?? receipt   // last read before Confirm = what is being staked
        // POINT OF NO RETURN: only the current lease holder may submit (atomic in the DB). If another PC
        // took the slip over (our lease lapsed), stop here — nothing has been submitted.
        // re-check after any Accept Changes: never confirm below target (nothing submitted yet → a clean skip)
        if (!begun) {
          const fin = await betslipFixtures()
          if (fin) {
            const want = new Set(slip.legs.map(l => Number(l.fixtureId)).filter(id => !droppedFixtures.includes(id)))
            const foreign = [...fin].filter(id => !want.has(id)), missing = [...want].filter(id => !fin.has(id))
            if (foreign.length || missing.length) throw Object.assign(new Error(`betslip changed before Confirm (${foreign.length} foreign, ${missing.length} missing) — NOT submitting`), { rejected: true })
          }
        }
        if (!begun && MIN_PAYOUT && receipt?.sitePayout != null && receipt.sitePayout < EFFECTIVE_FLOOR) throw Object.assign(new Error(`SKIP: after odds changes the site pays ₦${receipt.sitePayout.toLocaleString()} — below the ₦${EFFECTIVE_FLOOR.toLocaleString()} floor${floorNote}`), { rejected: true })
        if (!begun && hooks.beforeConfirm) await hooks.beforeConfirm()
        begun = true
        await clickBtn('^confirm$')
        for (let p = 0; p < 12 && !placed; p++) {
          await sleep(400)
          if (await successUp()) { placed = true; how = 'submission-successful'; break }
          // explicit rejections: the site refused the order, so nothing was placed — safe to retry
          if (await bodyHas(/submission failed|something went wrong/)) throw Object.assign(new Error('SportyBet rejected the submit (Submission Failed) — retry later'), { rejected: true })
          if (/insufficient|not enough|balance is/i.test(await page.evaluate(() => document.body.innerText))) throw Object.assign(new Error('SportyBet: balance insufficient'), { rejected: true, fatal: true })
          // balance-drop only when nothing else can spend on this account: in QUEUE mode another window or PC on the
          // same account may have just placed a slip with the same stake → a false "placed". There, only the site's
          // own success counts; anything unclear goes to verify (bet-history check).
          if (!parallel && !QUEUE) { const after = await balNum(); if (Math.abs((before - after) - stake) <= 0.5) { placed = true; how = 'balance-drop'; break } }
        }
        if (!placed && !(await bodyHas(/about to pay/))) break
      }
    } finally { release(); if (unlockAccount) await unlockAccount() }
    await dismissSuccess()
    if (placed) {
      const placedLegs = slip.legs.length - droppedFixtures.length
      placedLog[idem] = { placed: true, code, how, at: new Date().toISOString(), stake, droppedFixtures, placedLegs, receipt }; savePlaced()
      if (receipt?.siteStake && Math.abs(receipt.siteStake - stake) > 0.5) log(`  ⚠ site stake ₦${receipt.siteStake} ≠ intended ₦${stake} — recorded the SITE value`)
      log(`  ✓ PLACED (${how}) — code ${code}`)
      return { result: 'placed', code, droppedFixtures, placedLegs, receipt }
    }
    // Confirm was clicked but no success signal: it MAY be on the account — never guess, verify it.
    throw Object.assign(new Error('not confirmed (no success signal) — needs a bet-history check'), { uncertain: begun })
  }

  return { placeOne, ensureLoggedIn, ensureRealView, dismissBlockers, shotOnFail, page, prep: async () => {
    // Already on SportyBet with the header balance showing → logged in and usable: skip the ~20s reload.
    if (/sportybet\.com/.test(page.url()) && !Number.isNaN(await balNum())) { await ensureRealView(); return }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(3000); await ensureLoggedIn(); await ensureRealView()
  } }
}

// A page whose window is minimized is FROZEN: evaluate never returns → always race it against a timeout.
const pageVisibility = page => Promise.race([page.evaluate(() => document.visibilityState), sleep(4000).then(() => 'timeout')]).catch(() => 'gone')
const isVisible = async page => (await pageVisibility(page)) === 'visible'
/** Before each slip: a minimized window freezes the page. Restore it through Windows; only a page that is
 *  still hidden/gone afterwards counts as a dead worker. A merely SLOW answer ('timeout') is not "hidden"
 *  — treating it so cost ~45s per false respawn. */
async function assertVisible(page) {
  const v = await pageVisibility(page)
  if (v === 'visible') return
  const r = restoreOsWindow(); if (/restored [1-9]/.test(r)) console.log(`  (${r})`)
  await sleep(1200)
  const v2 = await pageVisibility(page)
  if (v2 === 'hidden' || v2 === 'gone') throw new Error(`placement window ${v2} (minimized/closed) — detached; respawning`)
}
function restoreOsWindow() {
  if (process.platform !== 'win32') return ''
  try { return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/restore-chrome-window.ps1', '-Port', String(PORT)], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim() } catch { return '' }
}

// ── robust worker rig: SHARED queue, per-slip watchdog, crash-respawn supervisor ──
const CHROME_LOCK = `.placer-cdp-${PORT}.lock`
function takeChromeLock() {
  for (let a = 0; a < 2; a++) {
    try { const fd = openSync(CHROME_LOCK, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); return true }
    catch {
      const pid = Number(readFileSync(CHROME_LOCK, 'utf8'))
      let alive = false; try { process.kill(pid, 0); alive = true } catch { /* dead */ }
      if (alive && pid !== process.pid) return false
      try { unlinkSync(CHROME_LOCK) } catch { /* race */ }
    }
  }
  return false
}
if (!takeChromeLock()) { console.error(`⛔ another placer is already driving this Chrome (:${PORT}). One placer per Chrome — its tabs share one betslip. Use another window (--port) or PC to place in parallel.`); process.exit(3) }
process.on('exit', () => { try { if (Number(readFileSync(CHROME_LOCK, 'utf8')) === process.pid) unlinkSync(CHROME_LOCK) } catch { /* gone */ } })
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const parallel = WORKERS > 1
const SPORTY = 'https://www.sportybet.com/ng/'
// Where a placer keeps its tab: one league page. It has the header balance and the full betslip, but not the
// home page's live-odds stream, which kept each window busy at ~0.7 of a CPU core even when idle (measured
// 2026-09-26: 0.43 here). On a 4-core PC with several windows, that CPU is the placing speed.
const PARK = 'https://www.sportybet.com/ng/sport/football/sr:category:1/sr:tournament:17'
const MAX_TRIES = flag('--retries', 3)     // auto-retry a failed slip in-run before giving up
const SLIP_TIMEOUT_MS = flag('--slip-timeout', 150) * 1000   // watchdog: a wedged slip is retried, not hung

// Spawn one worker on its own tab (serial reuses the existing SportyBet tab; parallel opens fresh tabs
// so each has a clean betslip). Returns a prepped worker or throws.
// A minimized or closed window stops painting, and clicks then hang until they time out (seen live: a window
// with no browser window left behind a "hidden" page). Restore the window; if there is none, open a new one.
async function visiblePage(page) {
  if (await isVisible(page)) { await ensureWide(page); return page }
  // minimized (the usual cause) → un-minimize through Windows; CDP can't see a minimized window
  const r = restoreOsWindow()
  if (r) console.log(`  (${r})`)
  await sleep(1500)
  if (await isVisible(page)) { await ensureWide(page); return page }
  try {
    const s = await ctx.newCDPSession(page)
    const { windowId } = await s.send('Browser.getWindowForTarget')
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await s.detach().catch(() => {})
    await sleep(800)
    if (await isVisible(page)) { console.log('  (restored a minimized placement window)'); await ensureWide(page); return page }
  } catch { /* no window for this page */ }
  const fresh = await ctx.newPage()
  await fresh.goto(SPORTY, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.close().catch(() => {})
  console.log('  (placement window was closed/hidden — opened a fresh one)')
  await ensureWide(fresh)
  return fresh
}
// SportyBet's narrow layout drops the header balance (and can hide the REAL/SIM toggle) → widen the window.
async function ensureWide(page) {
  try {
    const s = await ctx.newCDPSession(page)
    const { windowId, bounds } = await s.send('Browser.getWindowForTarget')
    if (bounds.windowState === 'normal' && bounds.width < 1280) {
      await s.send('Browser.setWindowBounds', { windowId, bounds: { width: 1300, height: Math.max(bounds.height, 850) } })
      console.log(`  (widened the placement window ${bounds.width}px → 1300px so the header balance shows)`)
      await sleep(800)
    }
    await s.detach().catch(() => {})
  } catch { /* best effort */ }
}
async function spawn(wi, reuseBase) {
  let page
  if (reuseBase) { page = ctx.pages().find(p => /sportybet\.com/.test(p.url())); if (!page) { page = await ctx.newPage(); await page.goto(SPORTY, { waitUntil: 'domcontentloaded' }).catch(() => {}) } }
  else { page = await ctx.newPage(); await page.goto(SPORTY, { waitUntil: 'domcontentloaded' }).catch(() => {}) }
  page = await visiblePage(page)
  if (!/\/sport\/football\/sr:/.test(page.url())) await page.goto(PARK, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}).then(() => page.waitForFunction(() => !!document.querySelector('#j_balance'), null, { timeout: 20_000 })).catch(() => {})
  const w = makeWorker(page, parallel ? `  [w${wi}] ` : '  ', parallel)
  await w.prep()
  return w
}
// A dead page/context/CDP error means the WORKER crashed (not the slip) — respawn it, don't fail the slip.
const workerDead = e => /Target closed|Session closed|browser has been closed|context was destroyed|Execution context|Protocol error|detached|crashed|WATCHDOG/i.test(e?.message || '')
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`WATCHDOG: ${label} exceeded ${ms / 1000}s`)), ms))])

const workersArr = []
for (let wi = 0; wi < WORKERS; wi++) {
  let w = null
  for (let a = 1; a <= 4 && !w; a++) { try { w = await spawn(wi, true) } catch (e) { console.log(`  startup attempt ${a} failed (${(e.message || '').slice(0, 60)}) — retrying`); await sleep(3000) } }
  if (!w) { console.error('⛔ could not attach to the SportyBet tab — is Chrome up and logged in?'); process.exit(4) }
  workersArr.push(w)
}

// ── where slips come from ──
//   file mode  (dry runs): a local list; failed slips are re-queued in memory up to MAX_TRIES.
//   QUEUE mode (live):     the shared DATABASE queue — claimed with a lease, any PC may take any slip,
//                          and a failed slip goes back to the shared pool (the DB caps attempts).
const fileQueue = QUEUE ? [] : slips.map((s, i) => ({ slip: s, idx: i + 1, tries: 0 }))
const workerIds = Array.from({ length: WORKERS }, (_, wi) => `${WORKER_BASE}:w${wi}`)
const wstats = workerIds.map(() => ({ placed: 0, failed: 0, current: null }))
let queueDrained = false
async function nextItem(wi) {
  if (!QUEUE) return fileQueue.shift() ?? null
  if (stopRequested || queueDrained) return null
  const j = await qapi({ action: 'claim', worker: workerIds[wi], n: 1, leaseSec: LEASE_SEC })
  if (j.stop) { stopRequested = true; return null }
  const s = j.slips?.[0]
  if (!s) { queueDrained = true; return null }
  return { slip: s, idx: s.slipId, tries: Math.max(0, (s.attempts ?? 1) - 1), claimed: true, submitted: false }
}
const remaining = () => QUEUE ? (queueDrained ? 0 : 1) : fileQueue.length

console.log(`\nCDP BATCH: ${QUEUE ? `QUEUE ${SESSION} (shared DB, account ${ACCOUNT_LABEL}, worker ${WORKER_BASE})` : `${slips.length} slip(s)`} · ${WORKERS} worker(s) · pacing ${MIN}-${MAX}s · slip-watchdog ${SLIP_TIMEOUT_MS / 1000}s${DRY ? ' · DRY-RUN' : ''}\n`)
const results = { placed: 0, skip: 0, dry: 0, suspended: 0, failed: 0, retried: 0, respawns: 0, verify: 0, lost: 0 }
const t0 = Date.now()
const placedFixturesOf = (slip, dropped) => { const d = new Set(dropped ?? []); return slip.legs.map(l => l.fixtureId).filter(id => !d.has(id)) }

/** Hooks that make a live submit safe across PCs (queue mode only). */
function submitHooks(wi, item) {
  if (!QUEUE || DRY) return {}
  const worker = workerIds[wi]
  return {
    lock: async () => {
      const deadline = Date.now() + 90_000
      for (;;) {
        const j = await qapi({ action: 'lock', worker, account: ACCOUNT, ttlSec: 30 })
        if (j.ok) break
        if (Date.now() > deadline) throw new Error('account submit lock busy for 90s (another PC stuck mid-submit?) — will retry')
        await sleep(400 + Math.random() * 500)
      }
      return async () => { await qapi({ action: 'unlock', worker, account: ACCOUNT }).catch(() => {}) }
    },
    beforeConfirm: async () => {
      const j = await qapi({ action: 'begin', worker, slipId: item.slip.slipId })
      if (!j.ok) throw Object.assign(new Error('LEASE_LOST: this slip now belongs to another worker — not submitting'), { leaseLost: true })
      item.submitted = true
    },
  }
}

// One worker's loop. On a WORKER crash it throws to the supervisor (which respawns + re-runs); on a SLIP
// failure it retries / hands the slip back / marks it failed or for verification, and keeps going.
async function runWorker(wi) {
  const worker = QUEUE ? workerIds[wi] : undefined
  for (;;) {
    if (stopRequested) break
    const item = await nextItem(wi); if (!item) break
    const { slip, idx, tries } = item
    const sid = slip.slipId
    wstats[wi].current = sid
    try {
      const { result: r, code, droppedFixtures, placedLegs, receipt } = await withTimeout(workersArr[wi].placeOne(slip, idx, submitHooks(wi, item)), SLIP_TIMEOUT_MS, `slip ${idx}`)
      if (r === 'placed' || r === 'skip') {
        if (r === 'placed') results.placed++; else results.skip++
        wstats[wi].placed++; wrongSlipStreak = 0
        if (!DRY && code) await report(sid, 'placed', { bookingCode: code, droppedFixtures, placedLegs, placedFixtures: placedFixturesOf(slip, droppedFixtures), ...(receipt ?? {}) }, worker)
      }
      else if (r === 'suspended') { results.suspended++; if (!DRY) await report(sid, 'skipped', { failureReason: 'suspended leg' }, worker) }
      else { results.dry++; if (QUEUE) await report(sid, 'retry', { failureReason: 'dry run' }, worker) }   // never leave a dry claim held
    } catch (e) {
      const msg = (e?.message || String(e)).slice(0, 200)
      if (e?.leaseLost) { results.lost++; console.log(`  slip ${idx}: ⚠ ${msg}`); continue }
      // Submitted but the outcome is unknown (no success signal, watchdog, crash after Confirm) → verify.
      if (QUEUE && item.submitted && !e?.rejected) {
        results.verify++; console.log(`  slip ${idx}: ⚠ UNCERTAIN after Confirm — sent to verification (${msg})`)
        await report(sid, 'verify', { failureReason: `uncertain after Confirm: ${msg}` }, worker)
        if (workerDead(e)) throw e
        continue
      }
      if (workerDead(e)) {                       // the TAB crashed (not the slip) — hand the slip back, respawn
        if (QUEUE) await report(sid, 'retry', { failureReason: `worker crashed: ${msg}` }, worker); else fileQueue.unshift(item)
        throw e
      }
      if (/^SKIP:/.test(e.message)) {
        results.skip++; wrongSlipStreak = 0; console.log(`  slip ${idx}: ⏭ ${e.message}`)
        if (!DRY) await report(sid, 'skipped', { failureReason: msg }, worker)
        if (remaining()) await sleep(rand(MIN, MAX) * 1000); continue
      }
      if (e?.fatal) { stopRequested = true; console.log(`\n⛔ ${msg} — stopping this PC's workers.\n`) }
      if (QUEUE) {
        // back to the SHARED queue — any PC may retry it; the DB turns it 'failed' after its last attempt
        results.retried++; wstats[wi].failed++; console.log(`  slip ${idx}: returned to the queue (attempt ${tries + 1}) — ${msg.slice(0, 90)}`)
        await report(sid, 'retry', { failureReason: msg }, worker)
      } else if (tries + 1 < MAX_TRIES && !stopRequested) {
        results.retried++; fileQueue.push({ slip, idx, tries: tries + 1 })
        console.log(`  slip ${idx}: retry ${tries + 1}/${MAX_TRIES - 1} — ${msg.slice(0, 80)}`)
      } else {
        results.failed++; console.log(`  slip ${idx}: FAILED (after ${tries + 1} tries) — ${e.message}`)
        await workersArr[wi]?.shotOnFail?.(idx, msg)
        if (!DRY) await report(sid, 'failed', { failureReason: msg }, worker)
      }
      if (/empty\/invalid|stale|leg mismatch/i.test(e.message)) { if (++wrongSlipStreak >= 8) { stopRequested = true; console.log(`\n⛔ CIRCUIT BREAKER: ${wrongSlipStreak} consecutive empty/stale betslips — betslip not loading (browser wedged?) or all games died. Halting.\n`) } }
      else wrongSlipStreak = 0
    } finally { wstats[wi].current = null }
    if (remaining()) await sleep(rand(MIN, MAX) * 1000)
  }
}

// Supervisor: runs a worker; if it crashes, respawns a fresh tab (up to a few times) and resumes.
async function supervise(wi) {
  while (remaining() && !stopRequested) {
    try { await runWorker(wi); return }
    catch (e) {
      results.respawns++
      console.log(`  [w${wi}] ⚠ worker crashed (${(e.message || '').slice(0, 60)}) — respawning`)
      try { if (WORKERS > 1) await workersArr[wi].page?.close().catch(() => {}) } catch { /* ignore */ }
      let ok = false
      for (let a = 0; a < 4 && !ok && !stopRequested; a++) { try { workersArr[wi] = await spawn(wi, WORKERS === 1); ok = true } catch (se) { console.log(`  [w${wi}] respawn attempt ${a + 1} failed: ${(se.message || '').slice(0, 50)}`); await sleep(4000) } }
      if (!ok) { console.log(`  [w${wi}] ✗ could not respawn — worker retiring (others continue)`); return }
    }
  }
}

// ── heartbeat: queue mode renews every lease + reports each worker to the roster; stop is shared ──
async function queueHeartbeat(state = 'running') {
  await Promise.all(workerIds.map((w, wi) => qapi({ action: 'renew', worker: w, leaseSec: LEASE_SEC, host: hostname(), account: ACCOUNT_LABEL, live: !DRY, currentSlip: wstats[wi].current, placed: wstats[wi].placed, failed: wstats[wi].failed, state }, 2)
    .then(j => { if (j.stop) stopRequested = true }).catch(() => { /* next beat retries; lease is 3× the beat */ })))
}
async function releaseAll(state) {
  if (!QUEUE) return
  await Promise.all(workerIds.map(w => qapi({ action: 'release', worker: w, state }, 3).catch(() => {})))
}
let released = false
const onSignal = async (sig) => { if (released) return; released = true; console.log(`\n${sig}: handing this PC's unsubmitted slips back to the queue…`); stopRequested = true; await releaseAll('stopped'); process.exit(130) }
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)

// ── auto-verify: slips whose worker vanished MID-SUBMIT are checked against bet history FIRST ──
async function verifyFromHistory() {
  const j = await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}/verify`).then(r => r.json()).catch(() => null)
  const pending = j?.slips ?? []
  if (!pending.length) return
  console.log(`verification: ${pending.length} slip(s) were mid-submit when their worker vanished — checking bet history…`)
  const page = await ctx.newPage()
  const orders = []
  // Capture every JSON the bet-history page loads and pull out anything that looks like an order: an
  // object holding a list of selections with sr:match event ids (+ an id and a time when present).
  const harvest = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return
    if (Array.isArray(node)) { for (const x of node) harvest(x, depth + 1); return }
    const text = JSON.stringify(node)
    const events = [...new Set([...text.matchAll(/sr:match:(\d+)/g)].map(m => Number(m[1])))]
    const idField = node.orderId ?? node.shortId ?? node.betId ?? node.ticketId
    const time = node.createTime ?? node.createdTime ?? node.betTime ?? node.orderTime
    if (events.length && (idField || time) && text.length < 60_000) { orders.push({ id: idField ? String(idField) : null, time: typeof time === 'number' ? time : Date.parse(time) || null, events: new Set(events) }); return }
    for (const v of Object.values(node)) harvest(v, depth + 1)
  }
  page.on('response', async res => { if (!/json/.test(res.headers()['content-type'] || '')) return; try { harvest(await res.json()) } catch { /* ignore */ } })
  try {
    for (const url of ['https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10', 'https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=0']) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
      await page.waitForTimeout(8000)
    }
  } finally { await page.close().catch(() => {}) }
  const oldest = Math.min(...orders.map(o => o.time ?? Infinity))
  console.log(`  bet history: ${orders.length} order record(s) read`)
  for (const v of pending) {
    const want = new Set((v.legs ?? []).filter(l => !l.suspended).map(l => Number(l.fixtureId)))
    const hit = orders.find(o => o.events.size === want.size && [...want].every(id => o.events.has(id)))
    if (hit) {
      await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slipId: v.slipId, placed: true, betId: hit.id, note: 'found on bet history' }) }).catch(() => {})
      console.log(`  slip ${v.slipId}: ✓ found on bet history${hit.id ? ` (${hit.id})` : ''} → recorded as placed`)
    } else if (orders.length && Number.isFinite(oldest) && v.submitStartedAt && oldest < Date.parse(v.submitStartedAt) - 60_000) {
      // history reaches back BEFORE the submit started and the slip is not in it → it was not placed
      await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slipId: v.slipId, placed: false, note: 'not on bet history (history covers the submit time)' }) }).catch(() => {})
      console.log(`  slip ${v.slipId}: ✗ not on bet history → returned to the queue`)
    } else console.log(`  slip ${v.slipId}: ? could not decide from bet history — left for you to resolve on the session page`)
  }
}

if (QUEUE && !DRY) { try { await verifyFromHistory() } catch (e) { console.log(`verification skipped: ${(e.message || '').slice(0, 80)}`) } }

if (QUEUE) await queueHeartbeat(); else await heartbeat()   // immediate, so the UI flips to "running" at once
const hbTimer = setInterval(() => { if (QUEUE) void queueHeartbeat(); else void heartbeat() }, 10000)
try { await Promise.all(workersArr.map((_, wi) => supervise(wi))) }
finally {
  clearInterval(hbTimer)
  await releaseAll(stopRequested ? 'stopped' : 'done'); released = true
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDONE in ${secs}s — placed ${results.placed}, skipped ${results.skip}, suspended ${results.suspended}, retried ${results.retried}, failed ${results.failed}, to-verify ${results.verify}, lease-lost ${results.lost}, respawns ${results.respawns}${DRY ? `, dry ${results.dry}` : ''}`)
if (!QUEUE && fileQueue.length) console.log(`  ${fileQueue.length} slip(s) left unplaced (stopped/retired).`)
if (QUEUE && stopRequested) console.log('  stopped — unsubmitted slips are back in the shared queue; any PC can continue.')
// Exit promptly. Something (a CDP handle) kept the process — and its Chrome lock — alive ~130s after DONE
// (measured 2026-09-26), so the next run on this window couldn't start. Nothing is pending by now.
await Promise.race([browser.close().catch(() => {}), sleep(3000)])
process.exit(0)
