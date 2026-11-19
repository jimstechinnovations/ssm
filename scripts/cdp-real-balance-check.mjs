import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
const state = await page.evaluate(() => {
  const headerText = document.querySelector('header, [class*=header]')?.innerText || ''
  const bal = headerText.match(/NGN\s*([\d,.]+)/)?.[1] ?? null
  const l = document.querySelector('[data-op=switch-box-left]'), s = document.querySelector('[data-op=switch-box-right]')
  const toggle = (!l && !s) ? 'none' : /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
  return { bal, toggle, headerText: headerText.slice(0, 200) }
})
console.log(JSON.stringify(state, null, 1))
await browser.close()
