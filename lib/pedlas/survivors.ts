// lib/pedlas/survivors.ts
// Survivors: given a family of slips and the state of their games, answer the operator's questions
// honestly, by simulation:
//
//  1. "How many are really alive?"   Finished games settle legs; games IN PLAY settle a leg as soon as the
//     score so far makes it impossible (an Under 0.5 dies at the first goal), as SportyBet itself does.
//  2. "Both ways": for every game still to finish, which slips ride on it, what each likely score
//     does to them, and the chance it cuts EVERY slip on it (a one-sided game).
//  3. "How many slips / what budget": P(at least one slip still alive after each game), P(≥1 win) as the
//     slip count grows, and what more slips or budget would buy, bounded by the honest identity
//     P(≥1 win) ≤ keep × budget ÷ target. More slips raise the chance about linearly; nothing beats it.
//
// Two passes over the same tables:
//  - NOW: from the current state (finished / in play / not started), over the slips still alive.
//  - PLAN: every game not started yet, over the whole family — what the family was worth before kickoff.
//    Budget questions ("how many slips for X%") are answered from this pass: a slip that already survived
//    six games is worth far more than a fresh one, and pricing new slips off survivors would lie high.
//
// Each game's scoreline table is rebuilt from the legs' own calibrated probabilities (every leg stores
// the P the build priced it at, from the book's de-vigged odds): an independent-Poisson start, then
// iterative proportional fitting so every distinct pick on the game matches its stored P. So picks on the
// same game stay correlated exactly as the book prices them (Under 0.5 and BTTS No overlap, etc.).
// Games are independent of each other, as the book prices them. Pure: no I/O.

import { ruleWins, type LegRule } from './selections'

const MAXG = 10
const N = MAXG + 1

export interface CovLeg { fixtureId: number; rule: LegRule; name: string; p: number }
export interface CovSlip { key: string; slipId: number; session?: string; stake: number; payout: number; legs: CovLeg[] }
/** A game's state: finished (final score), live (score so far + minute) or not started. */
export interface CovGame {
  fixtureId: number; game: string; kickoff: string
  state: { kind: 'final'; h: number; a: number } | { kind: 'live'; h: number; a: number; minute: number } | { kind: 'pending' }
}

export interface ScoreRow { score: string; p: number; survivors: number; pWinIf: number }   // pWinIf: P(≥1 win) if the game ends this way
export interface JourneyGame {
  fixtureId: number; game: string; kickoff: string; status: 'live' | 'pending'; liveScore?: string; minute?: number
  riding: number                                   // slips (alive in this pass) with a leg on this game
  picks: { name: string; p: number; slips: string[] }[]
  pAllCut: number                                  // P(every riding slip loses on this game)
  oneSided: boolean                                // ≥ 2 slips ride on it and it cuts them all ≥ 50% of the time
  scores: ScoreRow[]                               // most likely final scores → survivors among riding slips
  pAnyAliveAfter: number                           // P(≥1 slip of the family still alive after this game)
  expectedAliveAfter: number
  pWinIfBest: number                               // P(≥1 win) after this game's best likely result for us …
  pWinIfWorst: number                              // … and after its worst (0 when it can cut every slip)
}
export interface PassResult {
  slips: number
  pAnyWin: number
  expectedWinners: number
  sumP: number                                     // Σ P(slip wins): the ceiling P(≥1) can't exceed
  efficiency: number                               // pAnyWin ÷ sumP (1 = no two slips can both win)
  keep: number                                     // Σ P·payout ÷ staked
  journey: JourneyGame[]
  survivalDepth90: number                          // games (kickoff order) at least one slip survives in ≥ 90% of days
  slipCurve: { n: number; pAnyWin: number }[]      // P(≥1 win) using only the first n slips (slip order)
}
export interface CoverageResult {
  days: number
  slips: number                                    // slips in the family
  aliveNow: number                                 // after finished games AND live games' decided legs
  aliveAtFullTime: number                          // after finished games only (what settlement shows)
  earlyKilled: { key: string; game: string; pick: string; score: string }[]
  now: PassResult                                  // from the current state, alive slips only
  plan: PassResult                                 // the whole family before kickoff
  budget: {
    stake: number; target: number; keep: number; marginalPerSlip: number
    fromScratch: { goal: number; slips: number | null; budget: number | null; atBest: number }[]
    topUp: { goal: number; moreSlips: number | null; moreBudget: number | null }[]   // new slips on games not started
  }
  aliveSlips: { key: string; slipId: number; session?: string; pWin: number; payout: number; needs: number }[]
  /** How the chance moved: after each finished game (kickoff order), ≈ Σ over alive slips of Π P(legs
   *  left). It goes UP when a game goes our way (its uncertainty is gone) and DOWN when it cuts slips. */
  timeline: { game: string; kickoff: string; score: string | null; cut: number; aliveAfter: number; pAfter: number }[]
}

const pois = (l: number, k: number) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p }
function mulberry32(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const ruleKey = (r: LegRule) => JSON.stringify(r)
const maskOf = (r: LegRule) => Uint8Array.from({ length: N * N }, (_, i) => ruleWins(r, Math.floor(i / N), i % N) ? 1 : 0)

/** A scoreline table fitted so each distinct pick's probability matches its stored P (IPF). */
export function tableFromPicks(picks: { rule: LegRule; p: number }[]): Float64Array {
  const t = new Float64Array(N * N)
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) t[h * N + a] = pois(1.35, h) * pois(1.1, a)
  const norm = () => { let s = 0; for (const v of t) s += v; for (let i = 0; i < t.length; i++) t[i] /= s }
  norm()
  const seen = new Set<string>()
  const cons: { q: number; mask: Uint8Array }[] = []
  for (const x of picks) {
    const k = ruleKey(x.rule)
    if (x.p <= 0.001 || x.p >= 0.999 || seen.has(k)) continue
    seen.add(k); cons.push({ q: x.p, mask: maskOf(x.rule) })
  }
  for (let it = 0; it < 200; it++) {
    let worst = 0
    for (const c of cons) {
      let pin = 0, pout = 0
      for (let i = 0; i < t.length; i++) if (c.mask[i]) pin += t[i]; else pout += t[i]
      worst = Math.max(worst, Math.abs(pin / (pin + pout) - c.q))
      if (pin <= 1e-12 || pout <= 1e-12) continue
      const fin = c.q / pin, fout = (1 - c.q) / pout
      for (let i = 0; i < t.length; i++) t[i] *= c.mask[i] ? fin : fout
    }
    if (worst < 0.0005) break
  }
  norm()
  return t
}

/** Can this leg still win from a live score (some final h' ≥ h, a' ≥ a satisfies it)? */
export function stillPossible(rule: LegRule, h: number, a: number): boolean {
  for (let x = h; x <= MAXG; x++) for (let y = a; y <= MAXG; y++) if (ruleWins(rule, x, y)) return true
  return false
}

/** Final-score distribution of a game from its state: the fitted table, or (in play) score so far +
 *  Poisson goals still to come on each side, scaled by the time left. */
function finalDist(g: CovGame, t: Float64Array): Float64Array {
  if (g.state.kind !== 'live') return t
  let mh = 0, ma = 0
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) { mh += h * t[h * N + a]; ma += a * t[h * N + a] }
  const r = Math.max(0.03, (90 - g.state.minute) / 90), st = g.state
  const d = new Float64Array(N * N)
  for (let x = 0; x + st.h < N; x++) for (let y = 0; y + st.a < N; y++) d[(st.h + x) * N + (st.a + y)] = pois(mh * r, x) * pois(ma * r, y)
  return d
}

/** One simulation pass: the given games (in kickoff order, none final) decide the given slips. */
function runPass(open: CovGame[], slips: CovSlip[], tables: Map<number, Float64Array>, days: number, seed: number): PassResult {
  const rnd = mulberry32(seed)
  const dists = open.map(g => finalDist(g, tables.get(g.fixtureId)!))
  const cdfs = dists.map(d => { const c = new Float64Array(d.length); let s = 0; for (let i = 0; i < d.length; i++) { s += d[i]; c[i] = s } return c })
  const riders = open.map(g => slips.map((s, si) => ({ si, leg: s.legs.find(l => l.fixtureId === g.fixtureId) }))
    .filter(x => x.leg).map(x => ({ si: x.si, leg: x.leg!, mask: maskOf(x.leg!.rule) })))

  const S = slips.length
  const anyAfter = new Float64Array(open.length), sumAfter = new Float64Array(open.length)
  const firstWinHits = new Float64Array(S + 1)   // days whose FIRST winning slip (slip order) is index i
  const slipWins = new Float64Array(S)
  const isAlive = new Uint8Array(S)
  const cells = new Int32Array(open.length)
  const cellDays = new Float64Array(open.length * N * N), cellWins = new Float64Array(open.length * N * N)
  let wins = 0, winners = 0
  for (let d = 0; d < days; d++) {
    isAlive.fill(1); let count = S
    for (let gi = 0; gi < open.length; gi++) {
      const c = cdfs[gi], x = rnd() * c[c.length - 1]
      let lo = 0, hi = c.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < x) lo = mid + 1; else hi = mid }
      cells[gi] = lo
      for (const r of riders[gi]) if (isAlive[r.si] && !r.mask[lo]) { isAlive[r.si] = 0; count-- }
      if (count > 0) anyAfter[gi]++
      sumAfter[gi] += count
    }
    for (let gi = 0; gi < open.length; gi++) { const k = gi * N * N + cells[gi]; cellDays[k]++; if (count > 0) cellWins[k]++ }
    if (count > 0) { wins++; winners += count }
    let first = -1
    for (let i = 0; i < S; i++) if (isAlive[i]) { slipWins[i]++; if (first < 0) first = i }
    if (first >= 0) firstWinHits[first]++
  }

  const journey: JourneyGame[] = open.map((g, gi) => {
    const dist = dists[gi], rs = riders[gi]
    const byPick = new Map<string, { name: string; p: number; slips: string[] }>()
    for (const r of rs) { const k = ruleKey(r.leg.rule); const e = byPick.get(k) ?? { name: r.leg.name, p: r.leg.p, slips: [] }; e.slips.push(slips[r.si].key); byPick.set(k, e) }
    let tot = 0, allCut = 0
    for (let i = 0; i < dist.length; i++) { tot += dist[i]; if (rs.length && rs.every(r => !r.mask[i])) allCut += dist[i] }
    const top = Array.from(dist.keys()).sort((x, y) => dist[y] - dist[x]).slice(0, 12)
    // P(≥1 win | this final score): from the simulated days that drew it, or exact 0 when it cuts every
    // slip riding here and nothing else could still win
    const ifCell = (i: number) => { const k = gi * N * N + i; return cellDays[k] >= 30 ? cellWins[k] / cellDays[k] : NaN }
    const likely = top.filter(i => dist[i] / tot >= 0.03 && !Number.isNaN(ifCell(i)))
    return {
      fixtureId: g.fixtureId, game: g.game, kickoff: g.kickoff, status: g.state.kind === 'live' ? 'live' : 'pending',
      liveScore: g.state.kind === 'live' ? `${g.state.h}-${g.state.a}` : undefined, minute: g.state.kind === 'live' ? g.state.minute : undefined,
      riding: rs.length, picks: [...byPick.values()].sort((x, y) => y.slips.length - x.slips.length),
      pAllCut: tot ? allCut / tot : 0, oneSided: rs.length >= 2 && tot > 0 && allCut / tot >= 0.5,
      scores: top.map(i => ({ score: `${Math.floor(i / N)}-${i % N}`, p: dist[i] / tot, survivors: rs.filter(r => r.mask[i]).length, pWinIf: ifCell(i) })),
      pAnyAliveAfter: anyAfter[gi] / days, expectedAliveAfter: sumAfter[gi] / days,
      pWinIfBest: likely.length ? Math.max(...likely.map(ifCell)) : 0, pWinIfWorst: likely.length ? Math.min(...likely.map(ifCell)) : 0,
    }
  })
  let survivalDepth90 = 0
  for (const j of journey) { if (j.pAnyAliveAfter >= 0.9) survivalDepth90++; else break }

  const pAnyWin = wins / days
  const sumP = slipWins.reduce((x, v) => x + v / days, 0)
  const staked = slips.reduce((x, s) => x + s.stake, 0)
  const keep = staked ? slips.reduce((x, s, i) => x + (slipWins[i] / days) * s.payout, 0) / staked : 0
  const slipCurve: PassResult['slipCurve'] = []
  let acc = 0
  const step = Math.max(1, Math.ceil(S / 16))
  for (let i = 0; i < S; i++) { acc += firstWinHits[i]; if ((i + 1) % step === 0 || i === S - 1) slipCurve.push({ n: i + 1, pAnyWin: acc / days }) }
  return { slips: S, pAnyWin, expectedWinners: winners / days, sumP, efficiency: sumP ? pAnyWin / sumP : 0, keep, journey, survivalDepth90, slipCurve, _slipWins: slipWins } as PassResult & { _slipWins: Float64Array }
}

export function analyzeCoverage(gamesIn: CovGame[], slipsIn: CovSlip[], opts: { days?: number; seed?: number; target?: number; stake?: number } = {}): CoverageResult {
  const days = opts.days ?? 20000
  const games = [...gamesIn].sort((x, y) => x.kickoff.localeCompare(y.kickoff) || x.game.localeCompare(y.game))
  const gById = new Map(games.map(g => [g.fixtureId, g]))
  const stake = opts.stake ?? (slipsIn[0]?.stake ?? 10)
  const target = opts.target ?? Math.round(slipsIn.reduce((m, s) => Math.max(m, s.payout), 0))

  // ── 1. alive now ──
  const earlyKilled: CoverageResult['earlyKilled'] = []
  let aliveAtFullTime = 0
  const alive = slipsIn.filter(s => {
    let ftDead = false, liveDead: CoverageResult['earlyKilled'][number] | null = null
    for (const l of s.legs) {
      const g = gById.get(l.fixtureId)
      if (!g) continue
      if (g.state.kind === 'final' && !ruleWins(l.rule, g.state.h, g.state.a)) ftDead = true
      if (g.state.kind === 'live' && !stillPossible(l.rule, g.state.h, g.state.a)) liveDead ??= { key: s.key, game: g.game, pick: l.name, score: `${g.state.h}-${g.state.a}` }
    }
    if (!ftDead) aliveAtFullTime++
    if (!ftDead && liveDead) earlyKilled.push(liveDead)
    return !ftDead && !liveDead
  })

  // ── tables: every game, fitted to ALL slips' picks on it (more constraints → a better fit) ──
  const picksByGame = new Map<number, { rule: LegRule; p: number }[]>()
  for (const s of slipsIn) for (const l of s.legs) { const a = picksByGame.get(l.fixtureId) ?? []; a.push({ rule: l.rule, p: l.p }); picksByGame.set(l.fixtureId, a) }
  const tables = new Map<number, Float64Array>()
  for (const g of games) tables.set(g.fixtureId, tableFromPicks(picksByGame.get(g.fixtureId) ?? []))

  // ── 2. the two passes ──
  const openNow = games.filter(g => g.state.kind !== 'final' && alive.some(s => s.legs.some(l => l.fixtureId === g.fixtureId)))
  // the NOW pass is small (few slips left) — run it longer so per-score chances are steady (~50M leg checks)
  const legsNow = Math.max(1, alive.reduce((x, s) => x + s.legs.length, 0))
  const daysNow = Math.min(200_000, Math.max(days, Math.floor(5e7 / legsNow)))
  const now = runPass(openNow, alive, tables, daysNow, opts.seed ?? 7) as PassResult & { _slipWins: Float64Array }
  const allPending = games.map(g => ({ ...g, state: { kind: 'pending' as const } }))
  const plan = runPass(allPending, slipsIn, tables, days, (opts.seed ?? 7) ^ 0x5eed) as PassResult & { _slipWins: Float64Array }

  // ── 3. slips and budget (priced off the PLAN pass: what a fresh slip is worth) ──
  const keep = plan.keep || 0.6
  const curve = plan.slipCurve
  const tail = curve.length >= 3 ? curve[Math.floor(curve.length * 2 / 3) - 1] : { n: 0, pAnyWin: 0 }
  const marginalPerSlip = plan.slips > tail.n ? Math.max(0, (plan.pAnyWin - tail.pAnyWin) / (plan.slips - tail.n)) : (plan.slips ? plan.pAnyWin / plan.slips : 0)
  const goals = [0.05, 0.1, 0.25, 0.5]
  const fromScratch = goals.map(goal => {
    const atBest = Math.ceil(goal * target / (keep * stake))         // the honest floor: zero overlap
    if (goal <= plan.pAnyWin) {
      const n = curve.find(c => c.pAnyWin >= goal)?.n ?? plan.slips
      return { goal, slips: n, budget: n * stake, atBest }
    }
    const n = Math.ceil(plan.slips + (goal - plan.pAnyWin) / Math.max(marginalPerSlip, 1e-9))
    return { goal, slips: n < 1e6 ? n : null, budget: n < 1e6 ? n * stake : null, atBest }
  })
  const pNew = keep * stake / Math.max(1, target) * (plan.efficiency || 1)   // a fresh slip at the target
  const topUp = goals.map(goal => {
    if (goal <= now.pAnyWin) return { goal, moreSlips: 0, moreBudget: 0 }
    const m = Math.ceil((goal - now.pAnyWin) / (1 - now.pAnyWin) / Math.max(1e-9, pNew))
    return { goal, moreSlips: m < 1e6 ? m : null, moreBudget: m < 1e6 ? m * stake : null }
  })

  // ── how the chance moved, game by game (finished games in kickoff order) ──
  const finals = games.filter(g => g.state.kind === 'final')
  const done = new Set<number>()
  const pLeg = (l: CovLeg) => l.p
  const approxP = () => {
    let sum = 0, n = 0
    for (const s of slipsIn) {
      let dead = false, p = 1
      for (const l of s.legs) {
        if (done.has(l.fixtureId)) { const g = gById.get(l.fixtureId)!; if (g.state.kind === 'final' && !ruleWins(l.rule, g.state.h, g.state.a)) { dead = true; break } }
        else p *= pLeg(l)
      }
      if (!dead) { sum += p; n++ }
    }
    return { p: Math.min(1, sum), n }
  }
  const start = approxP()
  const timeline: CoverageResult['timeline'] = [{ game: 'before kickoff', kickoff: '', score: null, cut: 0, aliveAfter: start.n, pAfter: start.p }]
  for (const g of finals) {
    const before = timeline[timeline.length - 1].aliveAfter
    done.add(g.fixtureId)
    const r = approxP()
    if (!slipsIn.some(s => s.legs.some(l => l.fixtureId === g.fixtureId))) continue
    timeline.push({ game: g.game, kickoff: g.kickoff, score: g.state.kind === 'final' ? `${g.state.h}-${g.state.a}` : null, cut: before - r.n, aliveAfter: r.n, pAfter: r.p })
  }

  const strip = (p: PassResult & { _slipWins?: Float64Array }): PassResult => { const { _slipWins, ...rest } = p; void _slipWins; return rest }
  return {
    days, slips: slipsIn.length, aliveNow: alive.length, aliveAtFullTime, earlyKilled,
    now: strip(now), plan: strip(plan),
    budget: { stake, target, keep, marginalPerSlip, fromScratch, topUp },
    aliveSlips: alive.map((s, i) => ({ key: s.key, slipId: s.slipId, session: s.session, pWin: now._slipWins[i] / daysNow, payout: s.payout, needs: s.legs.filter(l => gById.get(l.fixtureId)?.state.kind !== 'final').length }))
      .sort((x, y) => y.pWin - x.pWin),
    timeline,
  }
}
