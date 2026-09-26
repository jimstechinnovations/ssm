/**
 * scripts/debug-sporty-coord.mjs — final attempt: click the Place Bet button by its real
 * bounding-box centre with a human-like mouse move, and log EVERY order-related network call.
 * Stops the instant the balance moves. Run: node scripts/debug-sporty-coord.mjs <code> <out-dir>
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

const orderCalls = []
page.on('request', r => { if (/orders/i.test(r.url()) && r.method() === 'POST') orderCalls.push(r.url()) })
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
  await codeInput.click(); await codeInput.type(code, { delay: 120 }); await page.waitForTimeout(1200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6000)
  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type('100', { delay: 100 })
  await page.waitForTimeout(2500)

  const btn = page.locator('button.af-button:visible', { hasText: /place bet/i }).first()
  const box = await btn.boundingBox()
  console.log('Place Bet box:', JSON.stringify(box))
  if (!box) throw new Error('no bounding box for Place Bet')

  orderCalls.length = 0
  // human-like: move in steps, small pause, click the exact centre
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 10, { steps: 8 })
  await page.waitForTimeout(200)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.waitForTimeout(150)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  console.log('--- coordinate click fired at', Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))

  for (const t of [3, 4, 5]) {
    await page.waitForTimeout(t * 1000)
    for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
      const b = page.locator('button:visible', { hasText: re }).first()
      if (await b.count()) { console.log('  dialog:', re.source); await b.click().catch(()=>{}); await page.waitForTimeout(3000) }
    }
    console.log(`  [+${t}s] balance:`, await balance(), '| order POSTs so far:', JSON.stringify(orderCalls.map(u => u.split('/api/ng')[1])))
    if ((await balance()) !== before) { console.log('  *** PLACED — balance moved. ***'); break }
  }
  await page.screenshot({ path: `${outDir}/coord-after.png` })
  console.log('balance AFTER:', await balance())
  console.log('all order POSTs:', JSON.stringify(orderCalls))
} finally {
  await browser.close()
}
