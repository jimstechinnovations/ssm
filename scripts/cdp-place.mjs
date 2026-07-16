/**
 * scripts/cdp-place.mjs — place the loaded SportyBet slip via the genuine CDP session, at a given
 * stake, ONLY if the betslip is truly in REAL mode and the balance is real (not SIM play-money).
 * Human-like mouse. Truth-confirmed by a real balance drop. User-authorized per placement.
 * Run: node scripts/cdp-place.mjs <stake>
 */
import { chromium } from 'playwright'
const stake = process.argv[2] ?? '10'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { console.error('no SportyBet tab'); process.exit(1) }
await page.bringToFront(); await page.waitForTimeout(1200)

const bal = async () => { const m=(await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g,'')) : NaN }
const realActive = () => page.evaluate(() => {
  const sb = document.querySelector('.switch-box'); if (!sb) return true // no toggle = real sportsbook
  const real = sb.querySelector('[data-op=switch-box-left]'); const sim = sb.querySelector('[data-op=switch-box-right]')
  return /show-highlight/.test(real?.className||'') || !/show-highlight/.test(sim?.className||'')
})

// ── guards ──
// The REAL/SIM class heuristic is unreliable on SportyBet's custom slider, so it's advisory only.
// The AUTHORITATIVE check is the balance: (1) it must be real-account-sized (not SIM 100k+), and
// (2) after placing, the real balance must drop by the stake — otherwise it wasn't a real bet.
const real = await realActive().catch(() => null)
const before = await bal()
console.log('REAL-toggle heuristic (advisory):', real, '| balance:', before)
if (!(before <= 1000)) { console.error(`ABORT: balance ₦${before} looks like SIM play-money, not your real account.`); await browser.close(); process.exit(3) }

// ── set stake ──
const stakeBox = page.locator('input[placeholder^="min."]').first()
if (!(await stakeBox.count())) { console.error('ABORT: stake box not found'); await browser.close(); process.exit(4) }
await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(String(stake), { delay: 90 })
await page.waitForTimeout(1500)
const slipText = await page.evaluate(() => { const p=[...document.querySelectorAll('[class*=betslip]')].filter(e=>e.offsetHeight).sort((a,b)=>b.innerText.length-a.innerText.length)[0]; return p?p.innerText:'' })
console.log('betslip stake/odds:', slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1], '/', slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1], '| potential:', slipText.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1])
if (parseFloat((slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1]||'0').replace(/,/g,'')) !== Number(stake)) {
  console.error('ABORT: stake did not set to', stake); await browser.close(); process.exit(5)
}

// ── place: human-like move to Place Bet + click ──
const place = page.locator('button.af-button:visible, [class*=place]', { hasText: /place bet/i }).first()
const box = await place.boundingBox()
if (!box) { console.error('ABORT: Place Bet not found'); await browser.close(); process.exit(6) }
await page.mouse.move(box.x+box.width/2-30, box.y+box.height/2+12, { steps: 10 }); await page.waitForTimeout(180)
await page.mouse.move(box.x+box.width/2, box.y+box.height/2, { steps: 6 }); await page.waitForTimeout(120)
await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
console.log('clicked Place Bet')
await page.waitForTimeout(3000)
for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
  const b = page.locator('button:visible', { hasText: re }).first()
  if (await b.count()) { console.log('confirm dialog:', re.source); await b.click().catch(()=>{}); await page.waitForTimeout(3000) }
}

// ── truth-confirm: balance must drop by ~stake ──
let after = before
for (let i=0;i<10;i++){ await page.waitForTimeout(2500); after = await bal(); if (Math.abs((before-after)-Number(stake))<=0.5) break }
console.log('balance after:', after, '| dropped:', (before-after).toFixed(2))
if (Math.abs((before-after)-Number(stake))<=0.5) console.log('*** REAL BET PLACED & CONFIRMED — ₦'+stake+' deducted ('+before+' -> '+after+') ***')
else console.log('NOT confirmed — balance did not drop by ₦'+stake+'. Check the window / Bet History.')
await browser.close()
