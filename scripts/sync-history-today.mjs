// scripts/sync-history-today.mjs — sync Sofascore history for TODAY'S FULL live game board directly
// (not just the games a session already kept), so a subsequent requireHistory build has more to choose
// from. Same Sofascore logic as sync-h2h.mjs; games come straight from the book instead of a session's
// /games endpoint, since that only ever lists games a build already used — too late for games the
// history gate dropped before they ever reached a slip.
//
//   JITI_ALIAS='{"server-only":"<repo>/test-stubs/server-only.ts"}' node node_modules/jiti/lib/jiti-cli.mjs scripts/sync-history-today.mjs [baseUrl]
import { chromium } from 'playwright'
import { sportybet } from '../lib/books/sportybet'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const out = (o) => console.log('RESULT ' + JSON.stringify(o))

const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const { games: raw } = await sportybet.fetchSelectionGames({ dateFrom: d(0), dateTo: d(1), scanLimit: 400, minKickoffGapMinutes: 1 })
const games = raw.map(g => ({ home: g.home, away: g.away })).filter(g => g.home && g.away)
console.log(`${games.length} games on today's board`)
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
  const finished = async (id) => { const o = []; for (let p = 0; p < 2; p++) { const dd = await g(`https://api.sofascore.com/api/v1/team/${id}/events/last/${p}`); const ev = (dd?.events || []).filter(e => e.status?.type === 'finished' && e.homeScore?.current != null && e.awayScore?.current != null); o.push(...ev); if (!ev.length) break; await sleep(120) } return o }
  const form = (e, id, book) => { const h = e.homeTeam.id === id; return { matchId: `sofa-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: h ? book : e.homeTeam.name, away: h ? e.awayTeam.name : book, hg: e.homeScore.current, ag: e.awayScore.current } }
  const h2hRow = (e, hid, hb, ab) => { const hh = e.homeTeam.id === hid; return { matchId: `sofa-h2h-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: hh ? hb : ab, away: hh ? ab : hb, hg: e.homeScore.current, ag: e.awayScore.current } }

  const batch = []
  let withH2H = 0, withForm = 0, processed = 0
  const eventsCache = new Map()   // team id -> finished events (teams repeat across games on the same board)
  const finishedCached = async (id) => { if (!eventsCache.has(id)) eventsCache.set(id, await finished(id)); return eventsCache.get(id) }
  for (const gm of games) {
    processed++
    const [th, ta] = await Promise.all([team(gm.home), team(gm.away)])
    let f = false, h = false
    if (th) {
      const ev = await finishedCached(th.id)
      if (ev.length) { f = true; for (const e of ev) batch.push(form(e, th.id, gm.home)) }
      if (ta) for (const e of ev.filter(x => x.homeTeam.id === ta.id || x.awayTeam.id === ta.id)) { h = true; batch.push(h2hRow(e, th.id, gm.home, gm.away)) }
    }
    if (ta) { const ev = await finishedCached(ta.id); if (ev.length) { f = true; for (const e of ev) batch.push(form(e, ta.id, gm.away)) } }
    if (f) withForm++; if (h) withH2H++
    if (processed % 10 === 0) console.log(`  ${processed}/${games.length} · withForm ${withForm} · withH2H ${withH2H} · batch ${batch.length}`)
    await sleep(60)
  }
  const up = await fetch(`${BASE}/api/history/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) }).then(r => r.json()).catch(() => ({ rows: 0 }))
  out({ games: games.length, processed, withH2H, withForm, rows: up.rows ?? 0 })
} finally { await page?.close().catch(() => {}); await browser.close() }
