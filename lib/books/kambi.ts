// lib/books/kambi.ts
// Reference source #2 for the price panel (lib/books/reference.ts): Kambi, the trading platform behind
// Unibet, 888sport, LeoVegas and BetMGM — independent of Pinnacle. Public offering feed (no account):
// a football list for fixtures, then one request per fixture for its full-time markets. Odds come in
// thousandths (3150 = 3.15), lines too (2500 = 2.5). Read-only; cached 5 minutes. Only fixtures that a
// caller asks about are fetched in full (`ids`), so a board costs one list call + one call per match.

import { emptyFair, powerDevig, type FairMarkets, type RefBoard } from './reference'

const BASE = 'https://eu-offering-api.kambicdn.com/offering/v2018/ub'
const Q = 'lang=en_GB&market=GB'
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }

interface KEvent { id: number; homeName?: string; awayName?: string; start: string; group?: string; state?: string }
interface KOutcome { label?: string; englishLabel?: string; type?: string; odds?: number; line?: number; participant?: string }
interface KOffer { criterion?: { englishLabel?: string; lifetime?: string }; betOfferType?: { englishName?: string }; outcomes?: KOutcome[] }

const get = async <T>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000), cache: 'no-store' })
  if (!r.ok) throw new Error(`Kambi ${url.split('?')[0].slice(-60)}: HTTP ${r.status}`)
  return r.json() as Promise<T>
}

let listCache: { at: number; fixtures: RefBoard['fixtures'] } | null = null
const fairCache = new Map<string, { at: number; f: FairMarkets | null }>()

/** Parse one Kambi fixture's full-time markets into fair probabilities. */
export function parseKambiOffers(ev: KEvent, offers: KOffer[]): FairMarkets {
  const f = emptyFair()
  const halfLine = (x: number) => Number.isInteger(x * 2) && !Number.isInteger(x)
  for (const o of offers) {
    const label = o.criterion?.englishLabel ?? ''
    if (o.criterion?.lifetime && o.criterion.lifetime !== 'FULL_TIME') continue
    const outs = o.outcomes ?? []
    const odds = (x?: KOutcome) => (x?.odds ?? 0) / 1000
    if (label === 'Full Time') {
      const h = outs.find(x => x.type === 'OT_ONE'), d = outs.find(x => x.type === 'OT_CROSS'), a = outs.find(x => x.type === 'OT_TWO')
      if (h && d && a && odds(h) > 1 && odds(d) > 1 && odds(a) > 1) { const [ph, pd, pa] = powerDevig([odds(h), odds(d), odds(a)]); f.moneyline = { home: ph, draw: pd, away: pa } }
    } else if (label === 'Total Goals' || label.startsWith('Total Goals by ')) {
      const ov = outs.find(x => x.type === 'OT_OVER'), un = outs.find(x => x.type === 'OT_UNDER')
      if (!ov || !un || ov.line == null || odds(ov) <= 1 || odds(un) <= 1) continue
      const line = ov.line / 1000; if (!halfLine(line)) continue
      const [po] = powerDevig([odds(ov), odds(un)])
      if (label === 'Total Goals') f.totals.set(line, po)
      else { const team = label.slice('Total Goals by '.length); if (team === ev.homeName) f.teamTotals.home.set(line, po); else if (team === ev.awayName) f.teamTotals.away.set(line, po) }
    }
  }
  return f
}

/** Kambi's pre-match football board. `ids` limits the per-fixture market calls to the fixtures needed. */
export async function fetchKambiBoard(ids?: Set<string>): Promise<RefBoard> {
  if (!listCache || Date.now() - listCache.at > 5 * 60_000) {
    const j = await get<{ events?: { event: KEvent }[] }>(`${BASE}/listView/football/all/all/all/matches.json?${Q}&useCombined=true`)
    listCache = { at: Date.now(), fixtures: (j.events ?? []).map(e => e.event).filter(e => e.homeName && e.awayName && e.state !== 'STARTED')
      .map(e => ({ id: String(e.id), home: e.homeName!, away: e.awayName!, start: e.start, league: e.group ?? '' })) }
  }
  const fixtures = listCache.fixtures
  const fair = new Map<string, FairMarkets>()
  const want = fixtures.filter(f => !ids || ids.has(f.id))
  for (let i = 0; i < want.length; i += 8) {
    await Promise.all(want.slice(i, i + 8).map(async fx => {
      const c = fairCache.get(fx.id)
      if (c && Date.now() - c.at < 5 * 60_000) { if (c.f) fair.set(fx.id, c.f); return }
      try {
        const j = await get<{ betOffers?: KOffer[]; events?: KEvent[] }>(`${BASE}/betoffer/event/${fx.id}.json?${Q}`)
        const ev = j.events?.[0] ?? { id: Number(fx.id), homeName: fx.home, awayName: fx.away, start: fx.start }
        const f = parseKambiOffers(ev, j.betOffers ?? [])
        fairCache.set(fx.id, { at: Date.now(), f }); fair.set(fx.id, f)
      } catch { fairCache.set(fx.id, { at: Date.now(), f: null }) }
    }))
  }
  return { source: 'kambi', weight: 1, fixtures, fair }
}
