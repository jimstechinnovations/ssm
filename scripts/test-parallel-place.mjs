// scripts/test-parallel-place.mjs
// GROUNDING TEST: do M independent browser SESSIONS (same account, separate betslips) place in
// PARALLEL without SportyBet's "Submission Failed" collision? Clones the logged-in session into N-1
// extra contexts, then places `--slips` real slips across `--workers` sessions with NO cross-worker
// mutex, logging submit timestamps so overlap is visible. Real money — default DRY, needs --live.
//
//   node scripts/test-parallel-place.mjs --workers 3 --slips 4 --stake 10 --legs 2 --live
import { chromium } from 'playwright'
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d }
const WORKERS = flag('--workers', 3), SLIPS = flag('--slips', 4), STAKE = flag('--stake', 10), LEGS = flag('--legs', 2)
const LIVE = args.includes('--live')
const UA = 'Mozilla/5.0', sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString().slice(11, 23)

async function poolGames(n) {
  const evs = []
  for (let pg = 1; pg <= 6 && evs.length < n; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    for (const t of (j.data?.tournaments || [])) for (const ev of (t.events || [])) {
      const m = (ev.markets || []).find(x => x.specifier === 'total=4.5'); if (!m) continue
      const u = (m.outcomes || []).find(o => o.id === '13'); if (!u || parseFloat(u.odds) < 1.20) continue
      if (ev.estimateStartTime && ev.estimateStartTime < Date.now() + 20 * 60000) continue
      const id = (ev.eventId || '').split(':').pop(); if (id) evs.push(id)
    }
  }
  return evs
}
async function mkCode(ids) {
  const sel = ids.map(id => ({ eventId: `sr:match:${id}`, marketId: '18', specifier: 'total=4.5', outcomeId: '13' }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, platform: 'web' }, body: JSON.stringify({ selections: sel, shareType: 1 }) })
  const j = await r.json(); if (!j.data?.shareCode) throw new Error('code failed ' + j.bizCode)
  return j.data.shareCode
}

function bind(page, tag) {
  const log = s => console.log(`${now()} ${tag} ${s}`)
  const bodyHas = re => page.evaluate(rs => new RegExp(rs, 'i').test(document.body.innerText), re.source)
  const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
  const codeBox = () => page.locator('input[placeholder="Booking Code"]:visible').count().then(n => n > 0)
  const hasBtn = src => page.evaluate(s => { const rx = new RegExp(s, 'i'); return [...document.querySelectorAll('span,div,button,a')].some(e => (e.offsetWidth || e.offsetHeight) && rx.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 22) }, src)
  const clickBtn = src => page.evaluate(s => { const rx = new RegExp(s, 'i'); const els = [...document.querySelectorAll('button,[role=button],[class*=btn],[class*=button],span,div,a')].filter(e => (e.offsetWidth || e.offsetHeight) && rx.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 22); if (!els.length) return false; els.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight)); let t = els[0]; for (let i = 0; i < 4 && t && t.parentElement; i++) { if (t.tagName === 'BUTTON' || /btn|button|wrapper/i.test(t.className || '') || (t.getAttribute && t.getAttribute('role') === 'button')) break; t = t.parentElement } (t || els[0]).click(); return true }, src)
  const clearSlip = async () => {
    for (let i = 0; i < 10; i++) {
      if (await codeBox()) return true
      const ra = page.locator('[data-cms-key=remove_all]:visible').first()
      if (await ra.count()) { await ra.click({ force: true }).catch(() => {}); await sleep(600); const ok = page.locator('[class*=dialog-wrap] [class*=dialog-btn]', { hasText: /^OK$/i }).first(); if (await ok.count()) await ok.click({ force: true }).catch(() => {}); await sleep(600); continue }
      const del = page.locator('[class*=betslip] [class*=icon-delete]:visible').first()
      if (await del.count()) { await del.click({ force: true }).catch(() => {}); await sleep(500); continue }
      await sleep(500)
    }
    return codeBox()
  }
  return { log, bodyHas, balNum, codeBox, hasBtn, clickBtn, clearSlip }
}

async function placeOne(w, code, idx) {
  const { log, bodyHas, hasBtn, clickBtn, clearSlip } = w
  if (!(await clearSlip())) throw new Error('could not clear betslip')
  const ci = w.page.locator('input[placeholder="Booking Code"]').first()
  await ci.click(); await ci.type(code, { delay: 45 }); await sleep(500)
  await w.page.locator('[class*=betslip] >> text=/^Load$/i').first().click().catch(() => {})
  await w.page.locator('[class*=betslip] >> text=/Over\\/Under/i').first().waitFor({ timeout: 12000 }).catch(() => {})
  await sleep(1000)
  const sb = w.page.locator('input[placeholder^="min."]').first()
  await sb.click({ clickCount: 3 }).catch(() => {}); await sb.type(String(STAKE), { delay: 40 }).catch(() => {}); await sleep(800)
  if (!LIVE) { log(`[dry] slip ${idx} loaded code ${code} — NOT placing`); return 'dry' }
  log(`slip ${idx} SUBMIT ${code}`)
  let dialog = false
  for (let a = 1; a <= 8 && !dialog; a++) {
    if (await hasBtn('^accept changes$')) { await clickBtn('^accept changes$'); for (let x = 0; x < 12 && await hasBtn('^accept changes$'); x++) await sleep(300) }
    await clickBtn('^place bet$')
    for (let p = 0; p < 10 && !dialog; p++) { await sleep(300); dialog = await bodyHas(/about to pay/) }
  }
  if (!dialog) throw new Error('pay dialog never opened')
  for (let a = 1; a <= 6; a++) {
    if (await hasBtn('^accept changes$')) { await clickBtn('^accept changes$'); await sleep(600) }
    await clickBtn('^confirm$')
    for (let p = 0; p < 12; p++) {
      await sleep(400)
      if (await bodyHas(/submission successful|bet placed|ticket/i)) { log(`slip ${idx} SUCCESS`); return 'placed' }
      if (await bodyHas(/submission failed|something went wrong/)) { log(`slip ${idx} SUBMISSION FAILED`); return 'submission-failed' }
      if (/insufficient|not enough|balance is/i.test(await w.page.evaluate(() => document.body.innerText))) { log(`slip ${idx} insufficient balance`); return 'insufficient' }
    }
    if (!(await bodyHas(/about to pay/))) break
  }
  return 'unconfirmed'
}

const b = await chromium.connectOverCDP('http://127.0.0.1:9222')
const def = b.contexts()[0]
const state = await def.storageState()
console.log(`session captured (${state.cookies.length} cookies). Spinning up ${WORKERS} worker sessions…`)
const workers = []
{
  const p = def.pages().find(p => /sportybet\.com/.test(p.url())) || def.pages()[0]
  workers.push({ ...bind(p, '[w0]'), page: p, ctx: def })
}
for (let i = 1; i < WORKERS; i++) {
  const ctx = await b.newContext({ storageState: state })
  const p = await ctx.newPage()
  await p.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(4000)
  workers.push({ ...bind(p, `[w${i}]`), page: p, ctx })
}
for (const w of workers) {
  const li = await w.page.evaluate(() => /Deposit|Bet History|My Account/i.test(document.body.innerText) && !(document.querySelector('input[name=phone]')?.offsetHeight))
  const bal = await w.balNum()
  w.log(`health: loggedIn=${li} balance=NGN ${bal}`)
  if (LIVE && (!li || Number.isNaN(bal))) { console.log('ABORT: a worker is not ready'); await b.close(); process.exit(1) }
  if (LIVE && bal > 100000) { console.log('ABORT: balance looks like SIM (>100k)'); await b.close(); process.exit(1) }
}

const ids = await poolGames(SLIPS * LEGS + 4)
if (ids.length < SLIPS * LEGS) { console.log(`only ${ids.length} games — need ${SLIPS * LEGS}`); await b.close(); process.exit(1) }
const codes = []
for (let s = 0; s < SLIPS; s++) codes.push(await mkCode(ids.slice(s * LEGS, s * LEGS + LEGS)))
console.log(`built ${codes.length} codes:`, codes.join(', '))

const queues = Array.from({ length: WORKERS }, () => [])
codes.forEach((c, i) => queues[i % WORKERS].push({ code: c, idx: i + 1 }))
const results = []
const t0 = Date.now()
await Promise.all(workers.map(async (w, wi) => {
  for (const { code, idx } of queues[wi]) {
    try { const r = await placeOne(w, code, idx); results.push({ idx, worker: wi, r }) }
    catch (e) { w.log(`slip ${idx} ERROR ${e.message.slice(0, 80)}`); results.push({ idx, worker: wi, r: 'error:' + e.message.slice(0, 40) }) }
  }
}))
console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
for (const r of results.sort((a, b) => a.idx - b.idx)) console.log(`  slip ${r.idx} (w${r.worker}): ${r.r}`)
const placed = results.filter(r => r.r === 'placed').length, failed = results.filter(r => /failed/.test(r.r)).length
console.log(`\nVERDICT: ${placed}/${results.length} placed, ${failed} submission-failed. ${failed === 0 && placed > 1 ? '=> PARALLEL SESSIONS WORK (no collision)' : failed > 0 ? '=> collisions seen' : ''}`)
for (let i = 1; i < workers.length; i++) await workers[i].ctx.close().catch(() => {})
await b.close()
