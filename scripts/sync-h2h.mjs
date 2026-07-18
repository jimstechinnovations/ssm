/**
 * scripts/sync-h2h.mjs — out-of-process Sofascore H2H sync (Playwright inside Next blocks the event
 * loop; a separate process doesn't). Fetches a session's games, pulls each team's recent + the two
 * teams' H2H from Sofascore via the debug Chrome (:9222, Cloudflare-clear), and POSTs the rows to
 * /api/history/upsert. Prints a JSON result line for the caller.
 *
 *   node scripts/sync-h2h.mjs <S-CODE> <baseUrl> <limit>
 */
import { chromium } from 'playwright'

const [code, BASE = 'http://localhost:3000', limitArg, offsetArg] = process.argv.slice(2)
const LIMIT = Math.min(20, Math.max(1, Number(limitArg) || 8))
const OFFSET = Math.max(0, Number(offsetArg) || 0)
const out = (o) => console.log('RESULT ' + JSON.stringify(o))
if (!code) { out({ error: 'usage: sync-h2h <code> <base> <limit>' }); process.exit(1) }

const gj = await fetch(`${BASE}/api/sessions/${encodeURIComponent(code)}/games`).then(r => r.json()).catch(() => null)
const games = (gj?.games ?? []).map(g => { const [home, away] = String(g.game).split(' vs ').map(s => s.trim()); return { home, away } }).filter(g => g.home && g.away)
if (!games.length) { out({ error: 'no games' }); process.exit(1) }

try { const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error() }
catch { out({ needBrowser: true, games: games.length }); process.exit(0) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
let page
try {
  page = await browser.contexts()[0].newPage()
  await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await page.waitForTimeout(3000)
  const g = (u) => page.evaluate(async x => { try { const r = await fetch(x, { headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null } catch { return null } }, u)
  const idCache = new Map()
  const team = async (n) => { if (!idCache.has(n)) { const s = await g(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(n)}`); const t = (s?.results || []).find(x => x.type === 'team')?.entity; idCache.set(n, t ? { id: t.id, name: t.name } : null) } return idCache.get(n) }
  const finished = async (id) => { const out = []; for (let p = 0; p < 2; p++) { const d = await g(`https://api.sofascore.com/api/v1/team/${id}/events/last/${p}`); const ev = (d?.events || []).filter(e => e.status?.type === 'finished' && e.homeScore?.current != null && e.awayScore?.current != null); out.push(...ev); if (!ev.length) break; await sleep(120) } return out }
  const form = (e, id, book) => { const h = e.homeTeam.id === id; return { matchId: `sofa-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: h ? book : e.homeTeam.name, away: h ? e.awayTeam.name : book, hg: e.homeScore.current, ag: e.awayScore.current } }
  const h2hRow = (e, hid, hb, ab) => { const hh = e.homeTeam.id === hid; return { matchId: `sofa-h2h-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: hh ? hb : ab, away: hh ? ab : hb, hg: e.homeScore.current, ag: e.awayScore.current } }

  const batch = []
  let withH2H = 0, withForm = 0, processed = 0
  for (const gm of games.slice(OFFSET, OFFSET + LIMIT)) {
    processed++
    const [th, ta] = await Promise.all([team(gm.home), team(gm.away)])
    let f = false, h = false
    if (th) { const ev = await finished(th.id); if (ev.length) { f = true; for (const e of ev) batch.push(form(e, th.id, gm.home)); if (ta) for (const e of ev.filter(x => x.homeTeam.id === ta.id || x.awayTeam.id === ta.id)) { h = true; batch.push(h2hRow(e, th.id, gm.home, gm.away)) } } }
    if (ta) { const ev = await finished(ta.id); if (ev.length) { f = true; for (const e of ev) batch.push(form(e, ta.id, gm.away)) } }
    if (f) withForm++; if (h) withH2H++
    await sleep(120)
  }
  const up = await fetch(`${BASE}/api/history/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) }).then(r => r.json()).catch(() => ({ rows: 0 }))
  out({ games: games.length, offset: OFFSET, processed, withH2H, withForm, rows: up.rows ?? 0, more: games.length > OFFSET + LIMIT })
} finally { await page?.close().catch(() => {}); await browser.close() }
