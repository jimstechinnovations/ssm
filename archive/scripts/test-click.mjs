/** SAFE focus-fix test: does the exact batch mechanism (node spawns os-max + os-click on Place),
 *  checks whether the Confirm dialog appeared, then CANCELS it. Commits NO money. */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
const ps = (f, ...a) => { try { return execFileSync('powershell', ['-ExecutionPolicy','Bypass','-File',`scripts/${f}`, ...a], { encoding: 'utf8' }) } catch (e) { return 'ERR: ' + (e.stdout||e.message) } }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(600)
const actionable = async () => page.evaluate(() => {
  const vis = e => e && (e.offsetWidth*e.offsetHeight)
  const pick = re => { const els=[...document.querySelectorAll('button,[class*=btn],[class*=confirm],[class*=place]')].filter(e=>re.test((e.textContent||'').trim())&&vis(e)); els.sort((a,b)=>(b.offsetWidth*b.offsetHeight)-(a.offsetWidth*a.offsetHeight)); return els[0] }
  const confirm=pick(/^confirm$/i), place=pick(/^place bet$/i)
  const btn=confirm||place; if(!btn) return {which:null}
  btn.scrollIntoView({block:'center'}); const r=btn.getBoundingClientRect()
  return { which: confirm?'confirm':'place', physX:Math.round((window.screenX+r.left+r.width/2)*window.devicePixelRatio), physY:Math.round((window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2)*window.devicePixelRatio) }
})

console.log('1. os-max:', ps('os-max.ps1').trim())
await page.waitForTimeout(900)
let a = await actionable()
if (a.which !== 'place') { console.log('   (not on Place — actionable:', a.which + '). Clear the betslip first.'); await browser.close(); process.exit(0) }
console.log(`2. node-spawns os-click on Place ${a.physX},${a.physY}:`)
console.log('   ' + ps('os-click.ps1', '-X', String(a.physX), '-Y', String(a.physY)).trim().replace(/\n/g,'\n   '))
await page.waitForTimeout(3000)
a = await actionable()
if (a.which === 'confirm') {
  console.log('\n✓✓ FOCUS FIX WORKS — the node-spawned click registered (Confirm dialog appeared).')
  const cancel = page.locator('.es-dialog-btn:visible, [class*=dialog-btn]:visible', { hasText: /^cancel$/i }).first()
  if (await cancel.count()) { await cancel.click({ force: true }); console.log('   (cancelled — no money committed)') }
} else {
  console.log('\n✗ still not registering — click did not open the Confirm dialog (actionable:', a.which + ').')
}
await browser.close()
