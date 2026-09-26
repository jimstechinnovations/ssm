/**
 * scripts/probe-sporty-login2.mjs
 * Step 2: ONE login attempt with env credentials (SPORTY_NUMBER / SPORTY_PASSWORD),
 * then report whether the account area (balance) is visible. Saves storage state for
 * the placement flow so we never log in more than necessary.
 * Run: node scripts/probe-sporty-login2.mjs <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

// minimal .env loader (never printed)
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const phone = process.env.SPORTY_NUMBER
const psd = process.env.SPORTY_PASSWORD
if (!phone || !psd) { console.error('SPORTY_NUMBER / SPORTY_PASSWORD not set'); process.exit(1) }

const outDir = process.argv[2] ?? '.'
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
})
const page = await ctx.newPage()

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForTimeout(3_000)

  // SportyBet NG phone field expects the local number; strip a leading +234 or 234 if present.
  const local = phone.replace(/^\+?234/, '0').replace(/^00?/, '0')
  await page.fill('input[name=phone]', local)
  await page.waitForTimeout(800)
  await page.fill('input[name=psd]', psd)
  await page.waitForTimeout(800)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(6_000)

  await page.screenshot({ path: `${outDir}/sporty-after-login.png` })

  const text = await page.evaluate(() => document.body.innerText.slice(0, 4000))
  const hasBalance = /balance|₦|NGN/i.test(text) && !(await page.$('input[name=psd]'))
  const stillLoginForm = Boolean(await page.$('input[name=psd]'))
  const errorMsg = await page.$$eval('[class*=error], [class*=tip], [class*=warn]', els =>
    els.map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 5))

  console.log('still shows login form:', stillLoginForm)
  console.log('error-ish messages:', JSON.stringify(errorMsg))
  console.log('balance-ish text found:', hasBalance)
  // account header area, if present
  const acct = await page.$$eval('[class*=account], [class*=balance], [class*=avatar]', els =>
    els.map(e => (e.textContent || '').trim().slice(0, 60)).filter(Boolean).slice(0, 8))
  console.log('account widgets:', JSON.stringify(acct))

  if (!stillLoginForm) {
    await ctx.storageState({ path: `${outDir}/sporty-session.json` })
    console.log('session saved for placement flow')
  }
} finally {
  await browser.close()
}
