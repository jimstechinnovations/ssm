/**
 * scripts/debug-sporty-place.mjs — watch EXACTLY what happens when Place Bet is clicked.
 * Screenshots + DOM/dialog dumps at each step, and a balance check before/after.
 * Run: node scripts/debug-sporty-place.mjs <bookingCode> <stake> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const [, , code, stake = '100', outDir = '.'] = process.argv

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1100 },
})).newPage()

const balance = async () => (await page.evaluate(() => document.body.innerText)).match(/NGN\s*[\d,.]+/)?.[0]

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)
  console.log('balance BEFORE:', await balance())

  // REAL vs SIM toggle — make sure REAL is selected
  const toggle = await page.evaluate(() => [...document.querySelectorAll('[class*=inside-btn]')]
    .map(e => ({ text: e.textContent.trim(), cls: e.className })))
  console.log('REAL/SIM toggle:', JSON.stringify(toggle))

  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) { await removeAll.click(); await page.waitForTimeout(2500) }

  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click()
  await codeInput.type(code, { delay: 120 })
  await page.waitForTimeout(1200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6000)

  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click()
  await stakeBox.fill('')
  await stakeBox.type(stake, { delay: 100 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${outDir}/dbg-1-ready.png` })

  const placeBtn = page.locator('button.af-button:visible', { hasText: /place bet/i }).first()
  console.log('place btn count:', await placeBtn.count(), '| class:', await placeBtn.getAttribute('class'))

  await placeBtn.click()
  console.log('--- clicked Place Bet ---')

  for (const t of [2, 4, 7, 11, 16]) {
    await page.waitForTimeout(t === 2 ? 2000 : 2500)
    await page.screenshot({ path: `${outDir}/dbg-t${t}.png` })
    const info = await page.evaluate(() => {
      const vis = (e) => !!(e.offsetWidth || e.offsetHeight)
      const dialogs = [...document.querySelectorAll('[class*=dialog], [class*=modal], [class*=popup], [class*=confirm], [role=dialog]')]
        .filter(vis).map(e => ({ cls: e.className.toString().slice(0, 45), text: e.innerText.slice(0, 250) }))
      const buttons = [...document.querySelectorAll('button')].filter(vis)
        .map(e => ({ text: e.textContent.trim().slice(0, 25), cls: e.className.slice(0, 40) }))
        .filter(b => b.text)
      const panel = [...document.querySelectorAll('[class*=betslip]')].filter(vis)
        .sort((a, b) => b.innerText.length - a.innerText.length)[0]
      return {
        dialogs,
        buttons: buttons.slice(0, 12),
        bal: document.body.innerText.match(/NGN\s*[\d,.]+/)?.[0],
        panelTail: panel ? panel.innerText.slice(-300) : '',
      }
    })
    console.log(`\n[t=${t}s] balance=${info.bal}`)
    if (info.dialogs.length) console.log('  DIALOGS:', JSON.stringify(info.dialogs, null, 1))
    console.log('  buttons:', JSON.stringify(info.buttons))
    console.log('  betslip tail:', JSON.stringify(info.panelTail))
  }
  console.log('\nbalance AFTER:', await balance())
} finally {
  await browser.close()
}
