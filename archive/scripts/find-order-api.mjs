/**
 * scripts/find-order-api.mjs — mine SportyBet's own JS bundles for the order-placement
 * endpoint + surrounding payload keys, so we can wire the API placer once we have a captured sample.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
})).newPage()

await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(6_000)
// collect every <script src> plus any preloaded chunk hrefs
const srcs = await page.evaluate(() => [
  ...[...document.querySelectorAll('script[src]')].map(s => s.src),
  ...[...document.querySelectorAll('link[href$=".js"], link[as=script]')].map(l => l.href),
])
const origin = 'https://www.sportybet.com'
const jsUrls = new Set(srcs.map(u => (u.startsWith('http') ? u : origin + u)).filter(u => /\.js/.test(u)))
console.log('JS bundles from DOM:', jsUrls.size)

const endpoints = new Map()
const contexts = []
for (const u of jsUrls) {
  let t
  try { t = await (await fetch(u)).text() } catch { continue }
  for (const m of t.matchAll(/["'`](\/api\/ng\/orders\/[a-zA-Z0-9_/]+)["'`]/g)) endpoints.set(m[1], (endpoints.get(m[1]) || 0) + 1)
  for (const m of t.matchAll(/["'`](\/api\/ng\/[a-zA-Z0-9_/]*(?:place|order)[a-zA-Z0-9_/]*)["'`]/gi)) endpoints.set(m[1], (endpoints.get(m[1]) || 0) + 1)
  // capture a little context around an obvious place call
  const idx = t.search(/orders\/(place|order)\b/)
  if (idx >= 0 && contexts.length < 3) contexts.push(t.slice(Math.max(0, idx - 160), idx + 220).replace(/\s+/g, ' '))
}
console.log('\norder-ish endpoints in bundles:')
for (const [k, v] of [...endpoints.entries()].sort()) console.log('  ', k, `(x${v})`)
console.log('\ncontext snippets near a place/order call:')
contexts.forEach((c, i) => console.log(`  [${i}]`, c))
await browser.close()
