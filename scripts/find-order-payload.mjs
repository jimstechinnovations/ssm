/**
 * scripts/find-order-payload.mjs — extract the /orders/order request body shape + headers
 * from SportyBet's JS so we can build the API placer.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
})).newPage()
await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(6_000)
const origin = 'https://www.sportybet.com'
const srcs = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(s => s.src))
const jsUrls = [...new Set(srcs.map(u => (u.startsWith('http') ? u : origin + u)).filter(u => /\.js/.test(u)))]

for (const u of jsUrls) {
  let t
  try { t = await (await fetch(u)).text() } catch { continue }
  const i = t.indexOf('/orders/order')
  if (i < 0) continue
  console.log('=== bundle', u.split('/').pop(), '===')
  // wider window around the fetch call
  console.log(t.slice(Math.max(0, i - 1400), i + 500).replace(/\s+/g, ' '))
  console.log('\n--- keys near "totalStake"/"selections"/"betType" in this bundle ---')
  for (const kw of ['totalStake', 'selections', 'betType', 'stake', 'operId', 'appDeviceId', 'bonusType', 'wapVersion']) {
    const j = t.indexOf(kw)
    if (j >= 0) console.log(`  [${kw}]`, t.slice(j - 40, j + 60).replace(/\s+/g, ' '))
  }
  break
}
await browser.close()
