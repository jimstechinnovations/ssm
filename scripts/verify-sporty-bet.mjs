/**
 * scripts/verify-sporty-bet.mjs — independent confirmation: log in and read SportyBet's own
 * Bet History + balance, so we trust the SITE, not our bot's log.
 * Run: node scripts/verify-sporty-bet.mjs <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const outDir = process.argv[2] ?? '.'

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1200 },
})).newPage()

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)

  const balance = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*[\d,.]+/)?.[0]
  console.log('balance now:', balance)

  // click the header link rather than guessing a URL
  const link = page.locator('a, span, div', { hasText: /^Bet History$/i }).first()
  await link.click()
  await page.waitForTimeout(8_000)
  console.log('bet history url:', page.url())
  await page.screenshot({ path: `${outDir}/sp-bethistory.png`, fullPage: true })
  const text = await page.evaluate(() => document.body.innerText)
  console.log('\n===== BET HISTORY =====')
  console.log(text.slice(0, 1800))
} finally {
  await browser.close()
}
