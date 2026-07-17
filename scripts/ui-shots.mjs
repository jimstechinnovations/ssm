// scripts/ui-shots.mjs — screenshot every app page at desktop + mobile widths for a design review.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://localhost:3000'
const OUT = 'engine-screenshots'
mkdirSync(OUT, { recursive: true })

const pages = [
  ['dashboard', '/'],
  ['bet-manager', '/bet-manager'],
  ['config', '/config'],
  ['session', '/sessions/S-03CFC8'],
  ['placements', '/placements'],
]
const viewports = [['desktop', 1440, 900], ['mobile', 390, 844]]

const browser = await chromium.launch()
for (const [vname, w, h] of viewports) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  for (const [name, path] of pages) {
    try {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2800)
      await page.screenshot({ path: `${OUT}/${name}-${vname}.png`, fullPage: true })
      console.log('✓', `${name}-${vname}`)
    } catch (e) { console.log('✗', `${name}-${vname}`, e.message.slice(0, 60)) }
  }
  await ctx.close()
}
await browser.close()
console.log('done →', OUT)
