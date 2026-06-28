// __tests__/lib/pedlas/edge.live.test.ts
// OPT-IN: does OUR model (history + odds) beat the BOOK out-of-sample?  Run with:
//   PEDLAS_BACKTEST=1 npx vitest run __tests__/lib/pedlas/edge.live.test.ts
// Rate-limit strategy demonstrated: every apifootball call is disk-cached + throttled, so re-runs
// are instant and a partial run resumes. The ONLY honest definition of edge: lower out-of-sample
// log-loss than the bookmaker's de-vigged price.

import { describe, it } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MatchResult } from '../../../lib/pedlas/predict'
import { estimateLambdas, pHatOver } from '../../../lib/pedlas/predict'
import { trainLogReg, predictLogReg, logLoss } from '../../../lib/pedlas/model'

function env(k: string): string {
  const l = readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).trim() : ''
}
const CACHE = join(tmpdir(), 'pedlas-exp'); if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function cachedJson(file: string, url: string): Promise<unknown> {
  const p = join(CACHE, file)
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  await sleep(60)
  const j = await (await fetch(url)).json().catch(() => null)
  writeFileSync(p, JSON.stringify(j))
  return j
}

interface Ev extends MatchResult { matchId: string }
async function getEvents(base: string, key: string, id: number): Promise<Ev[]> {
  const j = await cachedJson(`ev_${id}.json`, `${base}/?action=get_events&from=2026-01-01&to=${new Date().toISOString().slice(0, 10)}&league_id=${id}&APIkey=${key}`)
  if (!Array.isArray(j)) return []
  return j.filter((e: Record<string, string>) => e.match_status === 'Finished' && e.match_hometeam_score !== '' && e.match_id)
    .map((e: Record<string, string>) => ({ matchId: e.match_id, date: e.match_date, home: e.match_hometeam_name, away: e.match_awayteam_name, hg: +e.match_hometeam_score, ag: +e.match_awayteam_score }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** De-vigged P(Over line) averaged across bookmakers, or null if unpriced. */
async function bookOver(base: string, key: string, matchId: string, line: number): Promise<number | null> {
  const j = await cachedJson(`od_${matchId}.json`, `${base}/?action=get_odds&match_id=${matchId}&APIkey=${key}`)
  if (!Array.isArray(j) || !j.length) return null
  let io = 0, iu = 0, n = 0
  for (const r of j as Record<string, string>[]) {
    const o = parseFloat(r[`o+${line}`]), u = parseFloat(r[`u+${line}`])
    if (o > 1 && u > 1) { io += 1 / o; iu += 1 / u; n++ }
  }
  if (!n) return null
  io /= n; iu /= n
  return io / (io + iu)
}

const LEAGUES = [118, 253, 307, 219, 332, 99]
const LINES = [1.5, 2.5, 3.5, 4.5]
const MAX_PER_LEAGUE = 70
const run = process.env.PEDLAS_BACKTEST ? it : it.skip

describe('LIVE — does our model beat the book?', () => {
  run('out-of-sample log-loss: book vs model(book+history) vs model(history-only)', async () => {
    const base = env('APIFOOTBALL_URL') || 'https://apiv3.apifootball.com', key = env('APIFOOTBALL_KEY')
    type Row = { date: string; bookP: number; pHist: number; lamTot: number; y: number }
    const byLine: Record<number, Row[]> = { 1.5: [], 2.5: [], 3.5: [], 4.5: [] }

    for (const id of LEAGUES) {
      const ev = await getEvents(base, key, id)
      let used = 0
      for (let i = 40; i < ev.length && used < MAX_PER_LEAGUE; i++) {
        const m = ev[i]
        const lam = estimateLambdas(ev.slice(0, i), m.home, m.away, m.date)
        if (lam.nHome < 3 || lam.nAway < 3) continue
        used++
        for (const line of LINES) {
          const bp = await bookOver(base, key, m.matchId, line)
          if (bp == null) continue
          byLine[line].push({ date: m.date, bookP: bp, pHist: pHatOver(lam.lambdaHome, lam.lambdaAway, line), lamTot: lam.lambdaHome + lam.lambdaAway, y: (m.hg + m.ag) > line ? 1 : 0 })
        }
      }
    }

    console.log('\nline   n     base   bookLoss  model(book+hist)  model(hist-only)   edge vs book')
    for (const line of LINES) {
      const rows = byLine[line].sort((a, b) => a.date.localeCompare(b.date))
      if (rows.length < 120) { console.log(`  O${line}: only ${rows.length} samples`); continue }
      const tr = Math.floor(rows.length * 0.7)
      const train = rows.slice(0, tr), test = rows.slice(tr)
      const y = test.map(r => r.y)
      const base_ = train.reduce((s, r) => s + r.y, 0) / train.length

      const bookLoss = logLoss(test.map(r => r.bookP), y)
      const mBH = trainLogReg(train.map(r => [r.bookP, r.pHist, r.lamTot]), train.map(r => r.y), { featureNames: ['bookP', 'pHist', 'lamTot'] })
      const lossBH = logLoss(test.map(r => predictLogReg(mBH, [r.bookP, r.pHist, r.lamTot])), y)
      const mH = trainLogReg(train.map(r => [r.pHist, r.lamTot]), train.map(r => r.y), { featureNames: ['pHist', 'lamTot'] })
      const lossH = logLoss(test.map(r => predictLogReg(mH, [r.pHist, r.lamTot])), y)
      const edge = ((bookLoss - lossBH) / bookLoss) * 100

      console.log(`  O${line}  ${String(test.length).padStart(4)}  ${(base_ * 100).toFixed(0).padStart(4)}%  ${bookLoss.toFixed(4)}    ${lossBH.toFixed(4)}            ${lossH.toFixed(4)}        ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}%  (book weight ${mBH.weights[0].toFixed(2)}, hist ${mBH.weights[1].toFixed(2)})`)
    }
    console.log('\nedge vs book > 0 ⇒ our model beats the bookmaker out-of-sample on that market.')
  }, 600_000)
})
