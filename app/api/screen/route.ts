/**
 * app/api/screen/route.ts
 *
 * Gate screening orchestrator — POST /api/screen
 *
 * Fetches fixtures for the given bookmaker and date range, applies the
 * four structural gates (G1–G4) to each fixture's live odds, excludes
 * fixtures claimed by other active session groups, and returns the top-8
 * unclaimed qualifying fixtures in kickoff-time ascending order.
 *
 * Also creates or updates the session_groups row in Supabase.
 *
 * Requirements: 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 6.2, 6.3, 12.1, 12.4
 */

import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'
import { searchFixturesByDateRange, fetchFixtureOdds } from '@/lib/football-api/client'
import { runGateScreener } from '@/lib/ssm/gate-screener'
import { BOOKMAKER_IDS } from '@/lib/ssm/types'
import type { Fixture, FixtureWithGates, GateResult, ScreeningResult } from '@/lib/ssm/types'
import { BookmakerPlatformSchema } from '@/lib/ssm/schemas'

// ─── Validation ───────────────────────────────────────────────────────────────

const ScreenRequestSchema = z.object({
  bookmaker: BookmakerPlatformSchema,
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD'),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD'),
  group_id:  z.string().uuid().optional(),
}).refine(
  (data) => {
    const from = new Date(data.date_from)
    const to   = new Date(data.date_to)
    const maxTo = new Date(from)
    maxTo.setDate(maxTo.getDate() + 7)
    return to >= from && to <= maxTo
  },
  { message: 'date_to must be between date_from and date_from + 7 days' },
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Map<label, odds> from an OddsValue array for the gate screener */
function buildOddsMap(odds: Fixture['odds']): Map<string, number> {
  const map = new Map<string, number>()
  for (const o of odds) {
    // Gate screener needs specific labels — prefer first occurrence per label
    if (!map.has(o.label)) {
      map.set(o.label, o.value)
    }
  }
  return map
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // 1. Validate request body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = ScreenRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const { bookmaker, date_from, date_to, group_id } = parsed.data
  const bookmakerId = BOOKMAKER_IDS[bookmaker] // may be null for 'other'

  const supabase = createServerClient()

  // 2. Fetch claimed fixture IDs from all active groups (excluding own group on re-screen)
  const claimedQuery = supabase
    .from('session_groups')
    .select('claimed_fixture_ids')
    .in('status', ['screening', 'generated'])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activeGroups, error: groupsErr } = await (
    group_id ? claimedQuery.neq('id', group_id) : claimedQuery
  ) as { data: { claimed_fixture_ids: number[] }[] | null; error: unknown }

  if (groupsErr) {
    return Response.json({ error: 'Failed to load active groups' }, { status: 503 })
  }

  const claimedIds = new Set<number>(
    (activeGroups ?? []).flatMap(g => g.claimed_fixture_ids ?? []),
  )

  // 3. Fetch fixtures for the date range
  let allFixtures: Fixture[]
  try {
    allFixtures = await searchFixturesByDateRange(date_from, date_to, bookmakerId)
  } catch {
    return Response.json({ error: 'Failed to fetch fixtures' }, { status: 503 })
  }

  // 4. For each fixture: fetch odds → run gate screener
  const results: FixtureWithGates[] = []

  for (const fixture of allFixtures) {
    let gateResult: GateResult

    try {
      const { odds, oddsUnavailable } = await fetchFixtureOdds(fixture.id, bookmakerId)

      if (oddsUnavailable || odds.length === 0) {
        gateResult = { fixtureId: fixture.id, qualified: false, gates: [], rejectReason: 'ODDS_UNAVAILABLE' }
      } else {
        // Attach odds to fixture for downstream market detection
        const enrichedFixture = { ...fixture, odds }
        const oddsMap = buildOddsMap(odds)
        gateResult = runGateScreener(fixture.id, oddsMap)
        results.push({ fixture: enrichedFixture, gateResult })
        continue
      }
    } catch {
      gateResult = { fixtureId: fixture.id, qualified: false, gates: [], rejectReason: 'ODDS_UNAVAILABLE' }
    }

    results.push({ fixture, gateResult })
  }

  // 5. Select top-8 unclaimed qualifying fixtures sorted by kickoff ascending
  const qualifying = results.filter(r => r.gateResult.qualified)
  const unclaimed  = qualifying.filter(r => !claimedIds.has(r.fixture.id))
  // Already sorted by kickoff from searchFixturesByDateRange, but ensure order
  unclaimed.sort((a, b) => a.fixture.kickoff.localeCompare(b.fixture.kickoff))
  const top8 = unclaimed.slice(0, 8)

  const excludedFixtureIds = qualifying
    .filter(r => claimedIds.has(r.fixture.id))
    .map(r => r.fixture.id)

  // 6. Upsert session_groups row
  let newGroupId: string

  if (!group_id) {
    // Insert new group
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insertErr } = await (supabase
      .from('session_groups')
      .insert({
        status:              'screening',
        bookmaker,
        date_from,
        date_to,
        claimed_fixture_ids: top8.map(r => r.fixture.id),
      } as never)
      .select('id')
      .single()) as { data: { id: string } | null; error: unknown }

    if (insertErr || !inserted) {
      return Response.json({ error: 'Failed to create session group' }, { status: 503 })
    }
    newGroupId = inserted.id
  } else {
    // Update existing group's claimed fixture IDs on re-screen
    const { error: updateErr } = await supabase
      .from('session_groups')
      .update({ claimed_fixture_ids: top8.map(r => r.fixture.id) } as never)
      .eq('id', group_id)

    if (updateErr) {
      return Response.json({ error: 'Failed to update session group' }, { status: 503 })
    }
    newGroupId = group_id
  }

  // 7. Return screening result
  const screeningResult: ScreeningResult = {
    groupId:             newGroupId,
    allFixtures:         results,
    qualifyingFixtures:  top8,
    excludedFixtureIds,
    screenedCount:       results.length,
    qualifyingCount:     qualifying.length,
    unclaimedQualifying: unclaimed.length,
  }

  return Response.json(screeningResult)
}
