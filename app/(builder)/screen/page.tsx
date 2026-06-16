'use client'

/**
 * app/(builder)/screen/page.tsx
 *
 * Screen Page — Step 1 of the v2 SSM Builder flow.
 *
 * State machine:
 *   idle → screening → screened_insufficient | screened_ready → generating → navigate
 *
 * Requirements: 2.1–2.6, 3.1–3.7, 4.5, 5.1–5.5, 13.1, 13.2, 13.4, 13.5
 */

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useSession } from '@/components/session/SessionProvider'
import { BookmakerSelector } from '@/components/screen/BookmakerSelector'
import { DateRangePicker } from '@/components/screen/DateRangePicker'
import { GateResultCard } from '@/components/screen/GateResultCard'
import { ConfirmationPanel } from '@/components/screen/ConfirmationPanel'
import { Button } from '@/components/ui/Button'
import { detectDominantMarket } from '@/lib/ssm/market-detector'

import type {
  BookmakerPlatform,
  ScreeningResult,
  Fixture,
  AccountAllocation,
  DominantMarketResult,
  Slip,
  TierAllocation,
} from '@/lib/ssm/types'

// ─── Page-level state machine ─────────────────────────────────────────────────

type PageStatus =
  | 'idle'
  | 'screening'
  | 'screened_insufficient'
  | 'screened_ready'
  | 'generating'
  | 'error'

// ─── Generate API response shape ──────────────────────────────────────────────

interface GenerateResponse {
  slips: Slip[]
  accountDistribution: AccountAllocation[]
  sessionId: string
  dominantMarket?: DominantMarketResult
  tierAllocation?: TierAllocation
  groupId?: string
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ScreenPage() {
  const router = useRouter()
  const { dispatch, setScreeningResult, state } = useSession()

  // ── Form state ──────────────────────────────────────────────────────────
  const [bookmaker, setBookmaker] = useState<BookmakerPlatform | ''>('')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [showBookmakerError, setShowBookmakerError] = useState(false)

  // ── Page state machine ──────────────────────────────────────────────────
  const [status, setStatus] = useState<PageStatus>('idle')

  // ── Screening result ────────────────────────────────────────────────────
  const [screeningResult, setLocalScreeningResult] = useState<ScreeningResult | null>(null)

  // ── Dominant market (computed client-side from screening result) ─────────
  const [dominantMarket, setDominantMarket] = useState<DominantMarketResult | null>(null)

  // ── Error messages ──────────────────────────────────────────────────────
  const [screenError, setScreenError] = useState<string | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // ── Date range handler ──────────────────────────────────────────────────
  function handleDateChange(from: string, to: string) {
    setDateFrom(from)
    setDateTo(to)
  }

  // ── "Find Qualifying Games" ─────────────────────────────────────────────
  async function handleScreen() {
    // Req 2.5 — bookmaker must be selected
    if (!bookmaker) {
      setShowBookmakerError(true)
      return
    }
    setShowBookmakerError(false)
    setScreenError(null)
    setGenerateError(null)
    setStatus('screening')
    setLocalScreeningResult(null)
    setDominantMarket(null)

    try {
      const body: Record<string, unknown> = {
        bookmaker,
        date_from: dateFrom,
        date_to: dateTo,
      }
      // Pass current groupId if re-screening an existing group
      if (state.groupId) {
        body.group_id = state.groupId
      }

      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // Req 13.1 — partial-results error: still show retry
        setScreenError(text || `Screening failed (HTTP ${res.status})`)
        setStatus('idle')
        return
      }

      const result: ScreeningResult = await res.json()

      // Store in SessionProvider
      setScreeningResult(result)
      // Store locally for rendering
      setLocalScreeningResult(result)

      // Compute client-side market preview when ≥ 8 qualifying fixtures
      if (result.unclaimedQualifying >= 8 && result.qualifyingFixtures.length >= 8) {
        try {
          const top8: Fixture[] = result.qualifyingFixtures
            .slice(0, 8)
            .map((fwg) => fwg.fixture)
          const market = detectDominantMarket(top8)
          setDominantMarket(market)
        } catch {
          // Non-fatal — market preview degrades gracefully
          setDominantMarket(null)
        }
      }

      if (result.unclaimedQualifying >= 8) {
        setStatus('screened_ready')
      } else {
        setStatus('screened_insufficient')
      }
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

    const qualifyingFixtures: Fixture[] = screeningResult.qualifyingFixtures
      .slice(0, 8)
      .map((fwg) => fwg.fixture)

    const groupId = screeningResult.groupId

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId,
          fixtures: qualifyingFixtures,
          bankroll,
          numAccounts,
        }),
      })

      // Req 13.2 — 503 → show error banner, re-enable button
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

      // Dispatch SET_GENERATED to SessionProvider
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

      // Navigate to matrix view
      router.push('/builder/matrix?group=' + groupId)
    } catch {
      setGenerateError('Network error — please retry.')
      setStatus('screened_ready')
    }
  }

  // ── Retry screening (Req 13.1) ──────────────────────────────────────────
  function handleRetry() {
    setStatus('idle')
    setLocalScreeningResult(null)
    setDominantMarket(null)
    setScreenError(null)
    setGenerateError(null)
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  const isScreening = status === 'screening'
  const isGenerating = status === 'generating'

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">

      {/* Page title */}
      <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Screen Fixtures
      </h1>

      {/* ── Screening form ─────────────────────────────────────────────── */}
      <section
        aria-label="Screening form"
        className="flex flex-col gap-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {/* Bookmaker selector */}
        <BookmakerSelector
          value={bookmaker}
          onChange={setBookmaker}
          showError={showBookmakerError}
        />

        {/* Date range picker */}
        <DateRangePicker onChange={handleDateChange} />

        {/* Screen button */}
        <Button
          variant="primary"
          size="md"
          loading={isScreening}
          disabled={isScreening || isGenerating}
          onClick={handleScreen}
        >
          {isScreening ? 'Searching…' : 'Find Qualifying Games'}
        </Button>

        {/* Screen-level error (Req 13.1) */}
        {screenError && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
          >
            <p>{screenError}</p>
            <Button variant="secondary" size="sm" onClick={handleRetry}>
              Retry Screening
            </Button>
          </div>
        )}
      </section>

      {/* ── Generate error banner (Req 13.2) ───────────────────────────── */}
      {generateError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
        >
          {generateError}
        </div>
      )}

      {/* ── Results area ───────────────────────────────────────────────── */}
      {screeningResult && (
        <div className="mt-8 flex flex-col gap-6">

          {/* ── Insufficient fixtures (Req 3.5, Req 13.5) ──────────────── */}
          {(status === 'screened_insufficient' || status === 'screened_ready' || status === 'generating') && (
            <>
              {/* Zero qualifying / all fixtures claimed — Req 13.5 */}
              {screeningResult.unclaimedQualifying === 0 && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400"
                >
                  <p className="font-semibold">No qualifying fixtures available</p>
                  <p className="mt-1">
                    All qualifying fixtures for this date range are currently claimed by
                    other active session groups. Please wait for an active group to be
                    flushed, or widen your date range and retry.
                  </p>
                </div>
              )}

              {/* Fewer than 8 — show count + exclusion reasons (Req 3.5) */}
              {screeningResult.unclaimedQualifying > 0 &&
               screeningResult.unclaimedQualifying < 8 && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30"
                >
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                    Only {screeningResult.unclaimedQualifying} of 8 qualifying fixtures found
                  </p>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-amber-700 dark:text-amber-500">
                    <li>
                      {screeningResult.screenedCount} fixture
                      {screeningResult.screenedCount !== 1 ? 's' : ''} screened
                    </li>
                    <li>
                      {screeningResult.qualifyingCount} passed all gates
                    </li>
                    {screeningResult.excludedFixtureIds.length > 0 && (
                      <li>
                        {screeningResult.excludedFixtureIds.length} fixture
                        {screeningResult.excludedFixtureIds.length !== 1 ? 's' : ''}{' '}
                        excluded — claimed by other active groups
                      </li>
                    )}
                  </ul>
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                    8 unclaimed qualifying fixtures are required. "Confirm &amp; Generate"
                    is disabled until this threshold is met.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── Confirmation panel (when ≥ 8 unclaimed) — Req 3.6, 3.7 ── */}
          {screeningResult.unclaimedQualifying >= 8 &&
           (status === 'screened_ready' || status === 'generating') && (
            <ConfirmationPanel
              qualifying={screeningResult.qualifyingFixtures.slice(0, 8)}
              dominantMarket={dominantMarket}
              onConfirm={handleGenerate}
              loading={isGenerating}
              disabled={false}
            />
          )}

          {/* ── All screened fixtures gate-result cards — Req 1.5, 3.1 ── */}
          {screeningResult.allFixtures.length > 0 && (
            <section aria-label="Screened fixtures">
              <h2 className="mb-3 text-base font-semibold text-zinc-700 dark:text-zinc-300">
                All Screened Fixtures
                <span className="ml-2 text-sm font-normal text-zinc-400">
                  ({screeningResult.allFixtures.length} found)
                </span>
              </h2>
              <ul className="flex flex-col gap-3">
                {screeningResult.allFixtures.map((fwg) => (
                  <li key={fwg.fixture.id}>
                    <GateResultCard
                      fixture={fwg.fixture}
                      gateResult={fwg.gateResult}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Retry screening button (Req 13.1) ───────────────────────── */}
          {(status === 'screened_insufficient' ||
            status === 'screened_ready') && (
            <div className="flex justify-start">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRetry}
                disabled={isGenerating}
              >
                ↺ Retry Screening
              </Button>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
