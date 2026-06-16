/**
 * app/api/generate/route.ts
 *
 * Matrix generation handler — POST /api/generate
 *
 * Supports two request shapes:
 *  - v1: { matches, config } — backward-compatible, uses manual state0/state1
 *  - v2: { groupId, fixtures, bankroll, numAccounts } — auto-detected market states
 *
 * v2 workflow:
 *  1. Validate with GenerateRequestSchema_v2
 *  2. Verify session_groups row exists and is in 'screening' status
 *  3. Detect dominant market via detectDominantMarket()
 *  4. Calculate per-tier stakes via calculateStakes()
 *  5. Build MatchSelection[] from fixture odds + detected market
 *  6. Generate 42-slip matrix
 *  7. Distribute slips to accounts
 *  8. Overwrite slip.stake / slip.potentialPayout with tier-specific amounts
 *  9. Assign session hashes
 * 10. Persist to Supabase (retry on prefix collision)
 * 11. Update session_groups status → 'generated'
 * 12. Set HTTP-only cookie and return
 *
 * Requirements: 1.1–1.12, 2.1–2.9, 4.4, 4.7, 4.8, 5.6, 7.1–7.12, 10.4, 11.1, 11.2, 12.4
 */

import { cookies } from 'next/headers'
import { GenerateRequestSchema, GenerateRequestSchema_v2 } from '@/lib/ssm/schemas'
import { generateMatrix } from '@/lib/ssm/generator'
import { distributeToAccounts } from '@/lib/ssm/distributor'
import { generateSessionPrefix, generateSlipHash } from '@/lib/ssm/session'
import { detectDominantMarket } from '@/lib/ssm/market-detector'
import { calculateStakes } from '@/lib/ssm/stake-calculator'
import { computeVolatility } from '@/lib/ssm/volatility'
import { OUTCOME_TO_LABEL } from '@/lib/ssm/types'
import { createServerClient } from '@/lib/supabase/server'
import type {
  Fixture,
  MatchSelection,
  OddsValue,
  SessionConfig,
  TierLabel,
} from '@/lib/ssm/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'ssm_session_id'
const COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/',
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
}
const PG_UNIQUE_VIOLATION = '23505'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find an OddsValue by its canonical label in a fixture's odds array */
function findOddsByOutcomeLabel(odds: OddsValue[], label: string): OddsValue | null {
  return odds.find(o => o.label === label) ?? null
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: 'Validation failed', issues: ['Request body is not valid JSON'] },
      { status: 400 },
    )
  }

  // ── Detect v2 vs v1 by presence of groupId field ─────────────────────────
  const isV2 = body !== null && typeof body === 'object' && 'groupId' in body

  if (isV2) {
    return handleV2(body)
  }
  return handleV1(body)
}

// ─── v1 handler (backward-compatible) ────────────────────────────────────────

async function handleV1(body: unknown): Promise<Response> {
  const parsed = GenerateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const { matches, config: requestConfig } = parsed.data
  const now = new Date()
  let sessionPrefix = generateSessionPrefix(now)

  const sessionConfig: SessionConfig = {
    date: requestConfig.date,
    stakePerSlip: requestConfig.stakePerSlip,
    numAccounts: requestConfig.numAccounts,
    sessionPrefix,
  }

  let slips
  try { slips = generateMatrix(matches, sessionConfig) }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Matrix generation failed' }, { status: 500 }) }

  let distribution
  try { distribution = distributeToAccounts(slips, sessionConfig) }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Distribution failed' }, { status: 500 }) }

  for (const account of distribution) {
    for (let pos = 0; pos < account.slips.length; pos++) {
      account.slips[pos].sessionHash = generateSlipHash(sessionPrefix, account.accountNumber, pos + 1)
    }
  }
  const allSlipsWithHashes = distribution.flatMap(a => a.slips)

  return persistAndReturn(allSlipsWithHashes, distribution, sessionConfig, sessionPrefix, now, null)
}

// ─── v2 handler (auto-detected market, bankroll stakes) ──────────────────────

async function handleV2(body: unknown): Promise<Response> {
  const parsed = GenerateRequestSchema_v2.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const { groupId, fixtures, bankroll, numAccounts } = parsed.data
  const supabase = createServerClient()

  // 1. Verify session group exists and is in screening status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: group, error: groupErr } = await (supabase
    .from('session_groups')
    .select('id, status')
    .eq('id', groupId)
    .maybeSingle()) as { data: { id: string; status: string } | null; error: unknown }

  if (groupErr || !group) {
    return Response.json({ error: 'Group not found' }, { status: 400 })
  }
  if (group.status === 'generated') {
    return Response.json({ error: 'Group already generated' }, { status: 400 })
  }

  // 2. Detect dominant market
  let marketResult
  try {
    marketResult = detectDominantMarket(fixtures as Fixture[])
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Market detection failed' }, { status: 422 })
  }

  // 3. Calculate per-tier stakes
  let allocation
  try {
    allocation = calculateStakes(bankroll)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Stake calculation failed. Bankroll may be too small.' }, { status: 400 })
  }

  // 4. Build MatchSelection[] from detected market
  const state0Label = OUTCOME_TO_LABEL[marketResult.dominantOutcome]
  const state1Label = OUTCOME_TO_LABEL[marketResult.breakoutOutcome]

  const selections: MatchSelection[] = (fixtures as Fixture[]).map(fixture => {
    const state0 = findOddsByOutcomeLabel(fixture.odds, state0Label)
    const state1 = findOddsByOutcomeLabel(fixture.odds, state1Label)

    // Fallback: create placeholder OddsValue if market not found on specific fixture
    const s0: OddsValue = state0 ?? { bookmaker: 'auto', market: '1X2', label: state0Label, value: 1.5 }
    const s1: OddsValue = state1 ?? { bookmaker: 'auto', market: '1X2', label: state1Label, value: 2.0 }

    return {
      fixture,
      state0: s0,
      state1: s1,
      volatility: computeVolatility(s0, s1),
    }
  })

  // 5. Build SessionConfig (stakePerSlip = core stake as placeholder; overwritten below)
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date()
  let sessionPrefix = generateSessionPrefix(now)

  const sessionConfig: SessionConfig = {
    date: today,
    stakePerSlip: allocation.coreStakePerSlip,
    numAccounts: numAccounts as 6 | 7,
    sessionPrefix,
  }

  // 6. Generate matrix
  let slips
  try { slips = generateMatrix(selections, sessionConfig) }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Matrix generation failed' }, { status: 500 }) }

  // 7. Distribute slips
  let distribution
  try { distribution = distributeToAccounts(slips, sessionConfig) }
  catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Distribution failed' }, { status: 500 }) }

  // 8. Overwrite slip.stake and slip.potentialPayout with correct per-tier amounts
  const tierStakeMap: Record<TierLabel, number> = {
    CORE:  allocation.coreStakePerSlip,
    PIVOT: allocation.pivotStakePerSlip,
    CHAOS: allocation.chaosStakePerSlip,
  }
  for (const account of distribution) {
    for (let pos = 0; pos < account.slips.length; pos++) {
      const slip = account.slips[pos]
      const stake = tierStakeMap[slip.tier]
      slip.stake = stake
      slip.potentialPayout = +(slip.combinedOdds * stake).toFixed(2)
    }
    account.totalStake = account.slips.reduce((sum, s) => sum + s.stake, 0)
  }

  // 9. Assign session hashes
  for (const account of distribution) {
    for (let pos = 0; pos < account.slips.length; pos++) {
      account.slips[pos].sessionHash = generateSlipHash(sessionPrefix, account.accountNumber, pos + 1)
    }
  }
  const allSlipsWithHashes = distribution.flatMap(a => a.slips)

  // 10–12. Persist, update group, set cookie, return
  return persistAndReturn(
    allSlipsWithHashes,
    distribution,
    sessionConfig,
    sessionPrefix,
    now,
    groupId,
    marketResult,
    allocation,
  )
}

// ─── Shared persist + respond ─────────────────────────────────────────────────

async function persistAndReturn(
  allSlipsWithHashes: ReturnType<typeof distributeToAccounts>[0]['slips'],
  distribution: ReturnType<typeof distributeToAccounts>,
  sessionConfig: SessionConfig,
  sessionPrefixIn: string,
  now: Date,
  groupId: string | null,
  marketResult?: ReturnType<typeof detectDominantMarket>,
  allocation?: ReturnType<typeof calculateStakes>,
): Promise<Response> {
  const supabase = createServerClient()
  let sessionPrefix = sessionPrefixIn
  let newSessionId: string | null = null

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      sessionPrefix = generateSessionPrefix(now)
      sessionConfig.sessionPrefix = sessionPrefix
      for (const account of distribution) {
        for (let pos = 0; pos < account.slips.length; pos++) {
          account.slips[pos].sessionHash = generateSlipHash(sessionPrefix, account.accountNumber, pos + 1)
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await supabase
      .from('sessions')
      .insert({
        session_prefix:  sessionPrefix,
        date:            sessionConfig.date,
        config:          sessionConfig,
        selections:      distribution.flatMap(a => a.slips.map(s => s.legs[0])), // minimal — full stored in slips
        slips:           allSlipsWithHashes,
        distribution,
        ...(groupId       ? { group_id:        groupId } : {}),
        ...(marketResult  ? { dominant_market: marketResult, breakout_market: marketResult.breakoutOutcome } : {}),
        ...(allocation    ? { bankroll:         allocation.bankroll } : {}),
      } as never)
      .select('id')
      .single()) as { data: { id: string } | null; error: { code?: string; message?: string } | null }

    if (!error && data) { newSessionId = data.id; break }
    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) continue
      return Response.json({ error: 'Failed to persist session', detail: error.message }, { status: 503 })
    }
  }

  if (!newSessionId) {
    return Response.json({ error: 'Failed to persist session after retries' }, { status: 503 })
  }

  // Update session_groups status if this was a v2 generate
  if (groupId) {
    await supabase
      .from('session_groups')
      .update({ status: 'generated', session_id: newSessionId, dominant_market: marketResult ?? null } as never)
      .eq('id', groupId)
  }

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, newSessionId, COOKIE_OPTIONS)

  return Response.json({
    slips: allSlipsWithHashes,
    distribution,
    sessionId: newSessionId,
    ...(marketResult ? { dominantMarket: marketResult } : {}),
    ...(allocation   ? { tierAllocation: allocation }   : {}),
  })
}
