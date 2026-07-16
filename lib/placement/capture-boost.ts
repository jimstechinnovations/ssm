// lib/placement/capture-boost.ts
// Capture a book's REAL multi-bet boost by reading the bookmaker's own betslip (not guessing).
// For each leg count N it drives scripts/check-payout.mjs (proven CDP betslip read) which loads N
// qualifying Under-4.5 legs and prints the site's Odds + Potential Win + Max bonus at a ₦10 stake.
// boost fraction(N) = PotentialWin / (stake · odds) − 1. The resulting table feeds the L/payout math
// (book_configs.boost_json) so payouts match what SportyBet actually pays.

import 'server-only'
import { spawn } from 'node:child_process'
import { cdpUp } from './browser'

export interface BoostRow { legs: number; odds: number; potentialWin: number; maxBonus: number; fraction: number }

const STAKE = 10

/** Run scripts/check-payout.mjs for one leg count; parse the site's reported numbers. */
function readOne(n: number): Promise<BoostRow | null> {
  return new Promise((resolve) => {
    let out = ''
    const p = spawn('node', ['scripts/check-payout.mjs', String(n)], { shell: process.platform === 'win32' })
    p.stdout.on('data', (d) => { out += d.toString() })
    p.stderr.on('data', () => {})
    const done = () => {
      const num = (re: RegExp) => { const m = out.match(re); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
      const legs = parseInt(out.match(/legs shown:\s*(\d+)/i)?.[1] ?? '0', 10)
      const odds = num(/Odds:\s*([\d,.]+)/i)
      const pw = num(/Potential Win:\s*([\d,.]+)/i)
      const bonus = num(/Max bonus:\s*([\d,.]+)/i)
      if (legs > 0 && Number.isFinite(odds) && odds > 1 && Number.isFinite(pw) && pw > 0) {
        resolve({ legs, odds, potentialWin: pw, maxBonus: Number.isFinite(bonus) ? bonus : 0, fraction: Math.max(0, pw / (STAKE * odds) - 1) })
      } else resolve(null)
    }
    p.on('close', done)
    p.on('error', () => resolve(null))
  })
}

/**
 * Sweep leg counts and return the measured boost table (sorted by legs). Requires the debug Chrome
 * on :9222 (the UI can launch it). Books other than SportyBet aren't wired to check-payout yet.
 */
export async function captureSportybetBoost(legCounts: number[] = [3, 6, 10, 15, 20, 25, 30]): Promise<BoostRow[]> {
  if (!(await cdpUp())) throw new Error('debug Chrome is not up on :9222 — launch the browser first')
  const rows: BoostRow[] = []
  for (const n of legCounts) {
    const row = await readOne(n)
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => a.legs - b.legs)
}

/** The [{legs, fraction}] shape stored in book_configs.boost_json (consumed by boostFromTable). */
export function toBoostTable(rows: BoostRow[]): { legs: number; fraction: number }[] {
  return rows.map(r => ({ legs: r.legs, fraction: Number(r.fraction.toFixed(4)) }))
}
