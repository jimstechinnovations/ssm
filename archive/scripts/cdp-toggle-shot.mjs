import { chromium } from 'playwright'
const out = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1000)
// scroll the betslip panel to the very top so REAL/SIM shows
await page.evaluate(() => {
  const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a,b)=>b.offsetHeight-a.offsetHeight)[0]
  if (p) p.scrollTop = 0
  const sb = document.querySelector('.switch-box'); if (sb) sb.scrollIntoView({block:'center'})
})
await page.waitForTimeout(800)
// clip to the betslip column (right side)
await page.screenshot({ path: out + '/cdp-toggle.png', clip: { x: 1180, y: 120, width: 380, height: 400 } })
// also read the switch-box outerHTML
const html = await page.evaluate(() => document.querySelector('.switch-box')?.outerHTML?.slice(0,500))
console.log('switch-box HTML:', html)
await browser.close()
