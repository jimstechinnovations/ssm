import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1000)
const state = () => page.evaluate(() => {
  const sb = document.querySelector('.switch-box'); if (!sb) return null
  const real = sb.querySelector('[data-op=switch-box-left]'); const sim = sb.querySelector('[data-op=switch-box-right]')
  return { realHighlight: /show-highlight/.test(real?.className||''), simHighlight: /show-highlight/.test(sim?.className||''), realCls: real?.className, simCls: sim?.className }
})
console.log('before:', JSON.stringify(await state()))
// click the REAL side with a human-like mouse move
const real = page.locator('[data-op=switch-box-left]').first()
if (await real.count()) {
  const b = await real.boundingBox()
  if (b) { await page.mouse.move(b.x+5, b.y+5, {steps:5}); await page.waitForTimeout(80); await page.mouse.move(b.x+b.width/2, b.y+b.height/2, {steps:5}); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up() }
  await page.waitForTimeout(2000)
}
console.log('after click:', JSON.stringify(await state()))
console.log('header balance:', (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*[\d,.]+/)?.[0])
await browser.close()
