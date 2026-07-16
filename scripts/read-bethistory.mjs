import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const outDir = process.argv[2] ?? '.'
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', viewport: { width: 1440, height: 1200 } })).newPage()
try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(3000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7000)
  console.log('balance:', (await page.evaluate(() => document.body.innerText)).match(/NGN\s*[\d,.]+/)?.[0])
  // navigate directly to bet history (avoid the empty-betslip dialog overlay)
  await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${outDir}/bethistory.png`, fullPage: true })
  const text = await page.evaluate(() => document.body.innerText)
  console.log('=== BET HISTORY ===')
  console.log(text.slice(0, 2000))
} finally { await browser.close() }
