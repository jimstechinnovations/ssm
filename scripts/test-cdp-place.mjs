/** Isolate the question: does a CDP (Playwright) click on Place Bet register (open the dialog)?
 *  Loads a slip, clicks Place Bet via CDP three ways, checks if "about to pay" appears. No Confirm
 *  click → commits no money (balance is ₦0 anyway). */
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)

// load a fresh code so Place Bet is present
const legs=[{eventId:'sr:match:53452533',marketId:'18',specifier:'total=4.5',outcomeId:'13'}]
const share=await (await fetch('https://www.sportybet.com/api/ng/orders/share',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0',platform:'web'},body:JSON.stringify({selections:legs,shareType:1})})).json()
const code=share.data.shareCode
// clear + load
const dl=(rs)=>page.evaluate(s=>{const rx=new RegExp(s,'i');const e=[...document.querySelectorAll('span,div,a,button')].find(x=>x.children.length===0&&rx.test((x.textContent||'').trim())&&(x.offsetWidth||x.offsetHeight));if(e){e.click();return true}return false},rs)
for(let i=0;i<5;i++){ if(await page.locator('input[placeholder="Booking Code"]:visible').count())break; if(await page.evaluate(()=>/about to pay/i.test(document.body.innerText)))await dl('^cancel$'); else if(document.querySelector) await page.evaluate(()=>{const r=document.querySelector('[data-cms-key=remove_all]');if(r&&r.offsetWidth)r.click()}); await page.waitForTimeout(1000) }
const ci=page.locator('input[placeholder="Booking Code"]').first(); await ci.click(); await ci.type(code,{delay:80}); await page.waitForTimeout(800)
await page.locator('[class*=betslip] >> text=/^Load$/i').first().click(); await page.waitForTimeout(4000)

const payUp=()=>page.evaluate(()=>/about to pay|insufficient|not enough/i.test(document.body.innerText))
const findPlace=()=>page.evaluate(()=>{const vis=e=>e&&(e.offsetWidth*e.offsetHeight);const els=[...document.querySelectorAll('button,[class*=btn],[class*=place],span,div,a')].filter(e=>e.children.length===0&&/^place bet$/i.test((e.textContent||'').trim())&&vis(e));els.sort((a,b)=>(a.offsetWidth*a.offsetHeight)-(b.offsetWidth*b.offsetHeight));const b=els[0];if(!b)return false;b.scrollIntoView({block:'center'});return true})

console.log('slip loaded, code', code)
// Try 1: Playwright locator click
await findPlace()
await page.locator('button.af-button, .m-btn-wrapper', {hasText:/place bet/i}).first().click({timeout:5000}).catch(e=>console.log('  locator click err:',e.message.slice(0,50)))
await page.waitForTimeout(2500)
console.log('after locator click → dialog/response present:', await payUp())
// Try 2: native DOM .click() dispatch
await dl('^place bet$'); await page.waitForTimeout(2500)
console.log('after native .click() → dialog/response present:', await payUp())
console.log('body snippet:', (await page.evaluate(()=>document.body.innerText)).match(/(about to pay|insufficient|not enough|potential win)[^\n]{0,40}/i)?.[0] || '(no pay/insufficient text)')
await browser.close()
