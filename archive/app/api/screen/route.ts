/**
 * app/api/screen/route.ts
 *
 * Adaptive fixture screener — POST /api/screen (SSM v3)
 *
 * Replaces the hard G1–G4 gate rejection with profile-based classification.
 * Every fixture that has odds data is accepted and profiled.
 * The first 8 unclaimed fixtures with sufficient odds become the session set.
 *
 * Flow:
 *  1. Validate request body
 *  2. Fetch claimed fixture IDs from other active groups
 *  3. Fetch fixtures for the date range
 *  4. For each fixture: fetch odds → profile it
 *  5. Select first 8 unclaimed profiled fixtures (sorted by kickoff ASC)
 *  6. Upsert session_groups row
 *  7. Return ScreeningResult with ProfiledFixture[] instead of FixtureWithGates[]
 */

import { z } from 'zod'
import { createServerClient } from '@/lib/supabase/server'
import { searchFixturesByDateRange, fetchFixtureOdds } from '@/lib/football-api/client'
import { profileFixture } from '@/lib/ssm/gate-screener'
import { BOOKMAKER_IDS } from '@/lib/ssm/types'
import type { Fixture, ProfiledFixture, ScreeningResult } from '@/lib/ssm/types'
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
  const bookmakerId = BOOKMAKER_IDS[bookmaker]

  const supabase = createServerClient()

  // 2. Fetch claimed fixture IDs from other active groups
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

  // 4. For each fixture: fetch odds → profile it
  //    No rejection — every fixture with any odds gets a profile.
  //    Fixtures with no odds at all are skipped (not profiled, not included).
  const allProfiled: ProfiledFixture[] = []

  for (const fixture of allFixtures) {
    try {
      const { odds, oddsUnavailable } = await fetchFixtureOdds(fixture.id, bookmakerId)

      if (oddsUnavailable || odds.length === 0) {
        // No odds data — skip this fixture entirely (cannot profile without any odds)
        continue
      }

      // Attach live odds to fixture and profile it
      const enrichedFixture: Fixture = { ...fixture, odds }
      const profiled = profileFixture(enrichedFixture)
      allProfiled.push(profiled)
    } catch {
      // Odds fetch failed for this fixture — skip gracefully
      continue
    }
  }

  // 5. Select first 8 unclaimed profiled fixtures sorted by kickoff ASC
  //    (searchFixturesByDateRange already returns sorted by kickoff, preserving order)
  const unclaimed = allProfiled.filter(p => !claimedIds.has(p.fixture.id))
  const top8      = unclaimed.slice(0, 8)

  const excludedFixtureIds = allProfiled
    .filter(p => claimedIds.has(p.fixture.id))
    .map(p => p.fixture.id)

  // 6. Upsert session_groups row
  let newGroupId: string

  if (!group_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insertErr } = await (supabase
      .from('session_groups')
      .insert({
        status:              'screening',
        bookmaker,
        date_from,
        date_to,
        claimed_fixture_ids: top8.map(p => p.fixture.id),
      } as never)
      .select('id')
      .single()) as { data: { id: string } | null; error: unknown }

    if (insertErr || !inserted) {
      return Response.json({ error: 'Failed to create session group' }, { status: 503 })
    }
    newGroupId = inserted.id
  } else {
    const { error: updateErr } = await supabase
      .from('session_groups')
      .update({ claimed_fixture_ids: top8.map(p => p.fixture.id) } as never)
      .eq('id', group_id)

    if (updateErr) {
      return Response.json({ error: 'Failed to update session group' }, { status: 503 })
    }
    newGroupId = group_id
  }

  // 7. Return screening result
  const screeningResult: ScreeningResult = {
    groupId:             newGroupId,
    allFixtures:         allProfiled,
    qualifyingFixtures:  top8,
    excludedFixtureIds,
    screenedCount:       allProfiled.length,
    // qualifyingCount = all profiled fixtures (no rejection in v3)
    qualifyingCount:     allProfiled.length,
    unclaimedQualifying: unclaimed.length,
  }

  return Response.json(screeningResult)
}
