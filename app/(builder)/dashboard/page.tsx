/**
 * app/(builder)/dashboard/page.tsx
 *
 * Group Dashboard — Server Component.
 *
 * Fetches all active session_groups directly from Supabase (service role client)
 * and renders them as a list of GroupCard components sorted by created_at DESC.
 *
 * Requirements: 6.6
 */

import { createServerClient } from '@/lib/supabase/server'
import { GroupCard } from '@/components/dashboard/GroupCard'
import { NewGroupButton } from '@/components/dashboard/NewGroupButton'
import type { SessionGroup, SessionGroupStatus, BookmakerPlatform } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// DB row shape (snake_case) returned by Supabase
// ---------------------------------------------------------------------------

interface SessionGroupRow {
  id:                  string
  status:              string
  bookmaker:           string
  date_from:           string
  date_to:             string
  claimed_fixture_ids: number[]
  screening_results:   unknown | null
  dominant_market:     unknown | null
  bankroll:            number
  num_accounts:        number
  session_id:          string | null
  created_at:          string
  updated_at:          string
}

// ---------------------------------------------------------------------------
// Map a DB row to the SessionGroup TypeScript interface (camelCase)
// ---------------------------------------------------------------------------

function mapRow(row: SessionGroupRow): SessionGroup {
  return {
    id:                 row.id,
    status:             row.status              as SessionGroupStatus,
    bookmaker:          row.bookmaker           as BookmakerPlatform,
    dateFrom:           row.date_from,
    dateTo:             row.date_to,
    claimedFixtureIds:  row.claimed_fixture_ids ?? [],
    screeningResults:   row.screening_results   as SessionGroup['screeningResults'],
    dominantMarket:     row.dominant_market     as SessionGroup['dominantMarket'],
    bankroll:           row.bankroll,
    numAccounts:        row.num_accounts        as 6 | 7,
    sessionId:          row.session_id,
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  // ── Fetch groups from Supabase ─────────────────────────────────────────
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('session_groups')
    .select('*')
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })

  // ── Error state ────────────────────────────────────────────────────────

  if (error) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col items-start gap-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Group Dashboard
          </h1>
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            Failed to load groups: {error.message}
          </p>
        </div>
      </main>
    )
  }

  const groups: SessionGroup[] = (data ?? []).map(mapRow)

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

      {/* Page heading + action */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Group Dashboard
        </h1>
        <NewGroupButton />
      </div>

      {/* Empty state */}
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 py-20 text-center dark:border-zinc-700">
          <p className="mb-2 text-base font-medium text-zinc-600 dark:text-zinc-400">
            No groups yet
          </p>
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            Click &ldquo;+ New Group&rdquo; to screen fixtures and start a session.
          </p>
        </div>
      ) : (
        /* Group list */
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => (
            <li key={group.id}>
              <GroupCard group={group} />
            </li>
          ))}
        </ul>
      )}

    </main>
  )
}
