/**
 * scripts/lib-history.mjs — shared history-fetch module for the multi-market build scripts.
 * Tries apifootball first (fast, no browser); falls back to SofaScore (via the debug Chrome's CDP
 * session, since SofaScore's API 403s on a direct server fetch — needs a real browser context) when
 * apifootball has no data for one or both teams.
 *
 * Exposes RAW normalised results (MatchResult[]: {date, home, away, hg, ag}) so callers can either
 * (a) print a human-readable summary, or (b) feed them into lib-form-model.mjs's Poisson model to
 * get a form-implied probability that actually influences which market gets picked.
 *
 * Used by build-multimarket-pedla-book.mjs and build-disjoint-multimarket-slips.mjs.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

let APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY?.trim()
if (!APIFOOTBALL_KEY) {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env — env vars must already be set */ }
  APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY?.trim()
}
const APIFOOTBALL_BASE = process.env.APIFOOTBALL_URL?.trim() || 'https://apiv3.apifootball.com'
const CDP_URL = process.env.CDP_URL?.trim() || 'http://127.0.0.1:9222'

const norm = (date, home, away, hg, ag) => ({ date, home, away, hg: Number(hg), ag: Number(ag) })

async function rawFromApifootball(home, away) {
  if (!APIFOOTBALL_KEY) return null
  const url = `${APIFOOTBALL_BASE}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${APIFOOTBALL_KEY}`
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    if (!j) return null
    const clean = (arr) => (arr || [])
      .filter(r => r.match_hometeam_score !== '' && r.match_awayteam_score !== '' && r.match_hometeam_score != null)
      .map(r => norm(r.match_date, r.match_hometeam_name, r.match_awayteam_name, r.match_hometeam_score, r.match_awayteam_score))
    const homeResults = clean(j.firstTeam_lastResults), awayResults = clean(j.secondTeam_lastResults)
    return (homeResults.length || awayResults.length) ? { homeResults, awayResults, source: 'apifootball' } : null
  } catch { return null }
}

// ── SofaScore fallback (needs a real browser — direct server fetch gets 403'd) ──
// The tab/connection has been observed dropping mid-run (user closing tabs, Chrome restarts, etc.),
// so getSofaPage() always verifies the cached page is still alive and transparently reopens a fresh
// one if not — callers never see a crash from this, only a null result in the worst case.
let sofaBrowser = null, sofaPage = null
async function getSofaPage(forceNew = false) {
  if (sofaPage && !forceNew) {
    try { if (!sofaPage.isClosed()) return sofaPage } catch { /* fall through to reopen */ }
  }
  sofaPage = null
  try {
    if (!sofaBrowser || forceNew) sofaBrowser = await chromium.connectOverCDP(CDP_URL)
    const ctx = sofaBrowser.contexts()[0]
    sofaPage = await ctx.newPage() // separate tab — never touch the live betting tab
    return sofaPage
  } catch {
    sofaBrowser = null
    return null
  }
}

/** Last-10 finished matches for a team via SofaScore's public API, browser-context fetch. */
async function sofaTeamResults(page, teamName) {
  return page.evaluate(async (name) => {
    const g = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return { s: r.status, t: await r.text() } }
    try {
      const s = await g(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(name)}`)
      const d = JSON.parse(s.t)
      const t = (d.results || []).find(x => x.type === 'team')
      if (!t) return []
      const ev = await g(`https://api.sofascore.com/api/v1/team/${t.entity.id}/events/last/0`)
      const events = (JSON.parse(ev.t).events || []).filter(x => x.status?.type === 'finished')
      return events.slice(-10).map(m => ({
        date: new Date(m.startTimestamp * 1000).toISOString().slice(0, 10),
        home: m.homeTeam.name, away: m.awayTeam.name, hg: m.homeScore.current, ag: m.awayScore.current,
      }))
    } catch { return [] }
  }, teamName)
}

async function rawFromSofaScore(home, away, retried = false) {
  const page = await getSofaPage()
  if (!page) return null
  try {
    const [homeResults, awayResults] = await Promise.all([sofaTeamResults(page, home), sofaTeamResults(page, away)])
    return (homeResults.length || awayResults.length) ? { homeResults, awayResults, source: 'sofascore' } : null
  } catch {
    if (retried) return null // one retry with a fresh tab, then give up gracefully (book-only for this fixture)
    await getSofaPage(true)
    return rawFromSofaScore(home, away, true)
  }
}

/** Raw normalised results for both teams (for the form model). apifootball first, SofaScore fallback. */
export async function fetchTeamResultsPair(home, away) {
  const a = await rawFromApifootball(home, away)
  if (a && a.homeResults.length && a.awayResults.length) return a
  const s = await rawFromSofaScore(home, away)
  // prefer whichever source actually has BOTH teams; otherwise take whichever has more data
  if (s && s.homeResults.length && s.awayResults.length) return s
  return s ?? a ?? null
}

export function summarize(results, team) {
  const sorted = [...(results || [])].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  let w = 0, l = 0, d = 0, gf = 0, ga = 0, n = 0, maxTotal = 0
  for (const r of sorted.slice(0, 10)) {
    if (Number.isNaN(r.hg) || Number.isNaN(r.ag)) continue
    const isHome = (r.home || '').toLowerCase().includes(team.toLowerCase().split(' ').pop().toLowerCase())
    const scored = isHome ? r.hg : r.ag, conceded = isHome ? r.ag : r.hg
    gf += scored; ga += conceded; n++
    maxTotal = Math.max(maxTotal, r.hg + r.ag)
    if (scored > conceded) w++; else if (scored < conceded) l++; else d++
  }
  return n ? { w, d, l, n, gfAvg: +(gf / n).toFixed(2), gaAvg: +(ga / n).toFixed(2), maxTotal } : null
}

/** Human-readable history note for both teams (built on the same raw fetch used for the form model). */
export async function fetchHistoryNote(home, away) {
  const pair = await fetchTeamResultsPair(home, away)
  if (!pair) return null
  const hf = summarize(pair.homeResults, home), af = summarize(pair.awayResults, away)
  if (!hf && !af) return null
  return { home: hf ? { ...hf, source: pair.source } : null, away: af ? { ...af, source: pair.source } : null, raw: pair }
}

/** Close the SofaScore tab (not the whole browser) when a build script finishes. */
export async function closeHistorySession() {
  if (sofaPage) await sofaPage.close().catch(() => { })
  if (sofaBrowser) await sofaBrowser.close().catch(() => { })
  sofaPage = null; sofaBrowser = null
}
