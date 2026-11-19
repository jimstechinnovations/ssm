import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.waitForTimeout(500)
const info = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')].map(cb => ({
    checked: cb.checked,
    nearbyText: cb.closest('label, div')?.textContent?.trim().slice(0, 40) || cb.parentElement?.textContent?.trim().slice(0, 40),
  }))
  return boxes
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
