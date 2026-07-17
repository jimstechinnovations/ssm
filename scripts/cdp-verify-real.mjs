// scripts/cdp-verify-real.mjs — did our placements hit REAL or SIM? Read fresh balance + REAL bet history.
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = await ctx.newPage()
await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)
const bal = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
console.log('FRESH balance (header):', bal)

// REAL bet history (isSettled=10 = open/unsettled). SIM history is a different toggle.
await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(8000)
const text = await page.evaluate(() => document.body.innerText)
const codes = ['GTBK4B', 'UE14LC', 'K8K0NG', 'TECTER', 'W5DAUD', 'TV253B', 'VUCTHH']
console.log('\ncodes present in REAL bet history:')
for (const c of codes) console.log(`  ${c}: ${text.includes(c) ? 'YES' : 'no'}`)
const bets = (text.match(/Booking Code|Bet ID|Order ID/gi) || []).length
console.log('\nbet-history entries seen:', bets)
console.log('\n--- history head ---')
console.log(text.slice(0, 1200))
await page.close()
await browser.close()
