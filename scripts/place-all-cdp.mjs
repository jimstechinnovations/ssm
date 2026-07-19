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

  const clearSlip = async () => {
    for (let i = 0; i < 9; i++) {
      if (await codeBoxVisible()) return
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

    const liveState = await page.evaluate(() => {
      const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]
      const t = p ? p.innerText : ''
      return { suspended: /suspended|unavailable|not available|market closed/i.test(t), acceptChanges: /accept chang/i.test(t) }
    })
    if (liveState.suspended) { log('  ⏭ SUSPENDED leg — skipping'); return { result: 'suspended', code } }
    // NOTE: "Accept Changes" is NOT a separate blocker — it's the SAME primary green button relabelled
    // when odds move. Clicking it accepts the new price and relabels back to "Place Bet". So the place/
    // confirm clickers below just target that button by EITHER label; clicking it repeatedly walks
    // Accept Changes → Place Bet → About-to-pay even if the price keeps shifting.

    const clickPlace = async (useLeaf) => {
      if (useLeaf) return clickLeaf('^(place bet|accept changes)$')
      const btn = page.locator('.m-btn-wrapper, button.af-button', { hasText: /place bet|accept chang/i }).first()
      if (await btn.count()) { await btn.click({ force: true, timeout: 4000 }).catch(() => {}); return true }
      return clickLeaf('^(place bet|accept changes)$')
    }
    const clickConfirm = async (useLeaf) => {
      if (useLeaf) return clickLeaf('^(confirm|accept changes)$')
      const btn = page.locator('.es-dialog-btn, [class*=dialog-btn], .m-btn-wrapper', { hasText: /^confirm$|accept chang/i }).first()
      if (await btn.count()) { await btn.click({ force: true, timeout: 4000 }).catch(() => {}); return true }
      return clickLeaf('^(confirm|accept changes)$')
    }

    // ── serialize the actual submission so concurrent workers never collide ──
    const release = await acquireSubmit()
    let placed = false, how = ''
    try {
      await page.bringToFront().catch(() => {})   // active tab paints reliably for the Place/Confirm clicks
      let dialog = false
      for (let a = 1; a <= 6 && !dialog; a++) {
        await clickPlace(a % 2 === 1)
        for (let p = 0; p < 10 && !dialog; p++) { await sleep(300); dialog = await bodyHas(/about to pay/) }
      }
      if (!dialog) throw new Error('Place Bet (CDP) did not open the About-to-pay dialog')

      for (let a = 1; a <= 5 && !placed; a++) {
        await clickConfirm(a % 2 === 1)
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
      return { result: 'placed', code }
    }
    throw new Error('not confirmed (no success signal); check Bet History')
  }

  return { placeOne, ensureLoggedIn, ensureRealView, prep: async () => { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(3000); await ensureLoggedIn(); await ensureRealView() } }
}

// ── set up N tabs in the one logged-in session ──
// Serial (1 worker) reuses the existing tab; parallel opens FRESH tabs (a fresh tab has an empty
// betslip → clean start, whereas the base tab can carry a dirty/loaded betslip that stalls clearSlip).
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const pages = []
if (WORKERS === 1) {
  let base = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
  if (!base) { base = await ctx.newPage(); await base.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
  pages.push(base)
} else {
  for (let w = 0; w < WORKERS; w++) {
    const p = await ctx.newPage()
    await p.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }).catch(() => {})
    pages.push(p)
  }
}

const parallel = WORKERS > 1
const workers = pages.map((p, w) => makeWorker(p, WORKERS > 1 ? `  [w${w}] ` : '  ', parallel))
await Promise.all(workers.map(w => w.prep()))

// round-robin partition so load stays balanced even if some slips retry
const MAX_TRIES = flag('--retries', 3)   // auto-retry a failed slip in-run before giving up
const queues = Array.from({ length: WORKERS }, () => [])
slips.forEach((s, i) => queues[i % WORKERS].push({ slip: s, idx: i + 1, tries: 0 }))

console.log(`\nCDP BATCH: ${slips.length} slip(s) · ${WORKERS} worker(s) · pacing ${MIN}-${MAX}s · retries ${MAX_TRIES - 1}${DRY ? ' · DRY-RUN' : ''}\n`)
const results = { placed: 0, skip: 0, dry: 0, suspended: 0, failed: 0, retried: 0 }
const t0 = Date.now()

async function runWorker(worker, queue) {
  while (queue.length) {
    if (stopRequested) { console.log(`  [stopped] worker halting — ${queue.length} slip(s) left unplaced (resume later)`); break }
    const { slip, idx, tries } = queue.shift()
    const sid = slip.slipId
    try {
      const { result: r, code } = await worker.placeOne(slip, idx)
      if (r === 'placed') { results.placed++; wrongSlipStreak = 0; if (!DRY) await report(sid, 'placed', { bookingCode: code }) }
      else if (r === 'skip') { results.skip++; wrongSlipStreak = 0; if (!DRY && code) await report(sid, 'placed', { bookingCode: code }) } // already placed → ensure code persisted
      else if (r === 'suspended') { results.suspended++; if (!DRY) await report(sid, 'skipped', { failureReason: 'suspended leg' }) }
      else results.dry++
    } catch (e) {
      // AUTO-RETRY: transient failures (odds change, click timeout, betslip not loaded) usually clear on a
      // retry. Re-queue the slip (idempotency skips it if it actually placed) up to MAX_TRIES before giving
      // up — so workers self-heal without a manual requeue.
      if (tries + 1 < MAX_TRIES && !stopRequested) {
        results.retried++; queue.push({ slip, idx, tries: tries + 1 })
        console.log(`  slip ${idx}: retry ${tries + 1}/${MAX_TRIES - 1} — ${e.message.slice(0, 80)}`)
      } else {
        results.failed++; console.log(`  slip ${idx}: FAILED (after ${tries + 1} tries) — ${e.message}`)
        if (!DRY) await report(sid, 'failed', { failureReason: e.message.slice(0, 200) })
      }
      // CIRCUIT BREAKER: shorter slips now PLACE (suspended legs are fine). We only halt when slips load
      // EMPTY/stale repeatedly — the betslip isn't loading at all (browser wedged) or every game died.
      if (/empty\/invalid|stale/i.test(e.message)) { if (++wrongSlipStreak >= 8) { stopRequested = true; console.log(`\n⛔ CIRCUIT BREAKER: ${wrongSlipStreak} consecutive empty/stale betslips — the betslip isn't loading (browser wedged?) or all games died. Halting.\n`) } }
      else wrongSlipStreak = 0
    }
    if (queue.length) await sleep(rand(MIN, MAX) * 1000)
  }
}

await Promise.all(workers.map((w, i) => runWorker(w, queues[i])))
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDONE in ${secs}s — placed ${results.placed}, skipped ${results.skip}, suspended ${results.suspended}, retried ${results.retried}, failed ${results.failed}${DRY ? `, dry ${results.dry}` : ''}`)
await browser.close()
