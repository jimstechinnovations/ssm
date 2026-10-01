// lib/pedlas/decision-bot.ts
// The Decision Bot (algorithm_v1.md §4). Builds K = budget ÷ stake slips ONE AFTER ANOTHER. Each slip
// walks the games in the fixed order (kickoff → shortest name → A→Z) choosing one selection per game,
// and stops the moment its payout (bonus included) lands in the target band [T, T·(1+band)]. Every
// choice is logged with its reason. Same seed ⇒ same slips and same log (predictable); the picks
// themselves are random within the rules (unpredictable).
//
// Rules (configurable, default 'greedy'):
//   random   — seeded uniform pick at each game
//   weighted — seeded pick weighted by the selection's probability
//   flip     — slip 1 random; later slips prefer the FLIP of the previous slip's pick at each game
//   greedy   — per slip, build several candidates and keep the one that adds the most to P(≥1 win):
//              its own win chance minus what it shares with earlier slips (exact, from the tables)
//
// Honest by construction: probabilities come from a scoreline table CALIBRATED to the book's prices,
// games are independent (exactly how the book prices an accumulator), so every slip's keep < 1 and the
// reported P(≥1 win) respects the ceiling Σ keep·stake/payout (algorithm_v1 §1). Pure: no I/O.

import { ruleWins, orderGames, type Selection, type SelectionGame } from './selections'
import { calibrateTable, probOf, scorelineSampler, type ScorelineTable } from './scoreline-table'
import { boostFor, type BoostFn } from './boost'

export type BotRule = 'greedy' | 'weighted' | 'random' | 'flip'

export interface BotConfig {
  stake: number
  target: number
  budget: number
  band?: number              // payout band width above target (0.01 = 1%)
  rule?: BotRule
  allowSubMinLegs?: boolean  // allow legs under minLegOdds (they don't count toward the bonus)
  minLegOdds?: number        // bonus qualifying odds (SportyBet MBB: 1.20)
  seed?: number
  maxLegs?: number
  maxPayout?: number
  boost?: BoostFn            // fallback bonus table by qualifying-leg count
  /** Exact bonus per ₦1 staked for a set of legs (SportyBet's live plan). Overrides `boost`. */
  bonusFn?: (sels: Selection[]) => number
  candidates?: number        // greedy: candidates built per slip
  /** Wall-clock budget in ms (default 90_000). Node is single-threaded, so an API route calling this
   *  SYNCHRONOUSLY blocks every other request on the server until it returns — proven live 2026-10-01:
   *  skip mode on a fresh (uncached) live pool ran long enough to freeze the whole app for 10+ minutes.
   *  Past the budget the build stops with whatever slips it has (never hangs) and a note says so. */
  deadlineMs?: number
  /** Let a slip SKIP games while walking them in order (default false = every slip uses games 1..k).
   *  With a leg cap (maxLegs), skipping lets each slip reach the target on fewer, higher-odds legs taken
   *  from anywhere in the day — less compounded margin, so a higher keep and a higher P(≥1 win) — and a
   *  game one slip skips is covered by others. Overlap maths aligns legs BY GAME, so it stays exact. */
  skip?: boolean
  evalDays?: number          // simulated outcomes used to measure P(≥1 win)
}

/** Per-game history the bot cites (and gates on). */
export interface GameHistory {
  hasForm: boolean                           // both teams have ≥3 recent games (the gate)
  formNote?: string                          // e.g. "form 1.8 vs 0.9 goals/game"
  h2h: { h: number; a: number }[]            // past meetings as home-team goals / away-team goals
}

export interface BotGame extends SelectionGame { history?: GameHistory }

export interface BotLeg {
  game: number               // index in the ordered game list
  fixtureId: number
  selection: Selection
  p: number                  // calibrated probability
  why: string
}

export interface BotSlip {
  slipId: number
  legs: BotLeg[]
  combinedOdds: number
  bonusApplies: boolean
  bonus: number              // bonus as a fraction of the raw win (stake × odds)
  payout: number
  pWin: number               // Π p (games independent — the book's own pricing)
  keep: number               // pWin × payout / stake  (< 1)
  why: string
}

export interface BotResult {
  games: BotGame[]           // the ordered games (only those the slips could use)
  slips: BotSlip[]
  pAnyWin: number
  keepRate: number
  expectedNet: number
  ceiling: number            // Σ pWin — the book-consistent upper bound for P(≥1 win)
  config: Required<Omit<BotConfig, 'boost' | 'bonusFn'>>
  notes: string[]
  calibrationMaxError: number
}

// ── deterministic RNG ──
function mulberry32(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-US')

export function runDecisionBot(inputGames: BotGame[], cfg: BotConfig): BotResult {
  const config = {
    stake: cfg.stake, target: cfg.target, budget: cfg.budget,
    band: cfg.band ?? 0.01, rule: cfg.rule ?? 'greedy', allowSubMinLegs: cfg.allowSubMinLegs ?? true,
    minLegOdds: cfg.minLegOdds ?? 1.20, seed: cfg.seed ?? 1, maxLegs: cfg.maxLegs ?? 40,
    maxPayout: cfg.maxPayout ?? Infinity, candidates: cfg.candidates ?? 24, skip: cfg.skip ?? false,
    deadlineMs: cfg.deadlineMs ?? 90_000,
    evalDays: cfg.evalDays ?? 20000,
  }
  const boost = cfg.boost ?? boostFor
  const K = Math.max(1, Math.floor(config.budget / config.stake))
  const T = config.target, Tmax = T * (1 + config.band)
  const notes: string[] = []

  // ── order + calibrate ──
  // Without skipping, a slip walks the games in order, so it can never use more than the first maxLegs
  // games — only those are calibrated and simulated. With skipping, every game in the window is usable.
  const games = orderGames(inputGames).filter(g => g.selections.length >= 2).slice(0, config.skip ? 80 : config.maxLegs)
  const tDiag0 = Date.now()
  const tables: ScorelineTable[] = games.map(g => calibrateTable(g.selections))
  if (process.env.BOT_DIAG) console.log(`[decision-bot] calibrateTable x${games.length}: ${((Date.now() - tDiag0) / 1000).toFixed(1)}s`)
  const calibrationMaxError = tables.reduce((m, t) => Math.max(m, t.maxError), 0)
  const opts = games.map((g, gi) => g.selections
    .filter(s => config.allowSubMinLegs || s.odds >= config.minLegOdds)
    .map(s => ({ s, p: probOf(tables[gi], s) })))
  const h2hWins = (gi: number, s: Selection) => {
    const h = games[gi].history?.h2h ?? []
    return h.length ? `${h.filter(m => ruleWins(s.rule, m.h, m.a)).length}/${h.length} past meetings` : 'no past meetings'
  }

  // Payout of a (partial) slip EXACTLY as the book computes it. With cfg.bonusFn (SportyBet's live plan)
  // the bonus comes from the site's own formula; otherwise a leg-count table on the qualifying legs.
  // Either way legs under the qualifying odds simply don't count toward the bonus (they don't cancel it).
  const payoutOf = (sels: Selection[]) => {
    const odds = sels.reduce((x, s) => x * s.odds, 1)
    let bonusPerStake: number
    if (cfg.bonusFn) bonusPerStake = cfg.bonusFn(sels)
    else {
      const q = sels.filter(s => s.odds >= config.minLegOdds)
      bonusPerStake = q.reduce((x, s) => x * s.odds, 1) * boost(q.length)
    }
    const pay = Math.min(config.stake * (odds + bonusPerStake), config.maxPayout)
    return { pay, odds, bonus: odds > 0 ? bonusPerStake / odds : 0, qualifying: sels.filter(s => s.odds >= config.minLegOdds).length }
  }

  // Reachability bound for pruning (skip mode): the best payout ANY k more legs could add is the product of
  // the k biggest per-game max odds left on the board, times a generous bonus allowance. A branch that can't
  // reach T even then is cut immediately — without it, skip mode explored dead branches across every game.
  const MAX_BONUS = 1.6
  const suffixTopOdds = games.map((_, gi) => opts.slice(gi).map(o => o.reduce((m, x) => Math.max(m, x.s.odds), 1)).sort((a, b) => b - a))
  const canReach = (gi: number, curOdds: number, legsLeft: number) => {
    if (gi >= games.length || legsLeft <= 0) return false
    let best = curOdds
    const top = suffixTopOdds[gi]
    for (let i = 0; i < legsLeft && i < top.length; i++) best *= top[i]
    return config.stake * best * MAX_BONUS >= T
  }

  // ── build ONE slip: walk games in order, choose by `order(gi)`, close inside the band ──
  type Choice = { gi: number; s: Selection; p: number; why: string }
  function buildSlip(order: (gi: number, legs: Choice[]) => { s: Selection; p: number; why: string }[], r?: () => number): { legs: Choice[]; backtracks: number } | null {
    const legs: Choice[] = []
    let nodes = 0, backtracks = 0
    const dfs = (gi: number): boolean => {
      if (gi >= games.length || legs.length >= config.maxLegs || ++nodes > 4000) return false
      if (config.skip && !canReach(gi, legs.reduce((x, l) => x * l.s.odds, 1), config.maxLegs - legs.length)) return false
      // SKIP (opt-in): leave this game to other slips. Skipped first with probability 1 − legsLeft/gamesLeft,
      // so a slip spreads its legs across the whole day instead of piling onto the first games; if picking
      // here fails later, the search still falls back to skipping it (and vice versa).
      const skipFirst = config.skip && r ? r() < Math.max(0, Math.min(0.9, 1 - (config.maxLegs - legs.length) / Math.max(1, games.length - gi))) : false
      if (skipFirst && dfs(gi + 1)) return true
      const ranked = order(gi, legs)
      const sels = legs.map(l => l.s)
      // 1) closing: any option that lands the payout inside the band ends the slip here
      for (const o of ranked) {
        const { pay } = payoutOf([...sels, o.s])
        if (pay >= T && pay <= Tmax) { legs.push({ gi, ...o, why: `${o.why}; closes the slip — payout ${naira(pay)} lands in ${naira(T)}–${naira(Tmax)}` }); return true }
      }
      // 2) otherwise continue with options that stay below the target (in rule order)
      let tried = 0
      for (const o of ranked) {
        const { pay } = payoutOf([...sels, o.s])
        if (pay >= T) continue
        if (tried++ > 0) backtracks++
        legs.push({ gi, ...o })
        if (dfs(gi + 1)) return true
        legs.pop()
        if (tried >= 3) break          // bounded backtracking per level keeps the search fast
      }
      if (config.skip && !skipFirst) return dfs(gi + 1)
      return false
    }
    return dfs(0) ? { legs, backtracks } : null
  }

  const finalize = (b: { legs: Choice[]; backtracks: number }, slipId: number, why: string): BotSlip => {
    const { pay, odds, bonus, qualifying } = payoutOf(b.legs.map(l => l.s))
    const pWin = b.legs.reduce((x, l) => x * l.p, 1)
    const nonQualifying = b.legs.length - qualifying
    return {
      slipId, combinedOdds: odds, bonusApplies: bonus > 0, bonus, payout: Math.round(pay * 100) / 100, pWin, keep: pWin * pay / config.stake,
      legs: b.legs.map(l => ({ game: l.gi, fixtureId: games[l.gi].fixtureId, selection: l.s, p: l.p, why: `${l.why} · history: ${h2hWins(l.gi, l.s)}` })),
      why: why + (b.backtracks ? ` · backtracked ${b.backtracks}×` : '') + ` · bonus ${(100 * bonus).toFixed(1)}% on ${qualifying} qualifying leg${qualifying === 1 ? '' : 's'}` + (nonQualifying ? ` (${nonQualifying} under ${config.minLegOdds} don't count)` : ''),
    }
  }
  const keyOf = (legs: { gi: number; s: Selection }[]) => legs.map(l => `${l.gi}:${l.s.key}`).join('|')

  // orderings
  const shuffled = (gi: number, rng: () => number, label: string) => {
    const a = opts[gi].map(o => ({ ...o, u: rng() })).sort((x, y) => x.u - y.u)
    return a.map(o => ({ s: o.s, p: o.p, why: `${label} pick (u=${o.u.toFixed(3)}) of ${a.length}: ${o.s.name} @${o.s.odds}` }))
  }
  const weighted = (gi: number, rng: () => number) => {
    // Efraimidis–Spirakis: key = u^(1/w) — sampling without replacement ∝ p
    const a = opts[gi].map(o => ({ ...o, k: Math.pow(rng(), 1 / Math.max(1e-6, o.p)) })).sort((x, y) => y.k - x.k)
    return a.map(o => ({ s: o.s, p: o.p, why: `weighted pick (P=${(100 * o.p).toFixed(1)}%): ${o.s.name} @${o.s.odds}` }))
  }

  // ── simulated outcomes, used only to MEASURE P(≥1 win) at the end ──
  const samplers = tables.map(scorelineSampler)
  const simulate = (days: number, seed: number) => {
    const rng = mulberry32(seed)
    const out = games.map(() => ({ h: new Uint8Array(days), a: new Uint8Array(days) }))
    for (let d = 0; d < days; d++) for (let gi = 0; gi < games.length; gi++) { const [h, a] = samplers[gi](rng()); out[gi].h[d] = h; out[gi].a[d] = a }
    return out
  }

  // ── exact overlap maths for greedy ──
  // A slip wins with p = Π p(leg). Two slips share the games they both bet (without skipping: their first
  // min(L₁, L₂) games); P(both win) = Π_shared P(both picks win on that game) × Π_rest p(leg).
  // The joint per game comes straight from the calibrated scoreline table (cells both rules accept).
  // Greedy's gain for a candidate = p − Σ_j P(candidate ∧ slip j) (inclusion–exclusion to 2nd order —
  // exact enough when every p is tiny). Exact maths, so no simulation noise decides between candidates.
  const NCELL = tables[0]?.p.length ?? 0
  const maskCache = new Map<string, Uint8Array>()
  const maskOf = (gi: number, s: Selection) => {
    const k = `${gi}:${s.key}`; let m = maskCache.get(k)
    if (!m) { const n = Math.round(Math.sqrt(NCELL)); m = Uint8Array.from({ length: NCELL }, (_, i) => ruleWins(s.rule, Math.floor(i / n), i % n) ? 1 : 0); maskCache.set(k, m) }
    return m
  }
  const jointCache = new Map<string, number>()
  const joint = (gi: number, a: Selection, b: Selection) => {
    if (a.key === b.key) return probOfKey(gi, a)
    const k = a.key < b.key ? `${gi}:${a.key}&${b.key}` : `${gi}:${b.key}&${a.key}`
    let v = jointCache.get(k)
    if (v == null) { const ma = maskOf(gi, a), mb = maskOf(gi, b), p = tables[gi].p; v = 0; for (let i = 0; i < NCELL; i++) if (ma[i] && mb[i]) v += p[i]; jointCache.set(k, v) }
    return v
  }
  const pCache = new Map<string, number>()
  function probOfKey(gi: number, s: Selection) { const k = `${gi}:${s.key}`; let v = pCache.get(k); if (v == null) { v = probOf(tables[gi], s); pCache.set(k, v) } return v }
  // Legs are aligned BY GAME (not by position), so slips that skip different games are still exact:
  // a game both slips bet → the joint from the table; a game only one bets → that leg's own p.
  const pBoth = (a: { gi: number; s: Selection }[], b: { gi: number; s: Selection }[]) => {
    let x = 1
    const bm = new Map(b.map(l => [l.gi, l.s]))
    for (const la of a) {
      const sb = bm.get(la.gi)
      if (sb) { x *= joint(la.gi, la.s, sb); if (x === 0) return 0; bm.delete(la.gi) }
      else x *= probOfKey(la.gi, la.s)
    }
    for (const [gi, s] of bm) x *= probOfKey(gi, s)
    return x
  }

  // Fingerprint separator ordering: the earlier slips this partial candidate still OVERLAPS are those
  // whose pick shares ≥1 scoreline with ours on every game so far. At game gi, a pick that shares NO
  // scoreline with such a slip's pick separates the two for good (they can never both win). Options are
  // drawn by probability (survival) boosted by how many open overlaps they close.
  function separator(gi: number, legs: Choice[], family: Map<number, Selection>[], r: () => number) {
    const open = family.filter(f => legs.every(l => { const fs = f.get(l.gi); return !fs || joint(l.gi, l.s, fs) > 0 }))
    return opts[gi]
      .map(o => { const cuts = open.reduce((n, f) => { const fs = f.get(gi); return n + (fs && joint(gi, o.s, fs) === 0 ? 1 : 0) }, 0); return { ...o, cuts, key: Math.pow(r(), 1 / Math.max(1e-6, o.p * (1 + cuts) ** 2)) } })
      .sort((x, y) => y.key - x.key)
      .map(o => ({ s: o.s, p: o.p, why: o.cuts
        ? `fingerprint separator: ${o.s.name} @${o.s.odds} (P=${(100 * o.p).toFixed(1)}%) shares no scoreline with ${o.cuts} earlier slip${o.cuts === 1 ? '' : 's'} still overlapping here`
        : `weighted pick (P=${(100 * o.p).toFixed(1)}%): ${o.s.name} @${o.s.odds}` }))
  }

  // ── build the family, slip by slip ──
  const rng = mulberry32(config.seed)
  const slips: BotSlip[] = []
  const seen = new Set<string>()
  let failures = 0
  const t0 = Date.now()
  let timedOut = false
  for (let k = 0; k < K && failures < 40; k++) {
    if (Date.now() - t0 > config.deadlineMs) { timedOut = true; break }
    let chosen: BotSlip | null = null
    if (config.rule === 'greedy') {
      type Cand = { b: { legs: Choice[]; backtracks: number }; gain: number; own: number; overlap: number; overlapping: number }
      let best: Cand | null = null, bestDisjoint: Cand | null = null
      let built = 0
      // Overlap is measured against every earlier slip, or a fixed sample of 300 for very large families
      // (scaled back up) so a 1,000-slip session stays fast. Deterministic: the sample follows the seed.
      const all = slips.map(s => s.legs.map(l => ({ gi: l.game, s: l.selection })))
      const family = all.length <= 300 ? all : Array.from({ length: 300 }, (_, i) => all[Math.floor((i + 0.5) * all.length / 300)])
      const scale = all.length / Math.max(1, family.length)
      const familyMaps = family.map(f => new Map(f.map(l => [l.gi, l.s])))
      for (let c = 0; c < config.candidates * 3 && built < config.candidates; c++) {
        if ((c & 15) === 0 && Date.now() - t0 > config.deadlineMs) { timedOut = true; break }   // checked every 16 candidates (Date.now() itself isn't free at this volume)
        // Three candidate generators give greedy a diverse pool: uniform (ignores likelihood), weighted by
        // P (high survival, but drifts to low odds ⇒ more legs), and a FINGERPRINT SEPARATOR that, at each
        // game, prefers the pick that shares no scoreline with the earlier slips this candidate still
        // overlaps — so it becomes disjoint from them — weighted by P to keep survival high.
        const gen = c % 3
        const b = gen === 0 ? buildSlip(gi => shuffled(gi, rng, 'random'), rng)
          : gen === 1 ? buildSlip(gi => weighted(gi, rng), rng)
            : buildSlip((gi, legs) => separator(gi, legs, familyMaps, rng), rng)
        if (!b) continue
        const key = keyOf(b.legs); if (seen.has(key)) continue
        built++
        const own = b.legs.reduce((x, l) => x * l.p, 1)
        let overlap = 0, overlapping = 0
        for (const f of family) { const o = pBoth(b.legs, f); if (o > 0) { overlap += o; overlapping++ } }
        overlap *= scale; overlapping = Math.round(overlapping * scale)
        const cand: Cand = { b, gain: own - overlap, own, overlap, overlapping }
        if (!best || cand.gain > best.gain) best = cand
        if (overlapping === 0 && (!bestDisjoint || cand.own > bestDisjoint.own)) bestDisjoint = cand
      }
      // Prefer a fingerprint-DISJOINT candidate (adds its whole win chance, shares nothing) unless an
      // overlapping one still adds strictly more after its overlap is removed.
      const pick = bestDisjoint && (!best || bestDisjoint.gain >= best.gain) ? bestDisjoint : best
      if (pick) chosen = finalize(pick.b, k + 1, pick.overlapping === 0
        ? `greedy: best of ${built} candidates — fingerprint-disjoint from all ${slips.length} earlier slips (no scoreline combination wins two slips), adds its full ${(100 * pick.own).toFixed(4)}% to P(≥1 win)`
        : `greedy: best of ${built} candidates — adds ${(100 * pick.gain).toFixed(4)}% to P(≥1 win) (wins ${(100 * pick.own).toFixed(4)}% alone, ${(100 * pick.overlap).toFixed(4)}% shared with ${pick.overlapping} earlier slip${pick.overlapping === 1 ? '' : 's'})`)
    } else {
      for (let attempt = 0; attempt < 30 && !chosen; attempt++) {
        let b: { legs: Choice[]; backtracks: number } | null = null
        if (config.rule === 'random') b = buildSlip(gi => shuffled(gi, rng, 'random'), rng)
        else if (config.rule === 'weighted') b = buildSlip(gi => weighted(gi, rng), rng)
        else {
          // flip: slip 1 random; afterwards prefer the flip of the previous slip's pick at this game
          const prev = slips[slips.length - 1]
          b = buildSlip(gi => {
            const rest = shuffled(gi, rng, 'random')
            const prevLeg = prev?.legs.find(l => l.game === gi)
            if (!prevLeg || attempt > 0 && rng() < attempt / 30) return rest
            const flip = rest.find(o => o.s.key === prevLeg.selection.flipKey)
            if (!flip) return rest
            return [{ ...flip, why: `flip of slip ${prev!.slipId}'s "${prevLeg.selection.name}" → ${flip.s.name} @${flip.s.odds}` }, ...rest.filter(o => o !== flip)]
          }, rng)
        }
        if (b && !seen.has(keyOf(b.legs))) chosen = finalize(b, k + 1, `${config.rule}${attempt ? ` (attempt ${attempt + 1} — earlier attempts duplicated a slip or missed the band)` : ''}`)
      }
    }
    if (!chosen) { failures++; k--; if (failures >= 40) notes.push(`stopped at ${slips.length} slips: no further distinct slip lands in the band`); continue }
    seen.add(keyOf(chosen.legs.map(l => ({ gi: l.game, s: l.selection }))))
    slips.push(chosen)
  }
  if (slips.length === 0) notes.push(`no slip can reach ${naira(T)}–${naira(Tmax)} with these ${games.length} games`)
  if (timedOut) notes.push(`stopped at ${slips.length}/${K} slips: hit the ${(config.deadlineMs / 1000).toFixed(0)}s build budget (deadlineMs) — raise it or loosen maxLegs/skip to fit more slips in budget`)
  if (process.env.BOT_DIAG) console.log(`[decision-bot] slip loop (${slips.length} slips): ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ── measure: P(≥1 win) on FRESH simulated outcomes (games independent, calibrated to the book) ──
  const ED = config.evalDays
  const ev = simulate(ED, config.seed ^ 0xE7A1)
  let hits = 0
  for (let d = 0; d < ED; d++) {
    for (const s of slips) { if (s.legs.every(l => ruleWins(l.selection.rule, ev[l.game].h[d], ev[l.game].a[d]))) { hits++; break } }
  }
  const pSim = hits / ED
  // EXACT family survival (games independent): Σp − Σ_{i<j} P(i ∧ j). Higher-order terms are negligible at
  // these probabilities; fingerprint-disjoint pairs contribute exactly 0. The simulation is a cross-check.
  let pairOverlap = 0, overlappingPairs = 0
  const fam = slips.map(s => s.legs.map(l => ({ gi: l.game, s: l.selection })))
  for (let i = 0; i < fam.length; i++) for (let j = i + 1; j < fam.length; j++) { const o = pBoth(fam[i], fam[j]); if (o > 0) { pairOverlap += o; overlappingPairs++ } }
  const sumP = slips.reduce((x, s) => x + s.pWin, 0)
  const pAnyWin = Math.max(slips.reduce((m, s) => Math.max(m, s.pWin), 0), sumP - pairOverlap)
  const totalPairs = fam.length * (fam.length - 1) / 2
  notes.push(`fingerprint: ${totalPairs - overlappingPairs}/${totalPairs} slip pairs are disjoint (can never both win); overlap removed ${(100 * pairOverlap).toFixed(4)}pt · simulation cross-check ${(100 * pSim).toFixed(3)}%`)
  const staked = slips.length * config.stake
  const expectedReturn = slips.reduce((x, s) => x + s.pWin * s.payout, 0)
  const keepRate = staked ? expectedReturn / staked : 0
  if (calibrationMaxError > 0.01) notes.push(`calibration: worst market fit off by ${(100 * calibrationMaxError).toFixed(1)}pt (books' markets not fully consistent)`)
  return {
    games, slips, pAnyWin, keepRate, expectedNet: Math.round(expectedReturn - staked),
    ceiling: slips.reduce((x, s) => x + s.pWin, 0), config, notes, calibrationMaxError,
  }
}
