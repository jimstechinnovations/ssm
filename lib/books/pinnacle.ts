// lib/books/pinnacle.ts
// Reference source #1 for the price panel (lib/books/reference.ts): Pinnacle's pre-match football board,
// read from the public feed its own website uses (guest.api.arcadia.pinnacle.com — no account; reachable
// from Nigeria, probed 2026-10-02). Pinnacle takes big bets at thin margins (~2–3%), so its de-vigged
// price is the best single estimate of a result's real probability. Read-only; cached 5 minutes.

import { emptyFair, powerDevig, type FairMarkets, type RefBoard } from './reference'

const API = 'https://guest.api.arcadia.pinnacle.com/0.1'
// the public key Pinnacle's own web app sends with every request
const HEADERS = { 'X-API-Key': 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R', Accept: 'application/json', Referer: 'https://www.pinnacle.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }

interface RawMatchup { id: number; type?: string; parentId?: number | null; startTime: string; isLive?: boolean; league?: { name?: string }; participants?: { alignment: string; name: string }[] }
interface RawPrice { designation: string; points?: number; price: number }
interface RawMarket { matchupId: number; period: number; type: string; side?: string; status: string; prices: RawPrice[] }

export const american = (a: number) => a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a)
const halfLine = (x?: number) => x != null && Number.isInteger(x * 2) && !Number.isInteger(x)   // no refunds

let cache: { at: number; board: RefBoard } | null = null

export async function fetchPinnacleBoard(): Promise<RefBoard> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.board
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(90_000), cache: 'no-store' })
    if (!r.ok) throw new Error(`Pinnacle ${path}: HTTP ${r.status}`)
    return r.json() as Promise<T>
  }
  const [rawM, rawP] = await Promise.all([
    get<RawMatchup[]>('/sports/29/matchups?withSpecials=false&brandId=0'),
    get<RawMarket[]>('/sports/29/markets/straight?primaryOnly=false&withSpecials=false'),
  ])
  const fixtures = rawM
    .filter(m => m.type === 'matchup' && !m.parentId && !m.isLive && m.participants?.length === 2)
    .map(m => ({ id: String(m.id), start: m.startTime, league: m.league?.name ?? '', home: m.participants!.find(p => p.alignment === 'home')?.name ?? '', away: m.participants!.find(p => p.alignment === 'away')?.name ?? '' }))
    .filter(m => m.home && m.away)
  const fair = new Map<string, FairMarkets>()
  const of = (id: number) => { const k = String(id); let f = fair.get(k); if (!f) { f = emptyFair(); fair.set(k, f) } return f }
  for (const q of rawP) {
    if (q.period !== 0 || q.status !== 'open') continue
    const pick = (d: string) => q.prices.find(p => p.designation === d)
    if (q.type === 'moneyline') {
      const h = pick('home'), d = pick('draw'), a = pick('away')
      if (!h || !d || !a) continue
      const [ph, pd, pa] = powerDevig([american(h.price), american(d.price), american(a.price)])
      of(q.matchupId).moneyline = { home: ph, draw: pd, away: pa }
    } else if (q.type === 'total' || q.type === 'team_total') {
      const o = pick('over'), u = pick('under')
      if (!o || !u || !halfLine(o.points)) continue
      const [po] = powerDevig([american(o.price), american(u.price)])
      if (q.type === 'total') of(q.matchupId).totals.set(o.points!, po)
      else if (q.side === 'home' || q.side === 'away') of(q.matchupId).teamTotals[q.side].set(o.points!, po)
    }
  }
  const board: RefBoard = { source: 'pinnacle', weight: 2, fixtures, fair }
  cache = { at: Date.now(), board }
  return board
}
