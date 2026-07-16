/**
 * scripts/probe-sporty-state.mjs — what does the betslip look like on a FRESH page load when it
 * already holds selections? (visibility of Remove All / stake / Place Bet, and the totals text)
 * Run: node scripts/probe-sporty-state.mjs <out-dir>
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
  viewport: { width: 1440, height: 1100 },
})).newPage()

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)
  await page.screenshot({ path: `${outDir}/sp-state.png` })

  const state = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    const panels = [...document.querySelectorAll('[class*=betslip]')].map(p => ({
      cls: p.className.toString().slice(0, 50), visible: vis(p), textLen: p.innerText.length,
    }))
    const removeAll = [...document.querySelectorAll('[data-cms-key=remove_all]')].map(e => ({ visible: vis(e), parentCls: e.parentElement?.className?.toString().slice(0, 45) }))
    const stakes = [...document.querySelectorAll('input')].filter(e => /min\./i.test(e.placeholder || '')).map(e => ({ ph: e.placeholder, visible: vis(e), val: e.value }))
    const places = [...document.querySelectorAll('button')].filter(e => /place bet/i.test(e.textContent || '')).map(e => ({ cls: e.className, visible: vis(e), disabled: /is-disabled/.test(e.className) }))
    const bigPanel = [...document.querySelectorAll('[class*=betslip]')].filter(vis).sort((a, b) => b.innerText.length - a.innerText.length)[0]
    return { panels, removeAll, stakes, places, panelText: bigPanel ? bigPanel.innerText.slice(0, 1800) : '(none visible)' }
  })
  console.log('panels:', JSON.stringify(state.panels, null, 1))
  console.log('removeAll:', JSON.stringify(state.removeAll))
  console.log('stake inputs:', JSON.stringify(state.stakes))
  console.log('place buttons:', JSON.stringify(state.places))
  console.log('\n===== visible betslip text =====\n' + state.panelText)
} finally {
  await browser.close()
}
