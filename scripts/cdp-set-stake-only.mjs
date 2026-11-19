import { chromium } from 'playwright'
const stake = process.argv[2] ?? '1000'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)
const stakeBox = page.locator('input[placeholder^="min."]').first()
if (!(await stakeBox.count())) { console.error('stake box not found'); process.exit(1) }
await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(String(stake), { delay: 90 })
await page.waitForTimeout(1500)
const slipText = await page.evaluate(() => { const p=[...document.querySelectorAll('[class*=betslip]')].filter(e=>e.offsetHeight).sort((a,b)=>b.innerText.length-a.innerText.length)[0]; return p?p.innerText:'' })
console.log('stake set. betslip shows Total Stake:', slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1], '| Odds:', slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1], '| Potential Win:', slipText.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1])
console.log('NOTE: stake set only. Place Bet was NOT clicked by this script.')
await browser.close()
