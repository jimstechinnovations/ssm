/**
 * scripts/place-all.mjs — BATCH place every slip in a PEDLA book, autonomously, via OS-level
 * Place+Confirm clicks. The USER runs this ONE command; it then stakes all N slips with human-like
 * mouse movement (os-click.ps1) and human pacing between them — no per-slip human touch.
 *
 *   node scripts/place-all.mjs <book.json> [--min N] [--max N] [--stake N] [--dry]
 *
 *   <book.json>  a PEDLA book (from /api/pedlas) — uses book.slips[].legs + .stake
 *   --min/--max  seconds between placements (human pacing); default 45..180
 *   --stake      override every slip's stake (else uses each slip's own stake)
 *   --dry        do everything EXCEPT the two OS clicks (rehearse load+stake+measure)
 *
 * Prereqs: scripts/cdp-launch-chrome.ps1 (dedicated Chrome on :9222, logged into SportyBet REAL).
 * Idempotent: a local .placed-log.json records placed booking codes so re-runs skip them.
 * Truth-based: each slip is "placed" only if the real balance drops by the stake.
 */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// load .env so the keepalive can re-login (SPORTY_NUMBER / SPORTY_PASSWORD)
if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const bookPath = args.find(a => !a.startsWith('--'))
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def }
const DRY = args.includes('--dry')
const FAST = args.includes('--fast')     // strip pacing + trim waits for volume (codes already carry selections)
const MIN = flag('--min', FAST ? 0 : 45), MAX = flag('--max', FAST ? 1 : 180)
const STAKE_OVERRIDE = args.includes('--stake') ? flag('--stake', NaN) : null
// SPEED scales the non-critical settle waits. FAST ≈ half; the site still needs SOME time to render.
const SPEED = FAST ? 0.5 : 1
const W = ms => Math.round(ms * SPEED)   // scaled wait
if (!bookPath || !existsSync(bookPath)) { console.error('usage: node scripts/place-all.mjs <book.json> [--fast] [--min N --max N --stake N --dry]'); process.exit(1) }

const raw = JSON.parse(readFileSync(bookPath, 'utf8'))
const book = raw.results ? raw.results.find(r => r.book)?.book : (raw.book ?? raw)
const slips = book?.slips ?? []
if (slips.length === 0) { console.error('no slips in book'); process.exit(1) }

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

// os-max maximizes once (so coords are measured in the maximized layout); os-click then
// foregrounds + ShowWindow(SW_MAXIMIZE) [no-op on an already-max window, so scroll is preserved]
// + activates + clicks. That ShowWindow is what makes the synthetic click actually register.
// NEVER throws — if os-click aborts (e.g. couldn't hold foreground), return its output so the
// caller's retry loop tries again instead of the whole slip dying.
const osClickOnly = (x, y) => { try { return execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/os-click.ps1', '-X', String(x), '-Y', String(y)], { encoding: 'utf8' }) } catch (e) { return ((e.stdout || '') + (e.stderr || '')).trim() || `os-click failed (exit ${e.status})` } }
const osMax = () => { try { return execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/os-max.ps1'], { encoding: 'utf8' }) } catch (e) { return `os-max failed (exit ${e.status})` } }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
await page.bringToFront(); await page.waitForTimeout(1200)

const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }

// Session keepalive: if the balance can't be read (logged out / expired), re-login with the env
// credentials so a multi-hour 1000-slip run survives a timeout. Login is CDP-clickable (only the
// final Place/Confirm need OS clicks). Returns true if logged in afterwards.
const ensureLoggedIn = async () => {
  if (!Number.isNaN(await balNum())) return true
  const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
  if (!phone || !psd) { console.log('    [keepalive] logged out and no SPORTY_NUMBER/PASSWORD in .env'); return false }
  console.log('    [keepalive] session dropped — re-logging in…')
  for (let a = 1; a <= 2; a++) {
    await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(W(3000))
    const pb = page.locator('input[name=phone]').first()
    if (await pb.count()) {
      await pb.fill(phone.replace(/^\+?234/, '0')).catch(() => {})
      await page.fill('input[name=psd]', psd).catch(() => {})
      await page.locator('button.m-btn-login').first().click().catch(() => {})
      await page.waitForTimeout(W(7000))
    }
    if (!Number.isNaN(await balNum())) { console.log('    [keepalive] re-login OK'); return true }
  }
  console.log('    [keepalive] re-login FAILED — check credentials / CAPTCHA')
  return false
}
// Measure a button's physical coords. The "Place Bet" button and the pay dialog's "Confirm" button
// are BARE elements (Confirm is a <span class="">), so match any visible LEAF element whose exact
// text is the label — not just <button>/[class*=btn].
const measure = async (kind) => {
  return page.evaluate((k) => {
    const vis = e => e && (e.offsetWidth * e.offsetHeight)
    const re = k === 'confirm' ? /^confirm$/i : /^place bet$/i
    const els = [...document.querySelectorAll('button, [class*=btn], [class*=confirm], [class*=place], span, div, a')]
      .filter(e => e.children.length === 0 && re.test((e.textContent || '').trim()) && vis(e))
    // prefer the smallest leaf (the actual clickable label, not a big wrapper)
    els.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight))
    const btn = els[0]; if (!btn) return null
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    return { physX: Math.round((window.screenX + r.left + r.width / 2) * window.devicePixelRatio),
             physY: Math.round((window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2) * window.devicePixelRatio) }
  }, kind)
}
// Reset the betslip to a clean state that shows the Booking Code box. Detect the ACTUAL state
// (real open dialog vs. a loaded slip) each iteration and act — never click a pay-dialog Confirm.
const codeBoxVisible = () => page.locator('input[placeholder="Booking Code"]:visible').count().then(n => n > 0)
const dlgBtn = (re) => page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]', { hasText: re }).first()

// Click a visible LEAF element by text via a native DOM click (works for dismissal actions like
// the pay dialog's Cancel, which is a bare <span>). NOT used for placement (that needs OS clicks).
const clickLeafByText = (reSource) => page.evaluate((rs) => {
  const rx = new RegExp(rs, 'i')
  const el = [...document.querySelectorAll('span,div,a,button')].find(e => e.children.length === 0 && rx.test((e.textContent || '').trim()) && (e.offsetWidth || e.offsetHeight))
  if (!el) return false
  el.click()
  return true
}, reSource)

const clearSlip = async () => {
  for (let i = 0; i < 7; i++) {
    if (await codeBoxVisible()) return
    const st = await page.evaluate(() => {
      const vis = e => !!(e && (e.offsetWidth || e.offsetHeight))
      const wrap = [...document.querySelectorAll('.es-dialog-wrap, [class*=dialog-wrap]')].find(vis)
      const wrapText = wrap ? wrap.innerText : ''
      return {
        payDialog: /about to pay/i.test(document.body.innerText),          // bare-span dialog (not a wrap)
        removeConfirm: /remove betslip|remove all items/i.test(wrapText),  // real es-dialog-wrap
        hasRemoveAll: !!document.querySelector('[data-cms-key=remove_all]'),
      }
    })
    if (await successUp()) { await dismissSuccess(); await page.waitForTimeout(800); continue } // "Submission Successful"
    if (st.payDialog) { await clickLeafByText('^cancel$'); await page.waitForTimeout(1000); continue }  // Cancel, NEVER Confirm
    if (st.removeConfirm) { const ok = dlgBtn(/^OK$/i); if (await ok.count()) { await ok.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); continue } }
    if (st.hasRemoveAll) { await page.locator('[data-cms-key=remove_all]:visible').first().click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); continue }
    console.log(`    [clear ${i}] pay=${st.payDialog} rmConfirm=${st.removeConfirm} hasRemoveAll=${st.hasRemoveAll}`)
    await page.waitForTimeout(700)
  }
  if (!(await codeBoxVisible())) throw new Error('could not reset betslip to the Booking Code box')
}

// The post-placement "Submission Successful" dialog. Dismiss it WITHOUT clicking "Check Bet History"
// (which navigates away): press Escape, then click a close/X/OK leaf if present.
const successUp = () => page.evaluate(() => /submission successful/i.test(document.body.innerText))
const dismissSuccess = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await successUp())) return
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      const vis = e => e && (e.offsetWidth || e.offsetHeight)
      // a close/X/OK control — never "Check Bet History"
      const el = [...document.querySelectorAll('[class*=close], [class*=icon-close], span, div, button, i')]
        .find(e => vis(e) && e.children.length === 0 && /^(ok|close|×|✕|✖|done)$/i.test((e.textContent || '').trim()))
      if (el) el.click()
      else { // click the mask/backdrop to dismiss
        const mask = [...document.querySelectorAll('[class*=mask], [class*=overlay], [class*=backdrop]')].find(vis)
        if (mask) mask.click()
      }
    })
    await page.waitForTimeout(700)
  }
}

async function placeOne(slip, idx) {
  const stake = STAKE_OVERRIDE ?? slip.stake
  const code = await bookingCode(slip.legs)
  const legSig = slip.legs.map(l => `${l.fixtureId}:${l.outcome}`).sort().join('|')
  const idem = `sportybet|${stake}|${legSig}`
  if (placedLog[idem]?.placed) { console.log(`  slip ${idx}: SKIP (already placed ${placedLog[idem].code})`); return 'skip' }

  if (!(await ensureLoggedIn())) throw new Error('not logged in and re-login failed (keepalive)')
  const before = await balNum()
  if (Number.isNaN(before)) throw new Error('balance unreadable — SportyBet may be logged out or the session expired')
  if (before < stake) throw new Error(`insufficient balance ₦${before} < stake ₦${stake}`)
  if (before > 1000) throw new Error(`balance ₦${before} looks like SIM play-money, not real — check the REAL/SIM toggle`)

  await clearSlip()
  const ci = page.locator('input[placeholder="Booking Code"]').first()
  await ci.waitFor({ timeout: 15000 }); await ci.click(); await ci.type(code, { delay: FAST ? 30 : 100 }); await page.waitForTimeout(W(1000))
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  // wait until the slip actually renders (leg present) rather than a fixed 5s
  await page.locator('[class*=betslip] >> text=/Over\\/Under/i').first().waitFor({ timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(W(1500))

  const readStake = () => page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? (p.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1] || '') : '' })

  // Set the stake ROBUSTLY: SportyBet's controlled input ignores fill(''); select-all + delete +
  // type, then VERIFY the betslip shows it. Retry up to 5× (default is often ₦100 — must overwrite).
  let stakeOk = false
  for (let a = 1; a <= 5 && !stakeOk; a++) {
    const sb = page.locator('input[placeholder^="min."]').first()
    await sb.waitFor({ timeout: 5000 }).catch(() => {})
    await sb.click({ clickCount: 3 }).catch(() => {})          // select all
    await sb.press('Delete').catch(() => {})
    await page.waitForTimeout(W(200))
    await sb.type(String(stake), { delay: FAST ? 40 : 90 })
    await page.waitForTimeout(W(800))
    const cur = parseFloat((await readStake() || '0').replace(/,/g, ''))
    if (cur === stake) stakeOk = true
    else process.stdout.write(`    [stake retry ${a}] site shows ${cur}, want ${stake}\n`)
  }
  if (!stakeOk) throw new Error(`could not set stake to ${stake} (site kept a different value)`)

  // Verify the RIGHT slip is loaded (guards against a stale/leftover betslip): exact leg count + a team.
  const betslipText = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText : '' })
  const loadedLegs = (betslipText.match(/Over\/Under/g) || []).length
  if (loadedLegs !== slip.legs.length) throw new Error(`wrong slip loaded: ${loadedLegs} legs on site vs ${slip.legs.length} expected — NOT placing`)
  const firstTeam = slip.legs[0]?.game?.split(' vs ')[0]?.trim()
  if (firstTeam && !betslipText.includes(firstTeam)) throw new Error(`loaded slip does not contain "${firstTeam}" — stale betslip, NOT placing`)

  // foreground + maximize ONCE, then measure + click
  osMax(); await page.waitForTimeout(W(800))
  const place = await measure('place'); if (!place) throw new Error('Place Bet not found')
  console.log(`  slip ${idx}: code ${code} · ₦${stake} @ ${slip.combinedOdds?.toFixed?.(2) ?? '?'} · Place ${place.physX},${place.physY}`)
  if (DRY) { console.log('    [dry] skipping the two OS clicks'); return 'dry' }

  // The first click on a just-foregrounded window is consumed by activation (button reacts but
  // doesn't fire), so click Place until the REAL "About to pay" dialog appears — detected by body
  // text (the dialog is NOT a .es-dialog-wrap). Stop the instant it's up so extra clicks can't
  // dismiss it.
  const payDialogUp = () => page.evaluate(() => /about to pay/i.test(document.body.innerText))
  let conf = null
  for (let attempt = 1; attempt <= 6 && !conf; attempt++) {
    if (await payDialogUp()) { conf = await measure('confirm'); break }
    if (attempt > 1) { osMax(); await sleep(W(400)) }   // re-assert foreground before retrying
    process.stdout.write(`    place#${attempt} ` + osClickOnly(place.physX, place.physY).trim() + '\n')
    // poll for the dialog quickly instead of a fixed long sleep
    for (let p = 0; p < 8 && !(await payDialogUp()); p++) await sleep(W(400))
    if (await payDialogUp()) conf = await measure('confirm')
  }
  if (!conf) throw new Error('Confirm dialog did not appear after 6 place clicks')
  process.stdout.write(`    pay dialog up → confirm at ${conf.physX},${conf.physY}\n`)
  // Confirm can also lose the first click to activation — click until the "about to pay" dialog
  // disappears (which means Confirm registered). Stop immediately so no stray click lands after.
  for (let c = 1; c <= 5; c++) {
    if (c > 1) { osMax(); await sleep(W(400)) }
    process.stdout.write(`    confirm#${c} ` + osClickOnly(conf.physX, conf.physY).trim() + '\n')
    let gone = false
    for (let p = 0; p < 8 && !gone; p++) { await sleep(W(400)); gone = !(await payDialogUp()) }
    if (gone) break
  }

  // Confirm placement by SportyBet's own signal: the "Submission Successful" dialog (authoritative;
  // the header balance reads stale while that dialog covers it), or a real balance drop as backup.
  let placed = false, after = before, how = ''
  for (let i = 0; i < 20; i++) {
    await sleep(W(600))
    const body = await page.evaluate(() => document.body.innerText)
    if (/submission successful|bet placed|ticket id|your bet/i.test(body)) { placed = true; how = 'submission-successful'; break }
    after = await balNum()
    if (Math.abs((before - after) - stake) <= 0.5) { placed = true; how = 'balance-drop'; break }
  }
  // dismiss the success dialog so the NEXT slip starts from a clean betslip
  await dismissSuccess()
  if (placed) {
    placedLog[idem] = { placed: true, code, how, at: new Date().toISOString(), stake, balanceBefore: before }; savePlaced()
    console.log(`    ✓ PLACED (${how}) — code ${code}`)
    return 'placed'
  }
  throw new Error(`not confirmed (no success dialog, balance ${before} → ${after}); check Bet History`)
}

console.log(`\nBATCH: ${slips.length} slip(s) · pacing ${MIN}-${MAX}s${DRY ? ' · DRY-RUN' : ''}\n`)
const results = { placed: 0, skip: 0, dry: 0, failed: 0 }
for (let i = 0; i < slips.length; i++) {
  try { const r = await placeOne(slips[i], i + 1); results[r === 'placed' ? 'placed' : r === 'skip' ? 'skip' : 'dry']++ }
  catch (e) { results.failed++; console.log(`  slip ${i + 1}: FAILED — ${e.message}`) }
  if (i < slips.length - 1) { const d = rand(MIN, MAX); console.log(`  … pacing ${d}s before next\n`); await sleep(d * 1000) }
}
console.log(`\nDONE — placed ${results.placed}, skipped ${results.skip}, failed ${results.failed}${DRY ? `, dry ${results.dry}` : ''}`)
await browser.close()
