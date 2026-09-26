import { chromium } from 'playwright'
const out = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1000)
const sb = await page.evaluate(() => {
  const s = document.querySelector('.switch-box')
  if (s) s.scrollIntoView({block:'center'})
  return s ? { html: s.outerHTML.slice(0,600), text: s.innerText } : null
})
console.log('switch-box:', JSON.stringify(sb))
await page.waitForTimeout(600)
await page.screenshot({ path: out + '/cdp-toggle2.png' })
console.log('full shot saved')
await browser.close()
