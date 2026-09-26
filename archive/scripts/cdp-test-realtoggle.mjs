import { chromium } from 'playwright'
const code = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/') }
await page.bringToFront(); await page.waitForTimeout(1500)

// ensure a slip is loaded so the toggle is present
const codeInput = page.locator('input[placeholder="Booking Code"]').first()
if (code && await codeInput.count()) {
  await codeInput.click(); await codeInput.type(code, { delay: 100 }); await page.waitForTimeout(1000)
  const load = page.locator('[class*=betslip] >> text=/^Load$/i').first()
  if (await load.count()) { await load.click(); await page.waitForTimeout(4000) }
}
const readReal = () => page.evaluate(() => {
  const r = [...document.querySelectorAll('.switch-box [class*=inside-btn], [class*=inside-btn]')].find(b => /^REAL$/i.test(b.textContent.trim()))
  return r ? { cls: r.className, active: !/inactive/.test(r.className) } : null
})
console.log('REAL before:', JSON.stringify(await readReal()))
// click REAL with a real mouse move
const real = page.locator('[class*=inside-btn]', { hasText: /^REAL$/i }).first()
if (await real.count()) {
  const box = await real.boundingBox()
  if (box) { await page.mouse.move(box.x+box.width/2-20, box.y+box.height/2, {steps:6}); await page.waitForTimeout(120); await page.mouse.move(box.x+box.width/2, box.y+box.height/2, {steps:4}); await page.mouse.down(); await page.waitForTimeout(50); await page.mouse.up() }
  await page.waitForTimeout(2000)
}
console.log('REAL after click:', JSON.stringify(await readReal()))
console.log('header balance:', (await page.evaluate(() => document.querySelector('header, [class*=header]')?.innerText || document.body.innerText)).match(/NGN\s*[\d,.]+/)?.[0])
await browser.close()
