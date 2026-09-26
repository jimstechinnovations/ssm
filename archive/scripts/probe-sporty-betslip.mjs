/**
 * scripts/probe-sporty-betslip.mjs
 * Inspect the betslip panel after loading a booking code: real tag/class of the Load button,
 * the stake input, and the Place Bet control. No bet is placed.
 * Run: node scripts/probe-sporty-betslip.mjs <bookingCode> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const code = process.argv[2]
const outDir = process.argv[3] ?? '.'

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1000 },
})).newPage()

const dumpBetslip = async (tag) => {
  const info = await page.evaluate(() => {
    const panel = document.querySelector('[class*=betslip], [class*=m-betslips]')
    const scope = panel ?? document.body
    const clickable = [...scope.querySelectorAll('button, a, div[class*=btn], span[class*=btn], [role=button]')]
      .map(e => ({ tag: e.tagName, text: (e.textContent || '').trim().slice(0, 25), cls: (e.className || '').toString().slice(0, 55), disabled: e.hasAttribute('disabled') || /disabled/.test(e.className || '') }))
      .filter(x => x.text)
      .slice(0, 20)
    const inputs = [...scope.querySelectorAll('input')].map(e => ({ name: e.name, ph: e.placeholder, cls: (e.className || '').slice(0, 45), val: e.value }))
    return { clickable, inputs, text: scope.innerText.slice(0, 700) }
  })
  console.log(`\n===== ${tag} =====`)
  console.log('clickable:', JSON.stringify(info.clickable, null, 1))
  console.log('inputs:', JSON.stringify(info.inputs, null, 1))
  console.log('panel text:', info.text)
}

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(6_000)

  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click()
  await codeInput.type(code, { delay: 120 })   // typing (not fill) so the framework sees keystrokes
  await page.waitForTimeout(1_500)
  await dumpBetslip('AFTER TYPING CODE')
  await page.screenshot({ path: `${outDir}/sp-probe-typed.png` })

  // click whatever says Load
  const load = page.locator('[class*=betslip] >> text=/^Load$/i').first()
  if (await load.count()) { await load.click(); console.log('\nclicked Load') }
  else { const alt = page.getByText(/^Load$/i).first(); await alt.click(); console.log('\nclicked Load (getByText)') }
  await page.waitForTimeout(6_000)
  await dumpBetslip('AFTER LOAD')
  await page.screenshot({ path: `${outDir}/sp-probe-loaded.png` })
} finally {
  await browser.close()
}
