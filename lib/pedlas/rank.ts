// lib/pedlas/rank.ts
// Ranking layer. Per your decision, NVIDIA NIM is the CENTRAL reasoning engine: it
// scores the high-payout candidate slips on risk/plausibility, fed ONLY by
// PEDLAS-computed features (it never predicts football, invents stats, or does
// arithmetic — odds/probs/EV are computed deterministically elsewhere).
//
// A deterministic, payout-forward fallback (rank by combined odds = the "hit big"
// objective) is always available, so the builder works with no API key and is the
// fail-safe if a NIM call errors.

import type { PedlasVector, RankedVector } from './types'
import { nimChat, nimConfigured, parseJsonLoose } from '../llm/nim'

export type RankMode = 'nim' | 'deterministic' | 'auto'

export interface RankOptions {
  mode?: RankMode
  maxForLlm?: number     // candidates sent to NIM (default 60)
  poolCap?: number       // max ranked candidates returned (default 2000)
  advisoryNote?: string  // per-fixture history-model leans (advisory) added to the NIM prompt
}

export interface RankResult {
  ranked: RankedVector[]
  source: 'nim' | 'deterministic'
}

/** Map values to 0–100 by min–max; flat input → all 100. */
function normalize(values: number[]): number[] {
  let lo = Infinity, hi = -Infinity
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
  const span = hi - lo
  return values.map(v => (span <= 0 ? 100 : Math.round(((v - lo) / span) * 100)))
}

/** Deterministic, payout-forward ranking: highest combined odds first (the "hit big" goal). */
export function deterministicRank(vectors: PedlasVector[], poolCap = 2000): RankedVector[] {
  const sorted = [...vectors].sort((a, b) => b.combinedOdds - a.combinedOdds).slice(0, poolCap)
  const scores = normalize(sorted.map(v => Math.log(v.combinedOdds)))
  return sorted.map((v, i) => ({ ...v, rankScore: scores[i] }))
}

/**
 * Coverage ranking: most-PROBABLE vectors first (the "frequent small win" floor). This is the
 * deterministic order the coverage objective places — it catches near-misses by covering the
 * anchor's neighbourhood, not by spreading slips out. Pure probability math (no NIM).
 */
export function coverageRank(vectors: PedlasVector[], poolCap = 2000): RankedVector[] {
  const sorted = [...vectors].sort((a, b) => b.trueProb - a.trueProb).slice(0, poolCap)
  const scores = normalize(sorted.map(v => Math.log(v.trueProb)))
  return sorted.map((v, i) => ({ ...v, rankScore: scores[i] }))
}

const SYSTEM_PROMPT = [
  'You are PEDLAS\'s slip-ranking analyst for a total-goals Under/Over coverage builder.',
  'You are NOT a football predictor. Do NOT predict match results. Do NOT invent statistics.',
  'Use ONLY the numeric features supplied. Do not perform arithmetic on odds or payouts.',
  'Each candidate is a full multi-leg slip; "overFlips" is how many games are bet Over (the',
  'high-odds, low-probability side). Higher overFlips = bigger payout but lower chance.',
  'Rank candidates by how attractive they are as a DIVERSIFIED big-payout shot, penalising',
  'hidden structural risk (e.g. many flips concentrated in one league, or flips on coin-flip',
  'games). Return STRICT JSON: {"scores":[{"id":<int>,"score":<0-100>,',
  '"hiddenRisk":"<short>","reasoning":"<short>"}]} with one entry per candidate id.',
].join(' ')

function buildUserPrompt(cands: PedlasVector[], advisoryNote = ''): string {
  const f0 = cands[0]?.features
  const ctx = f0
    ? `Pool context: legCount=${f0.legCount}, avgMargin=${(f0.avgMargin * 100).toFixed(1)}%, ` +
      `avgVolatility=${f0.avgVolatility.toFixed(2)}, avgLine=${f0.avgLineHeight.toFixed(1)}, ` +
      `distinctLeagues=${f0.distinctLeagues}, kickoffSpreadHours=${f0.kickoffSpreadHours.toFixed(1)}.`
    : ''
  const adv = advisoryNote ? `\n${advisoryNote}` : ''
  const rows = cands.map((v, id) => {
    const f = v.features
    return {
      id,
      overFlips: f.overFlips,
      combinedOdds: Math.round(v.combinedOdds),
      hitProbPct: +(v.trueProb * 100).toFixed(3),
      evMultiple: +v.evMultiple.toFixed(3),
      flippedAvgVolatility: +f.flippedAvgVolatility.toFixed(2),
      flippedAvgOverOdds: +f.flippedAvgOverOdds.toFixed(2),
      flippedLeagues: f.flippedLeagues,
    }
  })
  return `${ctx}${adv}\nScore every candidate (rank big diversified payout vs hidden risk).\n` +
    `Candidates JSON:\n${JSON.stringify(rows)}`
}

interface NimScore { id: number; score: number; hiddenRisk?: string; reasoning?: string }

/** NIM-central ranking over the top-`maxForLlm` payout candidates. Falls back on any error. */
export async function nimRank(vectors: PedlasVector[], maxForLlm = 60, poolCap = 2000, advisoryNote = ''): Promise<RankResult> {
  const base = deterministicRank(vectors, poolCap)          // payout-forward shortlist
  const shortlist = base.slice(0, Math.min(maxForLlm, base.length))
  try {
    const content = await nimChat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(shortlist, advisoryNote) },
      ],
      { temperature: 0, json: true, maxTokens: 4096 },
    )
    const parsed = parseJsonLoose<{ scores?: NimScore[] }>(content)
    const scores = parsed?.scores
    if (!Array.isArray(scores) || scores.length === 0) throw new Error('nimRank: no scores parsed')

    const byId = new Map<number, NimScore>()
    for (const s of scores) if (typeof s.id === 'number') byId.set(s.id, s)

    const ranked: RankedVector[] = shortlist.map((v, id) => {
      const s = byId.get(id)
      return {
        ...v,
        rankScore: s ? Math.max(0, Math.min(100, s.score)) : v.rankScore,
        reasoning: s?.reasoning,
        hiddenRisk: s?.hiddenRisk,
      }
    })
    ranked.sort((a, b) => b.rankScore - a.rankScore)
    return { ranked, source: 'nim' }
  } catch {
    return { ranked: base, source: 'deterministic' }
  }
}

/** Entry point: resolves 'auto' to NIM when configured, else deterministic. */
export async function rankVectors(vectors: PedlasVector[], opts: RankOptions = {}): Promise<RankResult> {
  const poolCap = opts.poolCap ?? 2000
  const mode = opts.mode ?? 'auto'
  const useNim = mode === 'nim' || (mode === 'auto' && nimConfigured())
  if (useNim) return nimRank(vectors, opts.maxForLlm ?? 60, poolCap, opts.advisoryNote ?? '')
  return { ranked: deterministicRank(vectors, poolCap), source: 'deterministic' }
}
