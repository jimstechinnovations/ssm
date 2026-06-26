/**
 * Group Dashboard - Server Component.
 *
 * Loads active session groups from Supabase. If Supabase is temporarily
 * unreachable, the dashboard still renders so the user can continue into the
 * screening flow instead of being blocked by an error page.
 */

import { createServerClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { GroupCard } from '@/components/dashboard/GroupCard'
import { NewGroupButton } from '@/components/dashboard/NewGroupButton'
import type { SessionGroup, SessionGroupStatus, BookmakerPlatform } from '@/lib/ssm/types'

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

async function loadGroups(): Promise<{ groups: SessionGroup[]; warning: string | null }> {
  const supabase = createServerClient()

  try {
    const { data, error } = await supabase
      .from('session_groups')
      .select('*')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })

    if (error) {
      return { groups: [], warning: error.message }
    }

    return {
      groups: ((data ?? []) as SessionGroupRow[]).map(mapRow),
      warning: null,
    }
  } catch (err) {
    return {
      groups: [],
      warning: err instanceof Error ? err.message : 'Unable to reach Supabase',
    }
  }
}

export default async function DashboardPage() {
  const { groups, warning } = await loadGroups()

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Builder Dashboard
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Choose PEDLAS for real Betway total-goals slips, or continue with the SSM group workflow.
        </p>
      </div>

      {warning && (
        <div
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
          role="status"
        >
          Supabase is currently unreachable, so saved groups could not be loaded. You can still start a new screening flow.
        </div>
      )}

      <section className="mb-8 grid gap-4 md:grid-cols-2" aria-label="Builder modes">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-3">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              PEDLAS Odds Builder
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Build real Betway total-goals slips from public odds using only 4.5, 5.5, and 6.5 lines.
            </p>
          </div>
          <Link
            href="/builder/pedlas"
            className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Open PEDLAS
          </Link>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-3">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              SSM Group Pipeline
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Screen fixtures, generate the matrix, distribute accounts, and print the SSM slips.
            </p>
          </div>
          <NewGroupButton />
        </div>
      </section>

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
