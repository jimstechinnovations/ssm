// __tests__/lib/pedlas/predict.live.test.ts
// OPT-IN real-data backtest (network). Run with:  PEDLAS_BACKTEST=1 npx vitest run <thisfile>
// Skipped in normal CI. Measures which MARKETS the history model is calibrated on, across leagues.

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { MatchResult } from '../../../lib/pedlas/predict'
import { backtestMarket } from '../../../lib/pedlas/predict'
import type { FpMarket } from '../../../lib/pedlas/fingerprint'

function env(k: string): string {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/).find(l => l.startsWith(k + '='))
  return line ? line.slice(k.length + 1).trim() : ''
}

async function getEvents(base: string, key: string, leagueId: number, from: string, to: string): Promise<MatchResult[]> {
  const url = `${base}/?action=get_events&from=${from}&to=${to}&league_id=${leagueId}&APIkey=${key}`
  const j = await (await fetch(url)).json().catch(() => null)
  if (!Array.isArray(j)) return []
  return j
    .filter((e: Record<string, string>) => e.match_status === 'Finished' && e.match_hometeam_score !== '')
    .map((e: Record<string, string>) => ({
      date: e.match_date, home: e.match_hometeam_name, away: e.match_awayteam_name,
      hg: Number(e.match_hometeam_score), ag: Number(e.match_awayteam_score),
    }))
}

const LEAGUES = [
  { id: 118, name: 'China CSL' }, { id: 253, name: 'Norway' }, { id: 307, name: 'Sweden' },
  { id: 219, name: 'Korea K1' }, { id: 332, name: 'USA MLS' }, { id: 99, name: 'Brazil' }, { id: 209, name: 'Japan J1' },
]
const MARKETS: FpMarket[] = ['OVER_1_5', 'OVER_2_5', 'OVER_3_5', 'OVER_4_5', 'BTTS_YES', 'HOME', 'DRAW', 'AWAY', 'DC1X', 'DC12', 'DCX2']

const run = process.env.PEDLAS_BACKTEST ? it : it.skip

describe('LIVE backtest — which markets are predictable', () => {
  run('pools model skill per market across in-season leagues', async () => {
    const base = env('APIFOOTBALL_URL') || 'https://apiv3.apifootball.com'
    const key = env('APIFOOTBALL_KEY')
    const from = '2026-01-01', to = new Date().toISOString().slice(0, 10)

    const histories: MatchResult[][] = []
    for (const lg of LEAGUES) {
      const h = await getEvents(base, key, lg.id, from, to)
      console.log(`  ${lg.name}: ${h.length} matches`)
      if (h.length >= 40) histories.push(h)
    }

    console.log('\nmarket      pooled-n  base%  impliedOdds  skill%   (skill>0 ⇒ model beats base rate)')
    const rows: { m: string; skill: number; base: number; n: number }[] = []
    for (const market of MARKETS) {
      let nSum = 0, bm = 0, bb = 0, brSum = 0
      for (const h of histories) {
        const r = backtestMarket(h, market, { warmupMatches: 30 })
        nSum += r.n; bm += r.brierModel * r.n; bb += r.brierBaseline * r.n; brSum += r.baseRate * r.n
      }
      if (nSum === 0) continue
      const base_ = brSum / nSum, skill = bb > 0 ? 1 - bm / bb : 0
      rows.push({ m: market, skill, base: base_, n: nSum })
      console.log(`  ${market.padEnd(10)} ${String(nSum).padStart(6)}   ${(base_ * 100).toFixed(0).padStart(3)}%   ${(1 / base_).toFixed(2).padStart(6)}      ${(skill * 100).toFixed(1).padStart(5)}`)
    }
    rows.sort((a, b) => b.skill - a.skill)
    console.log('\nBest markets by skill:', rows.slice(0, 4).map(r => `${r.m} ${(r.skill * 100).toFixed(1)}% (odds~${(1 / r.base).toFixed(2)})`).join('  |  '))
  }, 180_000)
})
