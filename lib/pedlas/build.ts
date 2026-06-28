// lib/pedlas/build.ts
// PEDLAS v1 orchestrator. One entry point: buildPedlasBook(cfg) → PedlasBook.
//
// Pipeline (see pedlas_v1.md §3):
//   axes → D (cap pool per league) → sort by kickoff → enumerate 2^L
//        → A (min Over-flips) → E (max identical run)
//        → rank (NIM central, deterministic fallback)
//        → S (min pairwise Hamming, limited to K = floor(budget/stake))
//        → assemble slips (accurate winnings-boosted payout) → honest verdict.

import { DEFAULT_PARAMS } from './types'
import type { PedlasBook, PedlasConfig, PedlasObjective, PedlasParams, RankedVector } from './types'
import { capPoolByLeague, applyAnchorDistance, applyElimination } from './constraints'
import { enumerateVectors, MAX_ENUMERATE_LEGS } from './vectors'
import { rankVectors, coverageRank } from './rank'
import { applySeparation } from './separation'
import { assembleSlip, buildVerdict, budgetSlots, pAnyHit, DEFAULT_MIN_STAKE, DEFAULT_MAX_PAYOUT } from './budget'

function resolveParams(L: number, p?: Partial<PedlasParams>): PedlasParams {
  const merged = { ...DEFAULT_PARAMS, ...p }
  // Clamp so constraints can't make the candidate set empty by construction.
  merged.minAnchorDistance = Math.max(0, Math.min(merged.minAnchorDistance, L))
  merged.minSlipSeparation = Math.max(1, Math.min(merged.minSlipSeparation, L))
  merged.maxPerLeague = Math.max(1, merged.maxPerLeague)
  merged.maxIdenticalRun = Math.max(1, merged.maxIdenticalRun)
  return merged
}

export async function buildPedlasBook(cfg: PedlasConfig): Promise<PedlasBook> {
  if (!cfg.axes || cfg.axes.length === 0) {
    throw new Error('buildPedlasBook: no axes supplied (empty total-goals pool)')
  }

  const stake = cfg.minStake ?? DEFAULT_MIN_STAKE
  const objective: PedlasObjective = cfg.objective ?? 'moonshot'

  // Coverage targets the near-anchor neighbourhood: A=1 (exclude only the all-dominant anchor so
  // every placed slip clears the total stake), and E OFF — a reliable slip is a long run of the
  // dominant side (9 dominant + 1 breakout), which the default E=4 would wrongly prune. Moonshot
  // keeps DEFAULT_PARAMS.
  const cfgParams: Partial<PedlasParams> = { ...cfg.params }
  if (objective === 'coverage') {
    if (cfgParams.minAnchorDistance === undefined) cfgParams.minAnchorDistance = 1
    if (cfgParams.maxIdenticalRun === undefined) cfgParams.maxIdenticalRun = 99 // ≥ any L ⇒ E disabled
  }

  // D — diversity: cap the pool per competition, then order by kickoff (for E + features).
  const prelimParams = { ...DEFAULT_PARAMS, ...cfgParams }
  const pool = capPoolByLeague(cfg.axes, prelimParams.maxPerLeague)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff))

  const L = pool.length
  if (L > MAX_ENUMERATE_LEGS) {
    throw new Error(
      `buildPedlasBook: ${L} legs exceeds the enumeration cap (${MAX_ENUMERATE_LEGS}). ` +
      `Reduce the pool (tighten maxPerLeague or the market filter) — vector sampling is future work.`,
    )
  }

  const params = resolveParams(L, cfgParams)

  // Enumerate the binary outcome space and apply A then E.
  const all = enumerateVectors(pool)
  const afterA = applyAnchorDistance(all, params.minAnchorDistance)
  const candidates = applyElimination(afterA, params.maxIdenticalRun, L)
  const candidateCount = candidates.length

  const K = budgetSlots(cfg.budget, stake)

  // Two objectives over the same candidate set:
  //   moonshot — NIM-ranked by payout, then S spreads slips apart (rare big win).
  //   coverage — probability-ranked, neighbours KEPT (no S) to catch near-misses (frequent small win).
  let ranked: RankedVector[]
  let source: 'nim' | 'deterministic'
  let candidateSlipCount: number   // N for the compression ratio
  let kept: RankedVector[]

  if (objective === 'coverage') {
    ranked = coverageRank(candidates)
    source = 'deterministic'
    kept = ranked.slice(0, K)            // most-probable K, neighbours intact
    candidateSlipCount = candidates.length
  } else {
    const leans = pool.filter(a => a.advisory)
    const advisoryNote = leans.length
      ? 'History-model leans (ADVISORY ONLY — not odds, no edge): ' +
        leans.map(a => `${a.game} ${a.advisory!.lean}(edge ${a.advisory!.edge.toFixed(2)})`).join('; ')
      : ''
    const r = await rankVectors(candidates, { mode: cfg.rank ?? 'auto', advisoryNote })
    ranked = r.ranked
    source = r.source
    const separated = applySeparation(ranked, params.minSlipSeparation)
    candidateSlipCount = separated.length
    kept = separated.slice(0, K)
  }

  const maxPayout = cfg.maxPayout ?? DEFAULT_MAX_PAYOUT
  const slips = kept.map((rv, i) => assembleSlip(rv, pool, i + 1, stake, maxPayout))
  const verdict = buildVerdict(pool, slips)

  const totalStake = slips.reduce((s, sl) => s + sl.stake, 0)
  const minPayout = slips.length ? Math.min(...slips.map(s => s.payout)) : 0

  return {
    mode: 'pedlas',
    objective,
    params,
    legCount: L,
    budget: cfg.budget,
    stakePerSlip: stake,
    K,
    totalStake,
    // The floor guarantee: any single placed slip that hits returns at least the whole stake back.
    guaranteedFloor: slips.length > 0 && minPayout >= totalStake,
    minPayout,
    // CR = 2^L / N, N = candidate slips after PEDLAS filtering, before budget.
    compressionRatio: candidateSlipCount > 0 ? Math.pow(2, L) / candidateSlipCount : 0,
    pool,
    slips,
    verdict,
    meta: {
      candidateCount,
      pAnyHit: pAnyHit(slips),
      ranked: source,
    },
  }
}
