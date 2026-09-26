/**
 * scripts/cdp-place2.mjs — properly-targeted CDP placement: scroll Place Bet into view, use
 * locator.click() (auto-scrolls + clicks true center), confirm by real balance drop. ₦-authorized.
 */
import { chromium } from 'playwright'
const stake = process.argv[2] ?? '10'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1200)

const bal = async () => { const m=(await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m?parseFloat(m[1].replace(/,/g,'')):NaN }
const before = await bal()
console.log('balance before:', before)
if (!(before <= 1000)) { console.error('ABORT: SIM-sized balance'); await browser.close(); process.exit(3) }

// re-set stake to be sure
const stakeBox = page.locator('input[placeholder^="min."]').first()
await stakeBox.scrollIntoViewIfNeeded().catch(()=>{})
await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(String(stake), { delay: 90 })
await page.waitForTimeout(1200)
const st = await page.evaluate(() => { const p=[...document.querySelectorAll('[class*=betslip]')].filter(e=>e.offsetHeight).sort((a,b)=>b.innerText.length-a.innerText.length)[0]; return p?p.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1]:'' })
console.log('stake set to:', st)

// PROPERLY targeted Place Bet: locator scrolls into view + clicks true center
const place = page.getByText(/^Place Bet$/i).first()
const cnt = await place.count()
console.log('Place Bet elements:', cnt)
await place.scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
const box = await place.boundingBox()
console.log('Place Bet box after scroll:', JSON.stringify(box))
await place.click({ timeout: 8000 }).catch(async e => { console.log('locator click failed:', e.message.slice(0,80)); })
console.log('clicked Place Bet (targeted)')
await page.waitForTimeout(3000)
for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
  const b = page.locator('button:visible, [class*=btn]:visible', { hasText: re }).first()
  if (await b.count()) { console.log('dialog:', re.source); await b.click().catch(()=>{}); await page.waitForTimeout(3000) }
}
let after=before
for (let i=0;i<10;i++){ await page.waitForTimeout(2500); after=await bal(); if (Math.abs((before-after)-Number(stake))<=0.5) break }
console.log('balance after:', after, '| dropped', (before-after).toFixed(2))
console.log(Math.abs((before-after)-Number(stake))<=0.5 ? '*** REAL BET PLACED & CONFIRMED ***' : 'NOT confirmed (balance unchanged)')
await browser.close()
