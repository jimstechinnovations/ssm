// __tests__/lib/pedlas/modes.live.test.ts
// OPT-IN structural backtest of Coverage vs Moonshot on REAL results.
//   PEDLAS_BACKTEST=1 npx vitest run __tests__/lib/pedlas/modes.live.test.ts
// Odds are SYNTHESISED from the history model (+6% margin) because real Betway odds history isn't
// available — so this measures STRUCTURE + variance (P(any hit), ROI), with EV pinned at −vig.

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Fixture } from '../../../lib/ssm/types'
import type { MatchResult } from '../../../lib/pedlas/predict'
import { estimateLambdas, pHatOver } from '../../../lib/pedlas/predict'
import { selectAxes } from '../../../lib/pedlas/market-select'
import { buildPedlasBook } from '../../../lib/pedlas/build'
import type { PedlasObjective } from '../../../lib/pedlas/types'

function env(k: string): string {
  const l = readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).trim() : ''
}
async function getEvents(base: string, key: string, id: number): Promise<MatchResult[]> {
  const url = `${base}/?action=get_events&from=2026-01-01&to=${new Date().toISOString().slice(0, 10)}&league_id=${id}&APIkey=${key}`
  const j = await (await fetch(url)).json().catch(() => null)
  if (!Array.isArray(j)) return []
  return j.filter((e: Record<string, string>) => e.match_status === 'Finished' && e.match_hometeam_score !== '')
    .map((e: Record<string, string>) => ({ date: e.match_date, home: e.match_hometeam_name, away: e.match_awayteam_name, hg: +e.match_hometeam_score, ag: +e.match_awayteam_score }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

const LINES = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
const MARGIN = 1.06
function synthFixture(id: number, m: MatchResult, lh: number, la: number): Fixture {
  const odds = LINES.flatMap(line => {
    const pOver = Math.min(0.97, Math.max(0.03, pHatOver(lh, la, line)))
    const oOver = Math.max(1.01, 1 / (pOver * MARGIN)), oUnder = Math.max(1.01, 1 / ((1 - pOver) * MARGIN))
    return [
      { bookmaker: 'syn', market: `OVER_UNDER_${line}` as Fixture['odds'][number]['market'], label: `Over ${line}`, value: +oOver.toFixed(2) },
      { bookmaker: 'syn', market: `OVER_UNDER_${line}` as Fixture['odds'][number]['market'], label: `Under ${line}`, value: +oUnder.toFixed(2) },
    ]
  })
  return { id, homeTeam: m.home, awayTeam: m.away, league: 'x', leagueId: id % 7, kickoff: `${m.date}T12:00:00Z`, odds }
}

const LEAGUES = [118, 253, 307, 219, 332, 99, 209]
const BUDGETS = [800, 2000, 5000, 10000, 20000]
const run = process.env.PEDLAS_BACKTEST ? it : it.skip

describe('LIVE — Coverage vs Moonshot structural backtest', () => {
  run('P(any hit) and ROI by mode and budget', async () => {
    const base = env('APIFOOTBALL_URL') || 'https://apiv3.apifootball.com', key = env('APIFOOTBALL_KEY')

    // Build synthetic, walk-forward fixtures across all leagues, then pool + chunk into 10-game slates.
    const priced: { date: string; fx: Fixture; total: number }[] = []
    for (const id of LEAGUES) {
      const ev = await getEvents(base, key, id)
      for (let i = 40; i < ev.length; i++) {
        const m = ev[i]; const lam = estimateLambdas(ev.slice(0, i), m.home, m.away, m.date)
        if (lam.nHome < 3 || lam.nAway < 3) continue
        priced.push({ date: m.date, fx: synthFixture(priced.length, m, lam.lambdaHome, lam.lambdaAway), total: m.hg + m.ag })
      }
    }
    priced.sort((a, b) => a.date.localeCompare(b.date))

    const L = 10
    const acc: Record<string, { slates: number; hits: number; staked: number; returned: number }> = {}
    const keyOf = (mode: string, b: number) => `${mode}@${b}`

    for (let s = 0; s + L <= priced.length; s += L) {
      const slate = priced.slice(s, s + L)
      const axes = selectAxes(slate.map(x => x.fx))
      if (axes.length < 6) continue
      const totalById = new Map(slate.map(x => [x.fx.id, x.total]))
      const hits = (legs: { fixtureId: number; side: string; line: number }[]) =>
        legs.every(l => { const t = totalById.get(l.fixtureId); return t == null ? false : (l.side === 'Over' ? t > l.line : t < l.line) })

      for (const mode of ['coverage', 'moonshot'] as PedlasObjective[]) {
        for (const budget of BUDGETS) {
          const book = await buildPedlasBook({ axes, budget, minStake: 100, objective: mode, rank: 'deterministic', params: { maxPerLeague: 99 } })
          const ret = book.slips.reduce((sum, sl) => sum + (hits(sl.legs) ? sl.payout : 0), 0)
          const k = keyOf(mode, budget); const a = acc[k] ?? { slates: 0, hits: 0, staked: 0, returned: 0 }
          a.slates++; a.hits += ret > 0 ? 1 : 0; a.staked += book.totalStake; a.returned += ret; acc[k] = a
        }
      }
    }

    console.log(`\nslates tested: ${(acc['coverage@800']?.slates) ?? 0}  (L=${L} legs each, synthetic odds @6% margin)\n`)
    console.log('mode      budget   K   P(any hit)   ROI      avg back/slate')
    for (const mode of ['coverage', 'moonshot']) {
      for (const b of BUDGETS) {
        const a = acc[keyOf(mode, b)]; if (!a) continue
        console.log(`  ${mode.padEnd(8)} ${String(b).padStart(6)}  ${String(Math.floor(b / 100)).padStart(3)}  ${(100 * a.hits / a.slates).toFixed(1).padStart(6)}%   ${(100 * a.returned / a.staked).toFixed(0).padStart(4)}%   ₦${Math.round(a.returned / a.slates).toLocaleString()}`)
      }
    }
  }, 300_000)
})
