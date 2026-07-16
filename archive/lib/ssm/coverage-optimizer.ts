// lib/ssm/coverage-optimizer.ts
// Optimal coverage of the 2^N binary session space on a TRUE axis (total goals).
//
// Each game is a real complement (state0 = dominant, state1 = breakout). A session
// is one of 2^N vectors with probability ∏ p_i and odds ∏ odds_i. Exactly one vector
// occurs, so the vectors are mutually exclusive.
//
// We pick the highest-probability vectors until the "book cost" c(S) = Σ 1/O(v) hits a
// target, then Dutch the stakes so EVERY covered vector returns the same amount
// T = bankroll / c(S). Consequences:
//   - win rate      = Σ p(v) over chosen vectors
//   - return-if-hit = bankroll / c(S)   (identical for every covered outcome → no dead small wins)
//   - costTarget 1.0 ⇒ break-even on every win; < 1.0 ⇒ profit on every win (lower win rate)
//   - EV is invariant (= bankroll / book-overround) — the dial trades win rate vs margin, not EV.

export interface GameAxis {
  name: string
  p0: number; odds0: number; label0: string // dominant state (higher true prob)
  p1: number; odds1: number; label1: string // breakout state
}

export interface CoverSlip {
  vector: (0 | 1)[]
  flips: number // games in their breakout state (deviations from the modal session)
  trueProb: number
  combinedOdds: number
  stake: number
  returnIfHit: number
}

export interface CoverageResult {
  bankroll: number
  costTarget: number
  slips: CoverSlip[]
  winRate: number
  costOfCoverage: number
  returnPerHit: number
  netOnHit: number
  uncoveredProb: number
  expectedValue: number
  belowMinStake: number
}

/** Build an axis, forcing state0 to be the higher-probability (dominant) side. */
export function makeAxis(
  name: string,
  pA: number, oddsA: number, labelA: string,
  pB: number, oddsB: number, labelB: string,
): GameAxis {
  return pA >= pB
    ? { name, p0: pA, odds0: oddsA, label0: labelA, p1: pB, odds1: oddsB, label1: labelB }
    : { name, p0: pB, odds0: oddsB, label0: labelB, p1: pA, odds1: oddsA, label1: labelA }
}

interface RawVector { vector: (0 | 1)[]; trueProb: number; combinedOdds: number }

/** All 2^N vectors with their true probability and combined odds. */
export function enumerateVectors(games: GameAxis[]): RawVector[] {
  const n = games.length
  if (n > 16) throw new Error(`enumerateVectors: ${n} games is too many (2^${n})`)
  const out: RawVector[] = []
  for (let mask = 0; mask < (1 << n); mask++) {
    const vector: (0 | 1)[] = []
    let prob = 1
    let odds = 1
    for (let i = 0; i < n; i++) {
      const bit = ((mask >> i) & 1) as 0 | 1
      vector.push(bit)
      prob *= bit === 0 ? games[i].p0 : games[i].p1
      odds *= bit === 0 ? games[i].odds0 : games[i].odds1
    }
    out.push({ vector, trueProb: prob, combinedOdds: odds })
  }
  return out
}

export function optimizeCoverage(
  games: GameAxis[],
  opts: { bankroll: number; costTarget?: number; minStake?: number },
): CoverageResult {
  const { bankroll, costTarget = 1.0, minStake = 100 } = opts

  // Highest-probability sessions first (modal vector, then single flips, then two-flips, …).
  const all = enumerateVectors(games).sort((a, b) => b.trueProb - a.trueProb)

  const chosen: RawVector[] = []
  let cost = 0
  for (const v of all) {
    const c = 1 / v.combinedOdds
    if (chosen.length > 0 && cost + c > costTarget) break
    chosen.push(v)
    cost += c
  }

  const returnPerHit = bankroll / cost
  const slips: CoverSlip[] = chosen.map(v => ({
    vector: v.vector,
    flips: v.vector.filter(b => b === 1).length,
    trueProb: v.trueProb,
    combinedOdds: v.combinedOdds,
    stake: bankroll / (cost * v.combinedOdds), // Dutch: every hit returns returnPerHit
    returnIfHit: returnPerHit,
  }))

  const winRate = chosen.reduce((s, v) => s + v.trueProb, 0)
  return {
    bankroll,
    costTarget,
    slips,
    winRate,
    costOfCoverage: cost,
    returnPerHit,
    netOnHit: returnPerHit - bankroll,
    uncoveredProb: 1 - winRate,
    expectedValue: winRate * returnPerHit,
    belowMinStake: slips.filter(s => s.stake < minStake).length,
  }
}
