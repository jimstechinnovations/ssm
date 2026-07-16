import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const hp = await ctx.newPage()
await hp.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10', { waitUntil: 'domcontentloaded', timeout: 45000 })
await hp.waitForTimeout(7000)
const txt = await hp.evaluate(() => document.body.innerText)
// count bet entries by the date/time stamps
const stamps = txt.match(/14\/07\/2026 \d\d:\d\d/g) || []
console.log('balance:', txt.match(/NGN\s*([\d,.]+)/)?.[1])
console.log('bet entries today:', stamps.length, '→', stamps.join('  '))
await hp.close(); await browser.close()
