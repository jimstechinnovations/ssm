// lib/spm/leg-stacker.ts
// SPM max-win engine: from a candidate pool, select clean (low-margin, ≥1.20)
// legs, stack them toward the boost ceiling, and report — honestly — whether the
// ₦100→₦max shot is +EV. It's all-or-nothing (hit all legs or lose), but the leg
// SELECTION is data-driven, never blind.

export interface MarketPair {
  game: string
  market: string     // 'O/U 2.5' | 'BTTS' | 'Odd/Even' | ...
  sideLabel: string  // the side we'd bet, e.g. 'Over 2.5'
  odds: number       // odds of the side we bet
  oppOdds: number    // odds of its complement (to de-vig / measure margin)
}

export interface Leg {
  game: string
  market: string
  side: string
  odds: number
  margin: number // two-way overround = 1/odds + 1/oppOdds − 1
  pBook: number  // de-vigged true prob of the bet side
}

/** Measure a leg's real two-way margin and de-vigged probability from the pair. */
export function legFrom(p: MarketPair): Leg {
  const iA = 1 / p.odds
  const iB = 1 / p.oppOdds
  const margin = iA + iB - 1
  const pBook = iA / (iA + iB)
  return { game: p.game, market: p.market, side: p.sideLabel, odds: p.odds, margin, pBook }
}

/** Clean selection: eligible (≥ minOdds), then the lowest-margin `count` legs. */
export function selectLegs(
  pairs: MarketPair[],
  opts: { count: number; minOdds?: number; maxMargin?: number },
): Leg[] {
  const minOdds = opts.minOdds ?? 1.20
  let legs = pairs.map(legFrom).filter(l => l.odds >= minOdds)
  const maxMargin = opts.maxMargin
  if (maxMargin != null) legs = legs.filter(l => l.margin <= maxMargin)
  legs.sort((a, b) => a.margin - b.margin) // lowest margin first — clean, not blind
  return legs.slice(0, opts.count)
}

const BOOST_TABLE: Record<number, number> = {
  3: 0.03, 4: 0.05, 5: 0.08, 6: 0.10, 7: 0.12, 8: 0.14, 9: 0.16, 10: 0.18, 11: 0.20, 12: 0.22,
  13: 0.25, 14: 0.30, 15: 0.35, 16: 0.40, 17: 0.45, 18: 0.50, 19: 0.55, 20: 0.60, 21: 0.65,
  22: 0.70, 23: 0.75, 24: 0.80, 25: 0.90, 26: 0.95, 27: 1.00, 28: 1.20, 29: 1.40, 30: 1.60,
  31: 1.80, 32: 2.00, 33: 2.20, 34: 2.40, 35: 2.60, 36: 2.80, 37: 3.00, 38: 3.25, 39: 3.50,
  40: 3.75, 41: 4.00, 42: 4.25, 43: 4.50, 44: 4.75, 45: 5.00, 46: 6.00, 47: 7.00, 48: 8.00,
  49: 9.00, 50: 10.00,
}
export function boostFor(n: number): number {
  if (n < 3) return 0
  if (n >= 50) return 10.0
  return BOOST_TABLE[n] ?? 0
}

export interface SlipPlan {
  legCount: number
  avgMargin: number
  combinedOdds: number
  boost: number
  pHit: number       // Π pBook — probability all legs land
  rawMaxWin: number  // stake × O × (1+boost), before the cap
  maxWin: number     // capped
  capped: boolean
  evMultiple: number // uncapped EV per ₦1 = Π(1/(1+margin)) × (1+boost)
  evWithCap: number  // realistic EV per ₦1 once the cap bites
}

export function planSlip(legs: Leg[], opts: { stake: number; cap: number }): SlipPlan {
  const combinedOdds = legs.reduce((a, l) => a * l.odds, 1)
  const boost = boostFor(legs.length)
  const pHit = legs.reduce((a, l) => a * l.pBook, 1)
  const rawMaxWin = opts.stake * combinedOdds * (1 + boost)
  const maxWin = Math.min(rawMaxWin, opts.cap)
  const evMultiple = legs.reduce((a, l) => a * (1 / (1 + l.margin)), 1) * (1 + boost)
  const evWithCap = (pHit * maxWin) / opts.stake
  const avgMargin = legs.reduce((a, l) => a + l.margin, 0) / legs.length
  return {
    legCount: legs.length, avgMargin, combinedOdds, boost, pHit,
    rawMaxWin, maxWin, capped: rawMaxWin > opts.cap, evMultiple, evWithCap,
  }
}

/** Break-even per-leg margin for a given leg count: (1+m)^N = (1+boost) ⇒ m*. */
export function breakEvenMargin(n: number): number {
  return Math.pow(1 + boostFor(n), 1 / n) - 1
}

// ── Hard rule: a slip may not contain the same match twice ──────────────────────
export function hasDuplicateMatch(legs: Leg[]): boolean {
  const seen = new Set<string>()
  for (const l of legs) {
    if (seen.has(l.game)) return true
    seen.add(l.game)
  }
  return false
}

// ── Group candidate markets by match (one match may offer several outcomes) ─────
export interface MatchCandidates {
  match: string
  outcomes: Leg[] // eligible outcomes for this match, lowest-margin first
}

export function groupByMatch(pairs: MarketPair[], minOdds = 1.20): MatchCandidates[] {
  const map = new Map<string, Leg[]>()
  for (const p of pairs) {
    const leg = legFrom(p)
    if (leg.odds < minOdds) continue
    const arr = map.get(leg.game)
    if (arr) arr.push(leg)
    else map.set(leg.game, [leg])
  }
  return [...map.entries()].map(([match, outcomes]) => ({
    match,
    outcomes: outcomes.sort((a, b) => a.margin - b.margin),
  }))
}

/** Base slip: each match's best outcome, top `count` matches by margin. One leg per match. */
export function selectBaseSlip(matches: MatchCandidates[], count: number): Leg[] {
  const primaries = matches.map(m => m.outcomes[0]).sort((a, b) => a.margin - b.margin)
  return primaries.slice(0, count)
}

// ── Ticket book: base + outcome-variations on the riskiest matches ──────────────
// Each variation swaps ONE match's outcome for an alternative (still one leg per match),
// giving a second shot if that match's primary outcome can't be achieved.
export interface TicketBook {
  slips: Leg[][]
  pBase: number
  pAnyHit: number    // disjoint approximation: Σ P(slip wins)
  variedMatches: string[]
}

export function buildTicketBook(
  matches: MatchCandidates[],
  opts: { legCount: number; shots: number },
): TicketBook {
  const base = selectBaseSlip(matches, opts.legCount)
  const byMatch = new Map(matches.map(m => [m.match, m]))
  const pBase = base.reduce((a, l) => a * l.pBook, 1)

  // riskiest base legs (lowest pBook) that have an alternative outcome on the same match
  const risky = base
    .map((l, idx) => ({ l, idx, alt: byMatch.get(l.game)?.outcomes[1] }))
    .filter((x): x is { l: Leg; idx: number; alt: Leg } => !!x.alt)
    .sort((a, b) => a.l.pBook - b.l.pBook)
    .slice(0, opts.shots - 1)

  const slips: Leg[][] = [base]
  const variedMatches: string[] = []
  for (const r of risky) {
    const slip = base.slice()
    slip[r.idx] = r.alt // swap primary → alternative outcome (same match, still unique)
    slips.push(slip)
    variedMatches.push(r.l.game)
  }
  const pAnyHit = slips.reduce((a, s) => a + s.reduce((x, l) => x * l.pBook, 1), 0)
  return { slips, pBase, pAnyHit, variedMatches }
}

// ── Mode S — Bet Saver survival band ────────────────────────────────────────────
function logFact(k: number): number { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s }
function binomPmf(n: number, k: number, p: number): number {
  return Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p))
}

/** Bet Saver near-miss band for N legs (31 → [26,30]). */
export function betSaverBand(n: number): [number, number] { return [n - 5, n - 1] }

export interface BandResult {
  pFullHit: number
  expectedCorrect: number
  pInBand: number // P(correct count lands in the Bet Saver near-miss band)
}

export function binomialBand(n: number, p: number): BandResult {
  const [lo, hi] = betSaverBand(n)
  let pInBand = 0
  for (let k = lo; k <= hi; k++) pInBand += binomPmf(n, k, p)
  return { pFullHit: Math.pow(p, n), expectedCorrect: n * p, pInBand }
}

/** Mode M → 50 (max boost); Mode S → the Bet Saver leg count (default 31). */
export function chooseLegCount(_pbar: number, mode: 'survival' | 'maxwin', betSaverN = 31): number {
  return mode === 'maxwin' ? 50 : betSaverN
}

// ── Prediction layer (spm_v2): the optional +EV lever ───────────────────────────
// p̂ is your own probability estimate (sharp-book reference or a calibrated model).
// Edge e = p̂ / p_book; only e > 1 is genuine edge (the boost is mere rebate).

/** Edge ratio for a leg given an independent estimate p̂. */
export function legEdge(leg: Leg, pHat: number): number {
  return pHat / leg.pBook
}

/** Break-even per-leg edge at N legs and a given two-way margin: e* = (1+m)/(1+boost)^(1/N). */
export function breakEvenEdge(n: number, margin: number): number {
  return (1 + margin) / Math.pow(1 + boostFor(n), 1 / n)
}

export interface EdgePlan {
  evMultiple: number   // Π(p̂·o) × (1+boost) — >1 ⇒ +EV
  productEdge: number  // Π e — the total edge stacked across legs
  positiveEV: boolean
  marginOfSafety: number // evMultiple − 1
}

/**
 * Slip EV using your own per-leg estimates p̂. Only this — not the boost or the
 * coverage — can move the EV above 1.0 honestly.
 */
export function slipEVWithEdge(legs: Leg[], pHat: (l: Leg) => number, boostOverride?: number): EdgePlan {
  const boost = boostOverride ?? boostFor(legs.length)
  const evMultiple = legs.reduce((a, l) => a * (pHat(l) * l.odds), 1) * (1 + boost)
  const productEdge = legs.reduce((a, l) => a * (pHat(l) / l.pBook), 1)
  return { evMultiple, productEdge, positiveEV: evMultiple > 1, marginOfSafety: evMultiple - 1 }
}
