// scripts/cdp-toggle-diag.mjs — where is the REAL toggle, what's on top of it, and does a JS click work?
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)

const diag = await page.evaluate(() => {
  const real = document.querySelector('[data-op=switch-box-left]')
  if (!real) return { err: 'no real btn' }
  const r = real.getBoundingClientRect()
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const onTop = document.elementFromPoint(cx, cy)
  const chain = []
  let e = onTop
  while (e && chain.length < 5) { chain.push(`${e.tagName}.${(e.className || '').toString().slice(0, 40)}`); e = e.parentElement }
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    inViewport: r.y >= 0 && r.y < innerHeight && r.x >= 0 && r.x < innerWidth,
    viewport: { w: innerWidth, h: innerHeight },
    scrollY: Math.round(scrollY),
    elementAtPoint: chain,
    samePoint: onTop === real || real.contains(onTop) || (onTop && onTop.contains(real)),
  }
})
console.log('diag:', JSON.stringify(diag, null, 1))

// try a direct JS click cascade on the element itself (pointer events + click)
const after = await page.evaluate(() => {
  const real = document.querySelector('[data-op=switch-box-left]')
  const fire = (type) => real.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
  fire('pointerdown'); fire('mousedown'); fire('pointerup'); fire('mouseup'); fire('click')
  return new Promise(res => setTimeout(() => {
    const l = document.querySelector('[data-op=switch-box-left]')
    res({ realCls: l?.className })
  }, 1500))
})
console.log('after JS click:', JSON.stringify(after))
await browser.close()
