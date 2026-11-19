import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.waitForTimeout(1000)
const unsettled = page.locator('text=/^Unsettled$/i').first()
if (await unsettled.count()) { await unsettled.click(); await page.waitForTimeout(4000) }
const text = await page.evaluate(() => document.body.innerText)
console.log('===UNSETTLED TAB===')
console.log(text.slice(600, 2200))
await browser.close()
