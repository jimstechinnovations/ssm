import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1000)
const boxes = await page.evaluate(() => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
  return [...document.querySelectorAll('.switch-box')].map((sb,i) => {
    const real = sb.querySelector('[data-op=switch-box-left]'); const sim = sb.querySelector('[data-op=switch-box-right]')
    return { i, visible: vis(sb), realCls: real?.className, simCls: sim?.className }
  })
})
console.log(JSON.stringify(boxes, null, 1))
await browser.close()
