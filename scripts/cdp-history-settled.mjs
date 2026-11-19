import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(6000)
const settled = page.locator('text=/^Settled$/i').first()
if (await settled.count()) { await settled.click(); await page.waitForTimeout(4000) }
const text = await page.evaluate(() => document.body.innerText)
console.log(text.slice(0, 3500))
await browser.close()
