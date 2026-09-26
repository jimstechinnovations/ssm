import { chromium } from 'playwright'
const out = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/') }
await page.bringToFront(); await page.waitForTimeout(1500)
await page.screenshot({ path: out + '/cdp-betslip.png' })
console.log('shot saved')
await browser.close()
