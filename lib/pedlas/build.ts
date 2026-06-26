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
import type { PedlasBook, PedlasConfig, PedlasParams } from './types'
import { capPoolByLeague, applyAnchorDistance, applyElimination } from './constraints'
import { enumerateVectors, MAX_ENUMERATE_LEGS } from './vectors'
import { rankVectors } from './rank'
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

  // D — diversity: cap the pool per competition, then order by kickoff (for E + features).
  const prelimParams = { ...DEFAULT_PARAMS, ...cfg.params }
  const pool = capPoolByLeague(cfg.axes, prelimParams.maxPerLeague)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff))

  const L = pool.length
  if (L > MAX_ENUMERATE_LEGS) {
    throw new Error(
      `buildPedlasBook: ${L} legs exceeds the enumeration cap (${MAX_ENUMERATE_LEGS}). ` +
      `Reduce the pool (tighten maxPerLeague or the market filter) — vector sampling is future work.`,
    )
  }

  const params = resolveParams(L, cfg.params)

  // Enumerate the binary outcome space and apply A then E.
  const all = enumerateVectors(pool)
  const afterA = applyAnchorDistance(all, params.minAnchorDistance)
  const candidates = applyElimination(afterA, params.maxIdenticalRun, L)
  const candidateCount = candidates.length

  // Rank (NIM central per config), then enforce slip separation (S) to form the PEDLAS
  // candidate slip set. Budget (external) then places the top K = floor(budget/stake).
  const K = budgetSlots(cfg.budget, stake)
  const { ranked, source } = await rankVectors(candidates, {
    mode: cfg.rank ?? 'auto',
  })
  const separated = applySeparation(ranked, params.minSlipSeparation) // N = PEDLAS candidate slips
  const kept = separated.slice(0, K)

  const maxPayout = cfg.maxPayout ?? DEFAULT_MAX_PAYOUT
  const slips = kept.map((rv, i) => assembleSlip(rv, pool, i + 1, stake, maxPayout))
  const verdict = buildVerdict(pool, slips)

  return {
    mode: 'pedlas',
    params,
    legCount: L,
    budget: cfg.budget,
    stakePerSlip: stake,
    K,
    // CR = 2^L / N, N = candidate slips after PEDLAS filtering (E/D/A/S), before budget.
    compressionRatio: separated.length > 0 ? Math.pow(2, L) / separated.length : 0,
    slips,
    verdict,
    meta: {
      candidateCount,
      pAnyHit: pAnyHit(slips),
      ranked: source,
    },
  }
}
