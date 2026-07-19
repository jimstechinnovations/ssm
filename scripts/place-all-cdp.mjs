/**
 * scripts/place-all-cdp.mjs — PURE-CDP batch placement, now with PARALLEL workers.
 * A CDP click on Place Bet opens "About to pay" and a CDP click on Confirm fires the real
 * /orders/order — so each slip is: load code → stake → click Place → click Confirm.
 *
 *   node scripts/place-all-cdp.mjs <book.json> [--stake N] [--min S --max S] [--dry]
 *                                  [--workers N] [--report URL]
 *
 * --workers N opens N tabs in the SAME logged-in Chrome session and splits the slips round-robin
 * across them (≈N× faster). Prereq: dedicated Chrome on :9222, SportyBet logged in REAL.
 * Keeps: booking codes, stake set+verify, slip verification, idempotency, keepalive, and truth-based
 * confirmation via "Submission Successful" (balance-drop is unreliable when workers run concurrently).
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const bookPath = args.find(a => !a.startsWith('--'))
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d }
const DRY = args.includes('--dry')
const MIN = flag('--min', 1), MAX = flag('--max', 3)
const WORKERS = Math.max(1, flag('--workers', 1))
const LIMIT = flag('--limit', 0)   // place only the first N slips (0 = all) — for small live tests
const STAKE_OVERRIDE = args.includes('--stake') ? flag('--stake', NaN) : null
const REPORT = (i => i >= 0 ? args[i + 1] : null)(args.indexOf('--report'))
let stopRequested = false   // set when the session's Stop is hit (read from the report response)
let wrongSlipStreak = 0     // consecutive "wrong slip" failures → a game was suspended mid-run (circuit breaker)
async function report(slipId, status, extra = {}) {
  if (!REPORT || slipId == null) return
  try {
    const r = await fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slipId, status, live: !DRY, ...extra }) })
    const j = await r.json().catch(() => ({}))
    if (j?.stop) stopRequested = true
  } catch { /* best-effort */ }
}
if (!bookPath || !existsSync(bookPath)) { console.error('usage: node scripts/place-all-cdp.mjs <book.json> [--workers N --stake N --min S --max S --dry --report URL]'); process.exit(1) }

const raw = JSON.parse(readFileSync(bookPath, 'utf8'))
const book = raw.results ? raw.results.find(r => r.book)?.book : (raw.book ?? raw)
let slips = book?.slips ?? []
if (!slips.length) { console.error('no slips in book'); process.exit(1) }
if (LIMIT > 0) slips = slips.slice(0, LIMIT)

const LOG = '.placed-log.json'
const placedLog = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : {}
let saveChain = Promise.resolve()
const savePlaced = () => { saveChain = saveChain.then(() => { try { writeFileSync(LOG, JSON.stringify(placedLog, null, 2)) } catch { /* ignore */ } }); return saveChain } // serialize writes across workers

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (a, b) => Math.round(a + Math.random() * (b - a))

// Submit mutex: SportyBet rejects two orders submitted at the same instant ("Submission Failed").
// So the Place→Confirm step is serialized across workers — everything else (code, load, stake, verify)
// stays parallel. Only ~2s per slip is serial, so N workers still give a big speedup.
let submitLock = Promise.resolve()
async function acquireSubmit() { const prev = submitLock; let rel; submitLock = new Promise(r => (rel = r)); await prev; return rel }

async function bookingCode(legs) {
  const selections = legs.map(l => ({ eventId: `sr:match:${l.fixtureId}`, marketId: '18', specifier: `total=${l.line}`, outcomeId: l.side === 'Under' ? '13' : '12' }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, platform: 'web' }, body: JSON.stringify({ selections, shareType: 1 }) })
  const j = await r.json()
  if (j.bizCode !== 10000 || !j.data?.shareCode) throw new Error(`booking code failed (bizCode ${j.bizCode})`)
  return j.data.shareCode
}

/** All page-bound placement logic, bound to ONE tab. `parallel` disables the racy balance-drop confirm. */
function makeWorker(page, tag, parallel) {
  const log = (s) => console.log(`${tag}${s}`)
  const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
  const readBalance = async () => { for (let i = 0; i < 10; i++) { const b = await balNum(); if (!Number.isNaN(b)) return b; await sleep(1200) } return NaN }
  const bodyHas = re => page.evaluate(rs => new RegExp(rs, 'i').test(document.body.innerText), re.source)
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
      if (removeConfirm) { await page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]', { hasText: /^OK$/i }).first().click({ force: true }).catch(() => {}); await page.waitForTimeout(800); continue }
      const ra = page.locator('[data-cms-key=remove_all]:visible').first()
      if (await ra.count()) { await ra.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); continue }
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

  async function placeOne(slip, idx) {
    const stake = STAKE_OVERRIDE ?? slip.stake
    const code = await bookingCode(slip.legs)
    const legSig = slip.legs.map(l => `${l.fixtureId}:${l.outcome}`).sort().join('|')
    const idem = `sportybet|${stake}|${legSig}`
    if (placedLog[idem]?.placed) { log(`slip ${idx}: SKIP (already placed ${placedLog[idem].code})`); return { result: 'skip', code: placedLog[idem].code } }

    if (!(await ensureLoggedIn())) throw new Error('not logged in (keepalive failed)')
    const before = await readBalance()
    if (Number.isNaN(before)) throw new Error('balance unreadable (logged out?)')
    if (before < stake) throw new Error(`insufficient balance ₦${before} < ₦${stake}`)
    if (before > 100000) throw new Error(`balance ₦${before} looks like SIM play-money — check REAL/SIM toggle`)

    await clearSlip()
    const ci = page.locator('input[placeholder="Booking Code"]').first()
    await ci.waitFor({ timeout: 15000 }); await ci.click(); await ci.type(code, { delay: 60 }); await page.waitForTimeout(700)
    await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
    await page.locator('[class*=betslip] >> text=/Over\\/Under/i').first().waitFor({ timeout: 12000 }).catch(() => {})
    await page.waitForTimeout(1200)

    // System tab caps at 15 selections → "Note" dialog blocks everything. Dismiss + force Multiple.
    await page.evaluate(() => {
      const vis = e => e && (e.offsetWidth || e.offsetHeight)
      const note = [...document.querySelectorAll('[class*=dialog],[class*=modal]')].find(d => vis(d) && /cannot be over\s*\d+\s*selections under System/i.test(d.innerText))
      if (note) { const ok = [...note.querySelectorAll('button,span,div')].find(b => b.children.length === 0 && /^OK$/i.test((b.textContent || '').trim())); if (ok) ok.click() }
    })
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      const vis = e => e && (e.offsetWidth || e.offsetHeight)
      const mult = [...document.querySelectorAll('[class*=betslip] span,[class*=betslip] div')].find(e => e.children.length === 0 && /^Multiple$/i.test((e.textContent || '').trim()) && vis(e))
      if (mult) ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => mult.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })))
    })
    await page.waitForTimeout(800)

    const readStake = () => page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? (p.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1] || '') : '' })
    let stakeOk = false
    for (let a = 1; a <= 5 && !stakeOk; a++) {
      const sb = page.locator('input[placeholder^="min."]').first()
      await sb.waitFor({ timeout: 5000 }).catch(() => {})
      await sb.click({ clickCount: 3 }).catch(() => {}); await sb.press('Delete').catch(() => {}); await page.waitForTimeout(150)
      await sb.type(String(stake), { delay: 60 }); await page.waitForTimeout(600)
      if (parseFloat((await readStake() || '0').replace(/,/g, '')) === stake) stakeOk = true
    }
    if (!stakeOk) throw new Error(`could not set stake to ${stake}`)

    const betslipText = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText : '' })
    const loadedLegs = (betslipText.match(/Over\/Under/g) || []).length
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
    if (DRY) { log('  [dry] skipping Place/Confirm'); return { result: 'dry', code } }

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
    const droppedFixtures = slip.legs
      .filter(l => { const tm = l.game?.split(' vs ')[0]?.trim(); return tm && !finalText.includes(tm) })
      .map(l => l.fixtureId)
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

    // ── serialize the actual submission so concurrent workers never collide ──
    const release = await acquireSubmit()
    let placed = false, how = ''
    try {
      await page.bringToFront().catch(() => {})   // active tab paints reliably for the Place/Confirm clicks
      const betLegs = async () => page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? (p.innerText.match(/Over\/Under/g) || []).length : 0 })
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
        await clickBtn('^confirm$')
        for (let p = 0; p < 12 && !placed; p++) {
          await sleep(400)
          if (await successUp()) { placed = true; how = 'submission-successful'; break }
          if (await bodyHas(/submission failed|something went wrong/)) throw new Error('SportyBet rejected the submit (Submission Failed) — retry later')
          if (/insufficient|not enough|balance is/i.test(await page.evaluate(() => document.body.innerText))) throw new Error('SportyBet: balance insufficient')
          if (!parallel) { const after = await balNum(); if (Math.abs((before - after) - stake) <= 0.5) { placed = true; how = 'balance-drop'; break } }
        }
        if (!placed && !(await bodyHas(/about to pay/))) break
      }
    } finally { release() }
    await dismissSuccess()
    if (placed) {
      placedLog[idem] = { placed: true, code, how, at: new Date().toISOString(), stake }; savePlaced()
      log(`  ✓ PLACED (${how}) — code ${code}`)
      return { result: 'placed', code, droppedFixtures, placedLegs: slip.legs.length - droppedFixtures.length }
    }
    throw new Error('not confirmed (no success signal); check Bet History')
  }

  return { placeOne, ensureLoggedIn, ensureRealView, dismissBlockers, page, prep: async () => { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(3000); await ensureLoggedIn(); await ensureRealView() } }
}

// ── robust worker rig: SHARED queue, per-slip watchdog, crash-respawn supervisor ──
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const parallel = WORKERS > 1
const SPORTY = 'https://www.sportybet.com/ng/'
const MAX_TRIES = flag('--retries', 3)     // auto-retry a failed slip in-run before giving up
const SLIP_TIMEOUT_MS = flag('--slip-timeout', 150) * 1000   // watchdog: a wedged slip is retried, not hung

// Spawn one worker on its own tab (serial reuses the existing SportyBet tab; parallel opens fresh tabs
// so each has a clean betslip). Returns a prepped worker or throws.
async function spawn(wi, reuseBase) {
  let page
  if (reuseBase) { page = ctx.pages().find(p => /sportybet\.com/.test(p.url())); if (!page) { page = await ctx.newPage(); await page.goto(SPORTY, { waitUntil: 'domcontentloaded' }).catch(() => {}) } }
  else { page = await ctx.newPage(); await page.goto(SPORTY, { waitUntil: 'domcontentloaded' }).catch(() => {}) }
  const w = makeWorker(page, parallel ? `  [w${wi}] ` : '  ', parallel)
  await w.prep()
  return w
}
// A dead page/context/CDP error means the WORKER crashed (not the slip) — respawn it, don't fail the slip.
const workerDead = e => /Target closed|Session closed|browser has been closed|context was destroyed|Execution context|Protocol error|detached|crashed|WATCHDOG/i.test(e?.message || '')
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`WATCHDOG: ${label} exceeded ${ms / 1000}s`)), ms))])

const workersArr = []
for (let wi = 0; wi < WORKERS; wi++) workersArr.push(await spawn(wi, WORKERS === 1))

// SHARED queue: every worker pulls from one list, so a dying worker's in-flight slip is requeued and any
// other worker picks up the rest (nothing is stranded on a per-worker queue). .shift/.unshift are atomic
// in JS's single thread. Failed slips push back here up to MAX_TRIES.
const queue = slips.map((s, i) => ({ slip: s, idx: i + 1, tries: 0 }))
console.log(`\nCDP BATCH: ${slips.length} slip(s) · ${WORKERS} worker(s) · pacing ${MIN}-${MAX}s · retries ${MAX_TRIES - 1} · slip-watchdog ${SLIP_TIMEOUT_MS / 1000}s${DRY ? ' · DRY-RUN' : ''}\n`)
const results = { placed: 0, skip: 0, dry: 0, suspended: 0, failed: 0, retried: 0, respawns: 0 }
const t0 = Date.now()

// One worker's loop. On a WORKER crash it throws to the supervisor (which respawns + re-runs); on a SLIP
// failure it requeues/marks-failed and keeps going.
async function runWorker(wi) {
  while (queue.length && !stopRequested) {
    const item = queue.shift(); if (!item) break
    const { slip, idx, tries } = item
    const sid = slip.slipId
    try {
      const { result: r, code, droppedFixtures, placedLegs } = await withTimeout(workersArr[wi].placeOne(slip, idx), SLIP_TIMEOUT_MS, `slip ${idx}`)
      if (r === 'placed') { results.placed++; wrongSlipStreak = 0; if (!DRY) await report(sid, 'placed', { bookingCode: code, droppedFixtures, placedLegs }) }
      else if (r === 'skip') { results.skip++; wrongSlipStreak = 0; if (!DRY && code) await report(sid, 'placed', { bookingCode: code }) }
      else if (r === 'suspended') { results.suspended++; if (!DRY) await report(sid, 'skipped', { failureReason: 'suspended leg' }) }
      else results.dry++
    } catch (e) {
      // WORKER CRASH (page/CDP dead or watchdog): requeue THIS slip at the front, throw to supervisor to respawn.
      if (workerDead(e)) { queue.unshift(item); throw e }
      // SKIP (no retry): odds too volatile / emptied — retrying just loops.
      if (/^SKIP:/.test(e.message)) {
        results.skip++; wrongSlipStreak = 0; console.log(`  slip ${idx}: ⏭ ${e.message}`)
        if (!DRY) await report(sid, 'skipped', { failureReason: e.message.slice(0, 200) })
        if (queue.length) await sleep(rand(MIN, MAX) * 1000); continue
      }
      // AUTO-RETRY: transient failures clear on a retry; requeue to the SHARED queue (idempotency skips it
      // if it actually placed) up to MAX_TRIES, so any worker self-heals it.
      if (tries + 1 < MAX_TRIES && !stopRequested) {
        results.retried++; queue.push({ slip, idx, tries: tries + 1 })
        console.log(`  slip ${idx}: retry ${tries + 1}/${MAX_TRIES - 1} — ${e.message.slice(0, 80)}`)
      } else {
        results.failed++; console.log(`  slip ${idx}: FAILED (after ${tries + 1} tries) — ${e.message}`)
        if (!DRY) await report(sid, 'failed', { failureReason: e.message.slice(0, 200) })
      }
      if (/empty\/invalid|stale/i.test(e.message)) { if (++wrongSlipStreak >= 8) { stopRequested = true; console.log(`\n⛔ CIRCUIT BREAKER: ${wrongSlipStreak} consecutive empty/stale betslips — betslip not loading (browser wedged?) or all games died. Halting.\n`) } }
      else wrongSlipStreak = 0
    }
    if (queue.length) await sleep(rand(MIN, MAX) * 1000)
  }
}

// Supervisor: runs a worker; if it crashes, respawns a fresh tab (up to a few times) and resumes on the
// SHARED queue — so one wedged/closed tab never ends the run.
async function supervise(wi) {
  while (queue.length && !stopRequested) {
    try { await runWorker(wi); return }
    catch (e) {
      results.respawns++
      console.log(`  [w${wi}] ⚠ worker crashed (${(e.message || '').slice(0, 60)}) — respawning (${queue.length} slip(s) left)`)
      try { if (WORKERS > 1) await workersArr[wi].page?.close().catch(() => {}) } catch { /* ignore */ }
      let ok = false
      for (let a = 0; a < 4 && !ok && !stopRequested; a++) { try { workersArr[wi] = await spawn(wi, WORKERS === 1); ok = true } catch (se) { console.log(`  [w${wi}] respawn attempt ${a + 1} failed: ${(se.message || '').slice(0, 50)}`); await sleep(4000) } }
      if (!ok) { console.log(`  [w${wi}] ✗ could not respawn — worker retiring (others continue)`); return }
    }
  }
}

await Promise.all(workersArr.map((_, wi) => supervise(wi)))
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDONE in ${secs}s — placed ${results.placed}, skipped ${results.skip}, suspended ${results.suspended}, retried ${results.retried}, failed ${results.failed}, respawns ${results.respawns}${DRY ? `, dry ${results.dry}` : ''}`)
if (queue.length) console.log(`  ${queue.length} slip(s) left unplaced (stopped/retired) — click Resume to finish; already-placed are skipped.`)
await browser.close()
