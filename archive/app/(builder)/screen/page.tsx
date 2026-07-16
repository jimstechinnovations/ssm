'use client'

/**
 * app/(builder)/screen/page.tsx
 *
 * Screen Page — SSM v3 (Adaptive Profile-Based Selection)
 *
 * No gate rejection. Every fixture with odds gets a profile.
 * The first 8 unclaimed fixtures become the session set automatically.
 *
 * State machine:
 *   idle → screening → screened_ready (8 found) | screened_insufficient (<8) → generating → navigate
 */

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useSession } from '@/components/session/SessionProvider'
import { BookmakerSelector } from '@/components/screen/BookmakerSelector'
import { DateRangePicker } from '@/components/screen/DateRangePicker'
import { GateResultCard } from '@/components/screen/GateResultCard'
import { ConfirmationPanel } from '@/components/screen/ConfirmationPanel'
import { Button } from '@/components/ui/Button'

import type {
  BookmakerPlatform,
  ScreeningResult,
  Fixture,
  AccountAllocation,
  DominantMarketResult,
  ProfiledFixture,
  Slip,
  TierAllocation,
} from '@/lib/ssm/types'

// ─── Page state machine ───────────────────────────────────────────────────────

type PageStatus =
  | 'idle'
  | 'screening'
  | 'screened_insufficient'
  | 'screened_ready'
  | 'generating'

// ─── Generate API response shape ──────────────────────────────────────────────

interface GenerateResponse {
  slips:               Slip[]
  accountDistribution: AccountAllocation[]
  sessionId:           string
  dominantMarket?:     DominantMarketResult
  tierAllocation?:     TierAllocation
  groupId?:            string
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ScreenPage() {
  const router = useRouter()
  const { dispatch, setScreeningResult, state } = useSession()

  // ── Form state ──────────────────────────────────────────────────────────
  const [bookmaker, setBookmaker]               = useState<BookmakerPlatform | ''>('')
  const [dateFrom, setDateFrom]                 = useState<string>('')
  const [dateTo, setDateTo]                     = useState<string>('')
  const [showBookmakerError, setShowBookmakerError] = useState(false)

  // ── Page state ──────────────────────────────────────────────────────────
  const [status, setStatus]                     = useState<PageStatus>('idle')
  const [screeningResult, setLocalResult]       = useState<ScreeningResult | null>(null)
  const [screenError, setScreenError]           = useState<string | null>(null)
  const [generateError, setGenerateError]       = useState<string | null>(null)

  function handleDateChange(from: string, to: string) {
    setDateFrom(from)
    setDateTo(to)
  }

  // ── "Find Games" ────────────────────────────────────────────────────────
  async function handleScreen() {
    if (!bookmaker) { setShowBookmakerError(true); return }
    setShowBookmakerError(false)
    setScreenError(null)
    setGenerateError(null)
    setStatus('screening')
    setLocalResult(null)

    try {
      const body: Record<string, unknown> = { bookmaker, date_from: dateFrom, date_to: dateTo }
      if (state.groupId) body.group_id = state.groupId

      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        setScreenError(text || `Screening failed (HTTP ${res.status})`)
        setStatus('idle')
        return
      }

      const result: ScreeningResult = await res.json()
      setScreeningResult(result)
      setLocalResult(result)

      // v3: ready as soon as 8 unclaimed profiled fixtures exist
      setStatus(result.unclaimedQualifying >= 8 ? 'screened_ready' : 'screened_insufficient')
    } catch {
      setScreenError('Network error — please retry.')
      setStatus('idle')
    }
  }

  // ── "Confirm & Generate" ────────────────────────────────────────────────
  async function handleGenerate(bankroll: number, numAccounts: 6 | 7) {
    if (!screeningResult) return
    setGenerateError(null)
    setStatus('generating')

    // Extract raw Fixture objects from ProfiledFixtures for the generate request
    const top8Fixtures: Fixture[] = screeningResult.qualifyingFixtures
      .slice(0, 8)
      .map(p => p.fixture)

    const groupId = screeningResult.groupId

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, fixtures: top8Fixtures, bankroll, numAccounts }),
      })

      if (res.status === 503) {
        const text = await res.text().catch(() => '')
        setGenerateError(text || 'Generation service unavailable — please retry.')
        setStatus('screened_ready')
        return
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        setGenerateError(text || `Generation failed (HTTP ${res.status})`)
        setStatus('screened_ready')
        return
      }

      const data: GenerateResponse = await res.json()

      dispatch({
        type: 'SET_GENERATED',
        payload: {
          slips:          data.slips,
          distribution:   data.accountDistribution,
          sessionId:      data.sessionId,
          dominantMarket: data.dominantMarket,
          tierAllocation: data.tierAllocation,
        },
      })

      router.push('/builder/matrix?group=' + groupId)
    } catch {
      setGenerateError('Network error — please retry.')
      setStatus('screened_ready')
    }
  }

  function handleRetry() {
    setStatus('idle')
    setLocalResult(null)
    setScreenError(null)
    setGenerateError(null)
  }

  const isScreening  = status === 'screening'
  const isGenerating = status === 'generating'

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">

      <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Find Session Fixtures
      </h1>

      {/* ── Form ──────────────────────────────────────────────────────── */}
      <section
        aria-label="Screening form"
        className="flex flex-col gap-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <BookmakerSelector
          value={bookmaker}
          onChange={setBookmaker}
          showError={showBookmakerError}
        />
        <DateRangePicker onChange={handleDateChange} />

        <Button
          variant="primary"
          size="md"
          loading={isScreening}
          disabled={isScreening || isGenerating}
          onClick={handleScreen}
        >
          {isScreening ? 'Fetching fixtures…' : 'Find Games'}
        </Button>

        {screenError && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
            <p>{screenError}</p>
            <Button variant="secondary" size="sm" onClick={handleRetry}>Retry</Button>
          </div>
        )}
      </section>

      {/* ── Generate error ─────────────────────────────────────────────── */}
      {generateError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
          {generateError}
        </div>
      )}

      {/* ── Results ───────────────────────────────────────────────────── */}
      {screeningResult && (
        <div className="mt-8 flex flex-col gap-6">

          {/* Insufficient fixtures notice */}
          {status === 'screened_insufficient' && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                Only {screeningResult.unclaimedQualifying} of 8 fixtures available
              </p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-amber-700 dark:text-amber-500">
                <li>{screeningResult.screenedCount} fixture{screeningResult.screenedCount !== 1 ? 's' : ''} found with odds</li>
                {screeningResult.excludedFixtureIds.length > 0 && (
                  <li>{screeningResult.excludedFixtureIds.length} excluded — claimed by other active groups</li>
                )}
              </ul>
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                8 fixtures are required. Try widening your date range or selecting a different bookmaker.
              </p>
            </div>
          )}

          {/* Confirmation panel — shown when 8 fixtures ready */}
          {(status === 'screened_ready' || status === 'generating') && (
            <ConfirmationPanel
              qualifying={screeningResult.qualifyingFixtures.slice(0, 8)}
              dominantMarket={null}
              onConfirm={handleGenerate}
              loading={isGenerating}
              disabled={false}
            />
          )}

          {/* All profiled fixtures */}
          {screeningResult.allFixtures.length > 0 && (
            <section aria-label="All profiled fixtures">
              <h2 className="mb-3 text-base font-semibold text-zinc-700 dark:text-zinc-300">
                All Fixtures Found
                <span className="ml-2 text-sm font-normal text-zinc-400">
                  ({screeningResult.allFixtures.length} with odds)
                </span>
              </h2>
              <ul className="flex flex-col gap-3">
                {screeningResult.allFixtures.map((profiled: ProfiledFixture) => (
                  <li key={profiled.fixture.id}>
                    <GateResultCard profiled={profiled} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Retry button */}
          {(status === 'screened_insufficient' || status === 'screened_ready') && (
            <div className="flex justify-start">
              <Button variant="secondary" size="sm" onClick={handleRetry} disabled={isGenerating}>
                ↺ Search Again
              </Button>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
