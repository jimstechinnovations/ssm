/**
 * scripts/probe-sporty-login.mjs
 * Step 1 of verifying SportyBet live placement (pedla_v1.md §7 phase 5):
 * inspect the login form on sportybet.com/ng — NO submission, no credentials used.
 * Run: node scripts/probe-sporty-login.mjs <screenshot-dir>
 */
import { chromium } from 'playwright'

const outDir = process.argv[2] ?? '.'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
})

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForTimeout(4_000)
  console.log('title:', await page.title())
  console.log('url:', page.url())

  const inputs = await page.$$eval('input', els => els.map(e => ({
    name: e.name, type: e.type, placeholder: e.placeholder, id: e.id,
    cls: (e.className || '').slice(0, 60), visible: !!(e.offsetWidth || e.offsetHeight),
  })))
  console.log('inputs:', JSON.stringify(inputs.filter(i => i.visible), null, 1))

  const buttons = await page.$$eval('button, [role=button], a', els => els
    .map(e => ({ text: (e.textContent || '').trim().slice(0, 30), cls: (e.className || '').toString().slice(0, 50) }))
    .filter(b => /log\s?in|sign\s?in|register|join/i.test(b.text))
    .slice(0, 10))
  console.log('auth buttons:', JSON.stringify(buttons, null, 1))

  await page.screenshot({ path: `${outDir}/sporty-home.png`, fullPage: false })
  console.log('screenshot saved')
} finally {
  await browser.close()
}
