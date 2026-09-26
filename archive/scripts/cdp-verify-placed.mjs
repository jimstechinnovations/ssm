/** Confirm the placement from the bookmaker's own truth: balance + latest bet in history. */
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)
const balance = (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
console.log('balance now:', balance)
// open bet history in a fresh tab so we don't disturb the betslip
const hp = await ctx.newPage()
await hp.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10', { waitUntil: 'domcontentloaded', timeout: 45000 })
await hp.waitForTimeout(7000)
const txt = await hp.evaluate(()=>document.body.innerText)
const i = txt.search(/Sport Bets|All\s*Settled|No Bets/i)
console.log('=== BET HISTORY (top) ===')
console.log(txt.slice(i, i+700))
await hp.close()
await browser.close()
