/**
 * scripts/debug-sporty-click.mjs — find the click that actually commits a SportyBet slip.
 * Tries strategies in order, checking the balance after each; STOPS the moment the balance drops
 * (the bet is placed) so we never double-spend.
 * Run: node scripts/debug-sporty-click.mjs <bookingCode> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const [, , code, outDir = '.'] = process.argv

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1100 },
})).newPage()

page.on('console', msg => { if (/error|fail|denied/i.test(msg.text())) console.log('  [page console]', msg.text().slice(0, 120)) })
page.on('response', r => { const u = r.url(); if (/order|bet|place/i.test(u) && r.request().method() === 'POST') console.log('  [POST]', r.status(), u.slice(0, 90)) })

const balance = async () => (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)
  const before = await balance()
  console.log('balance BEFORE:', before)

  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) { await removeAll.click(); await page.waitForTimeout(2500) }
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click(); await codeInput.type(code, { delay: 120 })
  await page.waitForTimeout(1200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6000)
  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type('100', { delay: 100 })
  await page.waitForTimeout(2500)

  const changed = async () => (await balance()) !== before

  const strategies = [
    ['wrapper div .m-btn-wrapper', async () => { await page.locator('.m-btn-wrapper', { hasText: /place bet/i }).first().click({ timeout: 8000 }) }],
    ['button.af-button force',      async () => { await page.locator('button.af-button:visible', { hasText: /place bet/i }).first().click({ force: true, timeout: 8000 }) }],
    ['mousedown+mouseup on button', async () => {
      const b = page.locator('button.af-button:visible', { hasText: /place bet/i }).first()
      const box = await b.boundingBox()
      if (box) { await page.mouse.move(box.x + box.width/2, box.y + box.height/2); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up() }
    }],
    ['parent of button text', async () => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(e => /place bet/i.test(e.textContent||'') && !/is-disabled/.test(e.className))
        ;(btn?.closest('.m-btn-wrapper') || btn)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }],
  ]

  for (const [name, act] of strategies) {
    console.log(`\n>>> strategy: ${name}`)
    try { await act() } catch (e) { console.log('  click threw:', e.message.slice(0, 80)) }
    await page.waitForTimeout(3500)
    // handle any confirm/accept dialog that appears
    for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
      const btn = page.locator('button:visible', { hasText: re }).first()
      if (await btn.count()) { console.log('  confirm dialog:', re.source); await btn.click().catch(()=>{}); await page.waitForTimeout(3500) }
    }
    await page.screenshot({ path: `${outDir}/click-${name.replace(/\W+/g,'_')}.png` })
    console.log('  balance now:', await balance())
    if (await changed()) { console.log('  *** BALANCE MOVED — bet placed. stopping. ***'); break }
  }
  console.log('\nbalance AFTER:', await balance())
} finally {
  await browser.close()
}
