import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(6000)
const unsettled = page.locator('text=/^Unsettled$/i').first()
if (await unsettled.count()) { await unsettled.click(); await page.waitForTimeout(3000) }
// click into each "Running" entry to see cashout offer
const rows = page.locator('text=/^Running$/i')
const n = await rows.count()
console.log(`${n} running entries found`)
for (let i = 0; i < Math.min(n, 4); i++) {
  await rows.nth(i).click()
  await page.waitForTimeout(3000)
  const text = await page.evaluate(() => document.body.innerText)
  const cashoutMatch = text.match(/Cash ?[Oo]ut[^\n]*\n?[^\n]*NGN?\s*[\d,.]+|Cashout[\s\S]{0,120}/)
  console.log(`\n--- entry ${i} ---`)
  console.log(text.slice(0, 900))
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(2500)
}
await browser.close()
