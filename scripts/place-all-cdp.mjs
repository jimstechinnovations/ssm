/**
 * scripts/place-all-cdp.mjs — PURE-CDP batch placement. No OS clicks, no foreground juggling.
 * We proved a CDP click on Place Bet opens the "About to pay" dialog and a CDP click on Confirm
 * fires the real /orders/order request — so placement is just: load code → stake → click Place →
 * click Confirm, all via CDP. Fast, reliable, doesn't touch the physical cursor.
 *
 *   node scripts/place-all-cdp.mjs <book.json> [--stake N] [--min S --max S] [--dry]
 *
 * Prereq: dedicated Chrome on :9222 (scripts/cdp-launch-chrome.ps1), SportyBet logged in REAL.
 * Keeps: booking codes, stake set-and-verify, slip verification, idempotency, keepalive, and
 * truth-based confirmation via "Submission Successful".
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
const STAKE_OVERRIDE = args.includes('--stake') ? flag('--stake', NaN) : null
if (!bookPath || !existsSync(bookPath)) { console.error('usage: node scripts/place-all-cdp.mjs <book.json> [--stake N --min S --max S --dry]'); process.exit(1) }

const raw = JSON.parse(readFileSync(bookPath, 'utf8'))
const book = raw.results ? raw.results.find(r => r.book)?.book : (raw.book ?? raw)
const slips = book?.slips ?? []
if (!slips.length) { console.error('no slips in book'); process.exit(1) }

const LOG = '.placed-log.json'
const placedLog = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : {}
const savePlaced = () => writeFileSync(LOG, JSON.stringify(placedLog, null, 2))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (a, b) => Math.round(a + Math.random() * (b - a))

async function bookingCode(legs) {
  const selections = legs.map(l => ({ eventId: `sr:match:${l.fixtureId}`, marketId: '18', specifier: `total=${l.line}`, outcomeId: l.side === 'Under' ? '13' : '12' }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, platform: 'web' }, body: JSON.stringify({ selections, shareType: 1 }) })
  const j = await r.json()
  if (j.bizCode !== 10000 || !j.data?.shareCode) throw new Error(`booking code failed (bizCode ${j.bizCode})`)
  return j.data.shareCode
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
// refresh once so the balance/session is current (deposits don't reflect in a stale tab)
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForTimeout(4000)

const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
const bodyHas = re => page.evaluate(rs => new RegExp(rs, 'i').test(document.body.innerText), re.source)
const codeBoxVisible = () => page.locator('input[placeholder="Booking Code"]:visible').count().then(n => n > 0)

// CDP click a visible LEAF element by exact text (Place Bet, Confirm, Cancel are bare spans/divs)
const clickLeaf = (reSource) => page.evaluate((rs) => {
  const rx = new RegExp(rs, 'i')
  const els = [...document.querySelectorAll('span,div,a,button')].filter(e => e.children.length === 0 && rx.test((e.textContent || '').trim()) && (e.offsetWidth || e.offsetHeight))
  els.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight)) // smallest leaf = the label
  if (!els[0]) return false
  els[0].click(); return true
}, reSource)

const ensureLoggedIn = async () => {
  if (!Number.isNaN(await balNum())) return true
  const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
  if (!phone || !psd) return false
  console.log('    [keepalive] re-logging in…')
  for (let a = 1; a <= 2; a++) {
    await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(3000)
    const pb = page.locator('input[name=phone]').first()
    if (await pb.count()) { await pb.fill(phone.replace(/^\+?234/, '0')).catch(() => {}); await page.fill('input[name=psd]', psd).catch(() => {}); await page.locator('button.m-btn-login').first().click().catch(() => {}); await page.waitForTimeout(7000) }
    if (!Number.isNaN(await balNum())) { console.log('    [keepalive] OK'); return true }
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

const clearSlip = async () => {
  for (let i = 0; i < 7; i++) {
    if (await codeBoxVisible()) return
    if (await successUp()) { await dismissSuccess(); await page.waitForTimeout(500); continue }
    if (await bodyHas(/about to pay/)) { await clickLeaf('^cancel$'); await page.waitForTimeout(800); continue }
    const removeConfirm = await page.evaluate(() => { const w = [...document.querySelectorAll('.es-dialog-wrap,[class*=dialog-wrap]')].find(e => e.offsetWidth || e.offsetHeight); return w ? /remove betslip|remove all items/i.test(w.innerText) : false })
    if (removeConfirm) { await page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]', { hasText: /^OK$/i }).first().click({ force: true }).catch(() => {}); await page.waitForTimeout(800); continue }
    const ra = page.locator('[data-cms-key=remove_all]:visible').first()
    if (await ra.count()) { await ra.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); continue }
    // single-leg slips have no "Remove All" — click each leg's delete icon
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
  if (placedLog[idem]?.placed) { console.log(`  slip ${idx}: SKIP (already placed ${placedLog[idem].code})`); return 'skip' }

  if (!(await ensureLoggedIn())) throw new Error('not logged in (keepalive failed)')
  const before = await balNum()
  if (Number.isNaN(before)) throw new Error('balance unreadable (logged out?)')
  if (before < stake) throw new Error(`insufficient balance ₦${before} < ₦${stake}`)
  if (before > 100000) throw new Error(`balance ₦${before} looks like SIM play-money — check REAL/SIM toggle`)

  await clearSlip()
  const ci = page.locator('input[placeholder="Booking Code"]').first()
  await ci.waitFor({ timeout: 15000 }); await ci.click(); await ci.type(code, { delay: 60 }); await page.waitForTimeout(700)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.locator('[class*=betslip] >> text=/Over\\/Under/i').first().waitFor({ timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(1200)

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
  if (loadedLegs !== slip.legs.length) throw new Error(`wrong slip: ${loadedLegs} legs vs ${slip.legs.length} — NOT placing`)
  const firstTeam = slip.legs[0]?.game?.split(' vs ')[0]?.trim()
  if (firstTeam && !betslipText.includes(firstTeam)) throw new Error(`stale betslip (missing "${firstTeam}") — NOT placing`)

  console.log(`  slip ${idx}: code ${code} · ₦${stake} @ ${slip.combinedOdds?.toFixed?.(2) ?? '?'} · ${slip.legs.length} legs`)
  if (DRY) { console.log('    [dry] skipping Place/Confirm'); return 'dry' }

  // Live-betting guards: a SUSPENDED leg can't be placed (fail clearly, don't retry); a pure
  // odds-change shows "Accept Changes" — accept it and place at the current odds.
  const liveState = await page.evaluate(() => {
    const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]
    const t = p ? p.innerText : ''
    return { suspended: /suspended|unavailable|not available|market closed/i.test(t), acceptChanges: /accept chang/i.test(t) }
  })
  if (liveState.suspended) { console.log('    ⏭ SUSPENDED leg — unplaceable now, skipping'); return 'suspended' }
  if (liveState.acceptChanges) {
    console.log('    odds changed → accepting')
    await page.evaluate(() => { const b = [...document.querySelectorAll('span,div,button,a')].find(e => /accept chang/i.test((e.textContent || '').trim()) && (e.offsetWidth || e.offsetHeight)); if (b) b.click() })
    await sleep(1500)
  }

  // CDP click Place Bet → wait for "About to pay". Alternate click strategies (native leaf click
  // sometimes misses the handler; the Playwright button/wrapper click is more reliable), retry ~6×.
  const clickPlace = async (useLeaf) => {
    if (useLeaf) return clickLeaf('^place bet$')
    const btn = page.locator('.m-btn-wrapper, button.af-button', { hasText: /place bet/i }).first()
    if (await btn.count()) { await btn.click({ force: true, timeout: 4000 }).catch(() => {}); return true }
    return clickLeaf('^place bet$')
  }
  let dialog = false
  for (let a = 1; a <= 6 && !dialog; a++) {
    await clickPlace(a % 2 === 1)
    for (let p = 0; p < 10 && !dialog; p++) { await sleep(300); dialog = await bodyHas(/about to pay/) }
  }
  if (!dialog) throw new Error('Place Bet (CDP) did not open the About-to-pay dialog')

  // CDP click Confirm → wait for success. Same alternating strategy for reliability.
  const clickConfirm = async (useLeaf) => {
    if (useLeaf) return clickLeaf('^confirm$')
    const btn = page.locator('.es-dialog-btn, [class*=dialog-btn], .m-btn-wrapper', { hasText: /^confirm$/i }).first()
    if (await btn.count()) { await btn.click({ force: true, timeout: 4000 }).catch(() => {}); return true }
    return clickLeaf('^confirm$')
  }
  let placed = false, how = ''
  for (let a = 1; a <= 5 && !placed; a++) {
    await clickConfirm(a % 2 === 1)
    for (let p = 0; p < 12 && !placed; p++) {
      await sleep(400)
      if (await successUp()) { placed = true; how = 'submission-successful'; break }
      if (/insufficient|not enough|balance is/i.test(await page.evaluate(() => document.body.innerText))) throw new Error('SportyBet: balance insufficient')
      const after = await balNum()
      if (Math.abs((before - after) - stake) <= 0.5) { placed = true; how = 'balance-drop'; break }
    }
    if (!placed && !(await bodyHas(/about to pay/))) break // dialog closed without success — stop (don't re-open)
  }
  await dismissSuccess()
  if (placed) {
    placedLog[idem] = { placed: true, code, how, at: new Date().toISOString(), stake }; savePlaced()
    console.log(`    ✓ PLACED (${how}) — code ${code}`)
    return 'placed'
  }
  throw new Error('not confirmed (no success signal); check Bet History')
}

console.log(`\nCDP BATCH: ${slips.length} slip(s) · pacing ${MIN}-${MAX}s${DRY ? ' · DRY-RUN' : ''}\n`)
const results = { placed: 0, skip: 0, dry: 0, suspended: 0, failed: 0 }
const t0 = Date.now()
for (let i = 0; i < slips.length; i++) {
  try {
    const r = await placeOne(slips[i], i + 1)
    if (r === 'placed') results.placed++
    else if (r === 'skip') results.skip++
    else if (r === 'suspended') results.suspended++
    else results.dry++
  } catch (e) { results.failed++; console.log(`  slip ${i + 1}: FAILED — ${e.message}`) }
  if (i < slips.length - 1) await sleep(rand(MIN, MAX) * 1000)
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDONE in ${secs}s — placed ${results.placed}, skipped ${results.skip}, suspended ${results.suspended}, failed ${results.failed}${DRY ? `, dry ${results.dry}` : ''}`)
await browser.close()
