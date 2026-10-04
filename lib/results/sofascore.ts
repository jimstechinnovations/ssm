// lib/results/sofascore.ts — a SECOND results source for games SportyBet's event feed has no live data for.
//
// Why: lower-league games (e.g. Truro City v Cirencester, Salisbury v Dulwich, 2026-10-03) stay "Not start"
// with no score on SportyBet's event endpoint until SportyBet settles them, so our survival / settlement
// can't see them while they're played. Sofascore carries them. Its API sits behind Cloudflare, so it is read
// through a real Chrome — but NEVER the betting Chrome: Sofascore's challenge page and ~150 ad frames froze
// the placement browser's debug connection twice. This uses its own Chrome (port 9250, own profile, never
// logged into anything), loads Sofascore with every non-Sofascore request blocked, and reads each list at most
// once per minute (one request serves every game in it). Read-only.
//
// Sofascore no longer serves a whole day in one list (scheduled-events/{date} → 404, 2026-10-03); it serves
// one country's day (category/{id}/scheduled-events/{date}), so we look in the game's country + all live games.
// Matching: same day, kick-off within 45 min, both team names agreeing (lib/books/reference.ts nameScore).
// Score: the 90-minute score (period1 + period2) — what SportyBet settles on; a game in extra time or on
// penalties is decided for betting.

import 'server-only'
import { spawn } from 'node:child_process'
import { nameScore } from '../books/reference'

const PORT = 9250
type Page = import('playwright').Page
interface SofaEvent { id: number; startTimestamp: number; homeTeam: { name: string }; awayTeam: { name: string }; status?: { type?: string; description?: string }; homeScore?: { current?: number; period1?: number; period2?: number; normaltime?: number }; awayScore?: { current?: number; period1?: number; period2?: number; normaltime?: number }; time?: { currentPeriodStartTimestamp?: number } }
export interface AltResult { finished: boolean; live: boolean; home: number; away: number; minute?: number; source: 'sofascore'; status: string }

let pageP: Promise<Page> | null = null

async function up(): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
}

/** The results Chrome (launched on first use) with one Sofascore page, ads blocked. */
async function getPage(): Promise<Page> {
  if (pageP) { const p = await pageP.catch(() => null); if (p && !p.isClosed()) return p; pageP = null }
  pageP = (async () => {
    if (!(await up())) {
      // not `detached` — that child never brought the port up; the script starts Chrome with Start-Process,
      // so Chrome outlives it either way. The script returns once the port answers (≤30s).
      await new Promise<void>(res => { const c = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/cdp-launch-chrome.ps1', '-Mode', 'dedicated', '-Port', String(PORT), '-StartUrl', 'about:blank'], { stdio: 'ignore', windowsHide: true }); c.on('exit', () => res()); c.on('error', () => res()) })
      if (!(await up())) throw new Error(`results browser did not start on :${PORT}`)
    }
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30_000 })
    const ctx = browser.contexts()[0]
    const page = ctx.pages().find(p => /sofascore\.com/.test(p.url())) ?? ctx.pages()[0] ?? await ctx.newPage()
    await page.route('**/*', r => /(^|\.)sofascore\.(com|app)$/.test(new URL(r.request().url()).hostname) ? r.continue() : r.abort())
    if (!/sofascore\.com/.test(page.url())) await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    return page
  })()
  return pageP
}

/** One shared, short-lived request per URL (6 parallel lookups → 1 request; refreshed after `ttl`). */
const cache = new Map<string, { at: number; p: Promise<unknown> }>()
function api<T>(path: string, ttl = 60_000): Promise<T> {
  const c = cache.get(path)
  if (c && Date.now() - c.at < ttl) return c.p as Promise<T>
  const p = (async () => {
    const page = await getPage()
    const j = await Promise.race([
      page.evaluate(async u => { const r = await fetch(u); return r.ok ? { ok: true, body: await r.json() } : { ok: false, status: r.status } }, path),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Sofascore timed out')), 25_000)),
    ]) as { ok: boolean; body?: T; status?: number }
    if (!j.ok) throw new Error(`Sofascore ${path} → HTTP ${j.status}`)
    return j.body as T
  })()
  cache.set(path, { at: Date.now(), p })
  // a failed or timed-out read drops the page too: a hung page would otherwise be reused for ever (the
  // frozen-feed fallback missed Enyimba 2-0 on 2026-10-04 that way; the retry on a fresh page found it)
  p.catch(() => { if (cache.get(path)?.p === p) cache.delete(path); pageP = null })
  return p
}

/** The day's games in the game's country (SportyBet's category: name first, else the shared Sportradar id —
 *  England is 1 on both), plus every game live right now (covers a country we couldn't map). */
async function candidates(date: string, category?: { name?: string; id?: string }): Promise<SofaEvent[]> {
  const out: SofaEvent[] = []
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '')
  if (category?.name || category?.id) {
    const cats = await api<{ categories?: { category: { id: number; name: string } }[] }>(`/api/v1/sport/football/${date}/0/categories`, 10 * 60_000)
    const srId = Number(/(\d+)$/.exec(category.id ?? '')?.[1])
    const hit = cats.categories?.find(c => category.name && norm(c.category.name) === norm(category.name))
      ?? cats.categories?.find(c => c.category.id === srId)
    if (hit) out.push(...((await api<{ events?: SofaEvent[] }>(`/api/v1/category/${hit.category.id}/scheduled-events/${date}`)).events ?? []))
  }
  out.push(...((await api<{ events?: SofaEvent[] }>('/api/v1/sport/football/events/live', 30_000)).events ?? []))
  return out
}

/** The game's result from Sofascore, or null when it isn't found / not started. */
export async function sofascoreResult(game: { home: string; away: string; kickoffMs: number; category?: { name?: string; id?: string } }): Promise<AltResult | null> {
  const date = new Date(game.kickoffMs).toISOString().slice(0, 10)
  const events = await candidates(date, game.category)
  let best: SofaEvent | null = null, bestScore = 0
  for (const e of events) {
    if (Math.abs(e.startTimestamp * 1000 - game.kickoffMs) > 45 * 60_000) continue
    const s = Math.min(nameScore(game.home, e.homeTeam.name), nameScore(game.away, e.awayTeam.name))
    if (s > bestScore) { bestScore = s; best = e }
  }
  if (!best || bestScore < 0.5) return null
  const type = best.status?.type ?? '', desc = best.status?.description ?? ''
  if (type === 'notstarted' || type === 'postponed' || type === 'canceled') return null
  const hs = best.homeScore ?? {}, as = best.awayScore ?? {}
  const beyond = /extra|penalt|overtime|after/i.test(desc) || (type === 'finished' && hs.normaltime != null && hs.normaltime !== hs.current)
  // the 90-minute score: normaltime when given, else first + second half, else the running score
  const h = hs.normaltime ?? (hs.period1 != null && hs.period2 != null ? hs.period1 + hs.period2 : hs.current)
  const a = as.normaltime ?? (as.period1 != null && as.period2 != null ? as.period1 + as.period2 : as.current)
  if (h == null || a == null) return null
  const finished = type === 'finished' || beyond
  const minute = !finished && best.time?.currentPeriodStartTimestamp ? Math.min(90, (/2nd/i.test(desc) ? 45 : 0) + Math.floor((Date.now() / 1000 - best.time.currentPeriodStartTimestamp) / 60)) : undefined
  return { finished, live: !finished, home: h, away: a, minute, source: 'sofascore', status: desc }
}
