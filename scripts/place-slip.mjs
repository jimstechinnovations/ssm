/**
 * scripts/place-slip.mjs — ONE-COMMAND SportyBet placement the USER runs.
 *
 *   node scripts/place-slip.mjs <bookingCode> <stake>
 *
 * Does the whole flow against the genuine .chrome-bot Chrome (CDP on :9222): load the booking code,
 * set the stake, then fire the two OS-level clicks (Place → Confirm) via scripts/os-click.ps1 —
 * genuine Windows input, which is what SportyBet actually accepts. Confirms by the real balance drop.
 *
 * Prereqs: run scripts/cdp-launch-chrome.ps1 once (dedicated Chrome on :9222, logged into SportyBet
 * REAL mode). Because the USER runs this, the real-money clicks are the user's own action.
 *
 * SAFETY: refuses if the balance looks like SIM play-money (> ₦1000); verifies the stake set
 * correctly before clicking; confirms placement by a real balance drop of ~stake.
 */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

const [code, stakeArg] = [process.argv[2], process.argv[3]]
const stake = Number(stakeArg ?? 10)
if (!code || !Number.isFinite(stake)) { console.error('usage: node scripts/place-slip.mjs <bookingCode> <stake>'); process.exit(1) }

// os-max maximizes once; os-click then foregrounds + ShowWindow(SW_MAXIMIZE) [no-op → scroll safe]
// + activates + clicks. The ShowWindow activation is what makes the synthetic click register.
const osClick = (x, y) => {
  console.log(`  → OS click (${x}, ${y})`)
  const out = execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/os-click.ps1', '-X', String(x), '-Y', String(y)], { encoding: 'utf8' })
  process.stdout.write('    ' + out.trim().replace(/\n/g, '\n    ') + '\n')
}
const osMax = () => execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/os-max.ps1'], { encoding: 'utf8' })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
await page.bringToFront(); await page.waitForTimeout(1200)

const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }

const before = await balNum()
console.log('balance before:', before)
if (!(before <= 1000)) { console.error(`ABORT: balance ₦${before} looks like SIM play-money, not your real account.`); await browser.close(); process.exit(3) }

// 1. reset the betslip to the Booking Code box — detect the real state, never click a pay Confirm.
const codeVisible = () => page.locator('input[placeholder="Booking Code"]:visible').count().then(n => n > 0)
const dlgBtn = (re) => page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]', { hasText: re }).first()
for (let i = 0; i < 6 && !(await codeVisible()); i++) {
  const st = await page.evaluate(() => {
    const vis = e => !!(e && (e.offsetWidth || e.offsetHeight))
    const wrap = [...document.querySelectorAll('.es-dialog-wrap, [class*=dialog-wrap]')].find(vis)
    const t = wrap ? wrap.innerText : ''
    return { pay: /about to pay|potential win/i.test(t), rm: /remove betslip|remove all items/i.test(t), hasRa: !!document.querySelector('[data-cms-key=remove_all]') }
  })
  if (st.pay) { const c = dlgBtn(/^cancel$/i); if (await c.count()) { await c.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); continue } }
  if (st.rm) { const o = dlgBtn(/^OK$/i); if (await o.count()) { await o.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); continue } }
  if (st.hasRa) { await page.locator('[data-cms-key=remove_all]:visible').first().click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); continue }
  await page.waitForTimeout(700)
}
const codeInput = page.locator('input[placeholder="Booking Code"]').first()
await codeInput.waitFor({ timeout: 15000 })
await codeInput.click(); await codeInput.type(code, { delay: 110 }); await page.waitForTimeout(1200)
await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
await page.waitForTimeout(6000)

// 2. set stake
const stakeBox = page.locator('input[placeholder^="min."]').first()
if (!(await stakeBox.count())) { console.error('ABORT: stake box not found (did the code load?)'); await browser.close(); process.exit(4) }
await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(String(stake), { delay: 90 })
await page.waitForTimeout(1500)

// helper: maximize, scroll the target into view, return its physical screen coords
// Assumes osMax() was called just before (window maximized+foreground); does not re-maximize.
const measure = async (kind) => {
  return page.evaluate((k) => {
    const vis = e => e && (e.offsetWidth * e.offsetHeight)
    const re = k === 'confirm' ? /^confirm$/i : /^place bet$/i
    const els = [...document.querySelectorAll('button,[class*=btn],[class*=confirm],[class*=place]')].filter(e => re.test((e.textContent || '').trim()) && vis(e))
    els.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))
    const btn = els[0]; if (!btn) return null
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    const physX = Math.round((window.screenX + r.left + r.width / 2) * window.devicePixelRatio)
    const physY = Math.round((window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2) * window.devicePixelRatio)
    return { physX, physY }
  }, kind)
}

// 3. verify stake, then Place
const st = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1] : '' })
console.log('stake set to:', st)
if (parseFloat((st || '0').replace(/,/g, '')) !== stake) { console.error('ABORT: stake did not set correctly'); await browser.close(); process.exit(5) }

osMax(); await new Promise(r => setTimeout(r, 900))   // foreground + maximize once
const place = await measure('place')
if (!place) { console.error('ABORT: Place Bet not found'); await browser.close(); process.exit(6) }
console.log('Place Bet at', place)
osClick(place.physX, place.physY)
await new Promise(r => setTimeout(r, 3500))

// 4. Confirm dialog
const confirm = await measure('confirm')
if (!confirm) { console.error('ABORT: Confirm dialog did not appear (nothing placed).'); await browser.close(); process.exit(7) }
console.log('Confirm at', confirm)
osClick(confirm.physX, confirm.physY)

// 5. confirm by real balance drop
let after = before
for (let i = 0; i < 12; i++) { await page.waitForTimeout(2500); after = await balNum(); if (Math.abs((before - after) - stake) <= 0.5) break }
console.log('balance after:', after, '| dropped', (before - after).toFixed(2))
if (Math.abs((before - after) - stake) <= 0.5) console.log(`*** PLACED & CONFIRMED — ₦${stake} on, balance ${before} → ${after} ***`)
else console.log('Balance did not drop by the stake — check Bet History (the betslip balance can read stale).')
await browser.close()
