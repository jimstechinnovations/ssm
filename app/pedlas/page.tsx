'use client'

/**
 * app/pedlas/page.tsx
 *
 * PEDLA odds builder — Under 4.5 coverage for a small stake, across one or more
 * bookmakers (each selected book gets its own slips built from its own odds/rules).
 * Self-contained client page: form → POST /api/pedlas → render per-book PedlasBooks.
 *
 * HONESTY (non-negotiable UI): this is a structured −vig lottery. The page shows
 * P(any hit), per-slip all-or-nothing reality, and never advertises +EV from
 * structure or the Win Boost. See pedla_v1.md §0.
 */

import React, { useState, useEffect, useRef } from 'react'
import type { PedlasBook, PedlasSlip, AxisAdvisory } from '@/lib/pedlas/types'
import { flipLeg, removeLeg, removeSlip, duplicateSlip } from '@/lib/pedlas/edit'

interface BuildMeta {
  scanned: number
  fixturesFound: number
  qualifyingAxes: number
  usedAxes: number
  minKickoffGapMinutes?: number
  boostVerified?: boolean
  advisory?: { withForm: number; total: number }
}

interface PedlasResponse {
  book: PedlasBook
  meta: BuildMeta
  bookId?: string | null
  saved?: boolean
}

interface BookResult {
  bookId: string
  label: string
  book?: PedlasBook
  meta?: BuildMeta
  savedId?: string | null
  saved?: boolean
  error?: string
  detail?: string
}

interface BookInfo {
  id: string
  label: string
  minStake: number
  boostVerified: boolean
  feedVerified: boolean
  credentialsConfigured: boolean
}

interface PlacementReceiptView {
  confirmed: boolean
  confirmedBy: string
  bookingCode?: string
  betId?: string
  balanceBefore?: number
  balanceAfter?: number
  siteOdds?: number
}

interface PlacementJobView {
  slipId: number
  stake: number
  status: string
  note?: string
  plannedDelaySec: number
  receipt?: PlacementReceiptView
}

interface PlacementRunView {
  runId: string
  bookId: string
  dryRun: boolean
  status: string
  jobs: PlacementJobView[]
  log: string[]
}

interface BookSummary {
  id: string
  objective: string
  legCount: number
  slipCount: number
  budget: number
  pAnyHit: number
  guaranteedFloor: boolean
  evMultiple: number
  dateFrom: string | null
  dateTo: string | null
  createdAt: string
}

const naira = (x: number) => '₦' + Math.round(x).toLocaleString('en-US')
const pct = (x: number, dp = 2) => (x * 100).toFixed(dp) + '%'
const kickoffTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))

function todayPlus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

type Objective = 'moonshot' | 'coverage'

export default function PedlasPage() {
  const [objective, setObjective] = useState<Objective>('coverage')
  const [dateFrom, setDateFrom] = useState(todayPlus(0))
  const [dateTo, setDateTo] = useState(todayPlus(1))   // near-term only (1–2 day max window)
  const [budget, setBudget] = useState(1000)
  const [legCount, setLegCount] = useState(7)
  const [minAnchorDistance, setMinAnchor] = useState(1)
  const [maxPerLeague, setMaxPerLeague] = useState(3)
  const [minKickoffGapMinutes, setMinKickoffGapMinutes] = useState(60)
  const [selectedBooks, setSelectedBooks] = useState<string[]>(['betway_nigeria'])
  const [availableBooks, setAvailableBooks] = useState<BookInfo[]>([])

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PedlasResponse | null>(null)
  const [results, setResults] = useState<BookResult[]>([])
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [saved, setSaved] = useState<boolean | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [history, setHistory] = useState<BookSummary[]>([])
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [editedBook, setEditedBook] = useState<PedlasBook | null>(null)
  const [dirty, setDirty] = useState(false)

  // Switching objective nudges sensible defaults: coverage wants near-anchor neighbours (A=1),
  // moonshot wants high-payout flips spread apart (A=3).
  function chooseObjective(next: Objective) {
    setObjective(next)
    setMinAnchor(next === 'coverage' ? 1 : 3)
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/pedlas/books?limit=30')
      const j = await r.json()
      setHistory(j.books ?? [])
    } catch { /* history is best-effort */ }
  }

  async function loadBook(id: string) {
    setStatus('loading'); setError(null)
    try {
      const r = await fetch(`/api/pedlas/books/${id}`)
      const j = await r.json()
      if (!r.ok) { setError(j.error || 'Failed to load saved book'); setStatus('error'); return }
      setResults([])
      setActiveBookId(j.book?.bookId ?? null)
      setData({ book: j.book, meta: j.meta }); setCurrentId(id); setSaved(true); setStatus('done')
    } catch { setError('Network error loading book.'); setStatus('error') }
  }

  /** Point the page at one book's result (tab click / after build). */
  function activateResult(r: BookResult) {
    setActiveBookId(r.bookId)
    if (r.book && r.meta) {
      setData({ book: r.book, meta: r.meta, bookId: r.savedId, saved: r.saved })
      setSaved(r.saved ?? null); setCurrentId(r.savedId ?? null)
    } else {
      setData(null); setSaved(null); setCurrentId(null)
    }
  }

  // save=false on auto-refresh ticks so the history isn't flooded with near-identical books.
  async function build(opts?: { save?: boolean }) {
    const save = opts?.save !== false
    setStatus('loading'); setError(null)
    try {
      const res = await fetch('/api/pedlas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: selectedBooks,
          date_from: dateFrom, date_to: dateTo,
          budget, legCount, minKickoffGapMinutes, objective, save,
          params: { minAnchorDistance, maxPerLeague },
        }),
      })
      const json = await res.json()
      const rs: BookResult[] = json.results ?? []
      setResults(rs)
      const firstOk = rs.find(r => r.book)
      if (!res.ok || !firstOk) {
        setError(json.detail || json.error || `Request failed (HTTP ${res.status})`)
        setStatus('error'); setAutoRefresh(false); return  // stop auto-refresh on error (backoff)
      }
      const keep = rs.find(r => r.bookId === activeBookId && r.book) ?? firstOk
      activateResult(keep)
      setStatus('done'); setLastRefresh(new Date())
      if (save) loadHistory()
    } catch {
      setError('Network error — please retry.'); setStatus('error'); setAutoRefresh(false)
    }
  }

  // Restore the latest saved book on mount (survives refresh) + load history + book registry.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/books')
        const j = await r.json()
        setAvailableBooks(j.books ?? [])
      } catch { /* registry is best-effort */ }
      try {
        const r = await fetch('/api/pedlas/books?limit=30')
        const j = await r.json()
        setHistory(j.books ?? [])
        if (j.books?.[0]) loadBook(j.books[0].id)
      } catch { /* offline-of-DB: fine */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opt-in auto-refresh: re-fetch odds every 60s while the page is open. A ref keeps the
  // interval pointed at the latest build closure without re-creating the timer each render.
  const buildRef = useRef(build)
  buildRef.current = build
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(() => buildRef.current({ save: false }), 60_000)
    return () => clearInterval(t)
  }, [autoRefresh])

  // Mirror the loaded/built book into editable state (deep clone so edits don't touch the response).
  useEffect(() => {
    if (data?.book) { setEditedBook(structuredClone(data.book)); setDirty(false) }
    else setEditedBook(null)
  }, [data])

  function edit(fn: (b: PedlasBook) => PedlasBook) {
    setEditedBook(prev => (prev ? fn(prev) : prev))
    setDirty(true)
    setSaved(null)
  }

  function resetEdits() {
    if (data?.book) { setEditedBook(structuredClone(data.book)); setDirty(false) }
  }

  async function saveEdited(): Promise<string | null> {
    if (!editedBook) return null
    try {
      const r = await fetch('/api/pedlas/books', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: editedBook, meta: { ...(data?.meta ?? {}), edited: true } }),
      })
      const j = await r.json()
      if (!r.ok || !j.bookId) { setSaved(false); return null }
      setSaved(true); setDirty(false); setCurrentId(j.bookId); loadHistory()
      return j.bookId as string
    } catch { setSaved(false); return null }
  }

  async function printSlips() {
    let id = currentId
    if (dirty || !id) id = await saveEdited()   // persist first so the print view loads a stable record
    if (id) window.open(`/pedlas/print/${id}`, '_blank')
  }

  const book = editedBook
  const advByFixture = new Map<number, AxisAdvisory>(
    (editedBook?.pool ?? []).filter(a => a.advisory).map(a => [a.fixtureId, a.advisory!]),
  )
  const decisions = (editedBook?.pool ?? [])
    .filter(a => a.decision)
    .sort((a, b) => (b.decision!.confidence) - (a.decision!.confidence))

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">PEDLA Odds Builder</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Under 4.5 coverage (Under dominant at ≥ 1.20 — the wide-net, boost-eligible pocket).
            A small stake spread across the most probable high-payout slips, per bookmaker.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <a href="/placements" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
            📒 Placements &amp; results
          </a>
          <a href="/config" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
            ⚙ Bot config
          </a>
        </div>
      </header>

      {/* Honest disclosure — always visible */}
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Reality check:</strong> this is a <strong>structured −vig lottery</strong>. PEDLA
        diversifies your stake across plausible high-payout slips — it does <strong>not</strong> beat
        the bookmaker margin or create edge, and the Win Boost is a subsidy, not edge. Each slip is
        all-or-nothing, and the chance any slip hits is small.
      </div>

      {/* Bookmaker multi-select */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Bookmakers:</span>
        {(availableBooks.length ? availableBooks : [{ id: 'betway_nigeria', label: 'Betway Nigeria', minStake: 100, boostVerified: true, feedVerified: true, credentialsConfigured: false }]).map(b => (
          <label key={b.id} className={`flex items-center gap-1.5 ${b.feedVerified ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-400'}`}>
            <input
              type="checkbox"
              checked={selectedBooks.includes(b.id)}
              onChange={e => setSelectedBooks(prev => e.target.checked ? [...prev, b.id] : prev.filter(x => x !== b.id))}
            />
            {b.label}
            {!b.feedVerified && <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800" title="Feed not yet verified — builds will fail with a clear error">no feed yet</span>}
            {!b.boostVerified && b.feedVerified && <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800" title="Bonus table unverified — payouts computed with ZERO boost (never overstated)">0 boost</span>}
          </label>
        ))}
        {selectedBooks.length > 1 && (
          <span className="text-xs text-zinc-500">budget splits equally: {naira(Math.floor(budget / selectedBooks.length))} each</span>
        )}
      </div>

      {/* Objective toggle */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="inline-flex rounded-lg border border-zinc-300 p-0.5 dark:border-zinc-600">
          <button
            onClick={() => chooseObjective('coverage')}
            className={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${objective === 'coverage' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            Coverage <span className="font-normal opacity-70">· frequent small win</span>
          </button>
          <button
            onClick={() => chooseObjective('moonshot')}
            className={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${objective === 'moonshot' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            Moonshot <span className="font-normal opacity-70">· rare big win</span>
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          {objective === 'coverage'
            ? 'Covers the most-likely outcomes (keeps near-miss neighbours) so any single hit returns at least your total stake. Same −vig EV — just a higher chance of a small win.'
            : 'Ranks high-payout flips and spreads slips apart for a rare large payout. Same −vig EV — lower chance, bigger prize.'}
        </p>
      </div>

      {/* Form */}
      <div className="mb-8 grid grid-cols-2 gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 sm:grid-cols-4">
        <Field label="Date from"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} /></Field>
        <Field label="Date to"><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} /></Field>
        <Field label="Budget (₦)"><input type="number" min={100} step={100} value={budget} onChange={e => setBudget(+e.target.value)} className={inputCls} /></Field>
        <Field label="Legs (L)"><input type="number" min={3} max={18} value={legCount} onChange={e => setLegCount(+e.target.value)} className={inputCls} /></Field>
        <Field label="Min Over-flips (A)"><input type="number" min={0} max={legCount} value={minAnchorDistance} onChange={e => setMinAnchor(+e.target.value)} className={inputCls} /></Field>
        <Field label="Max legs / league (D)"><input type="number" min={1} value={maxPerLeague} onChange={e => setMaxPerLeague(+e.target.value)} className={inputCls} /></Field>
        <Field label="Kickoff gap (min)"><input type="number" min={0} step={15} value={minKickoffGapMinutes} onChange={e => setMinKickoffGapMinutes(+e.target.value)} className={inputCls} /></Field>
        <div className="flex items-end">
          <button
            onClick={() => build({ save: true })}
            disabled={status === 'loading'}
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {status === 'loading' ? 'Building…' : 'Build slips'}
          </button>
        </div>
      </div>

      {/* Controls: refresh odds + opt-in auto-refresh + save state */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button
          onClick={() => build({ save: true })}
          disabled={status === 'loading'}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          ↻ Refresh odds
        </button>
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto-refresh every 60s (while open)
        </label>
        {lastRefresh && <span className="text-xs text-zinc-400">updated {lastRefresh.toLocaleTimeString()}</span>}
        {saved === true && <span className="text-xs text-green-600 dark:text-green-400">✓ saved to cloud</span>}
        {saved === false && <span className="text-xs text-amber-600 dark:text-amber-400">not saved — run migration 003_pedlas_books.sql</span>}
      </div>

      {status === 'error' && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {status === 'loading' && (
        <p className="text-sm text-zinc-500">Fetching odds, ranking slips{book ? '' : ' (NIM)'}…</p>
      )}

      {/* Per-book result tabs (multi-book builds) */}
      {results.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {results.map(r => (
            <button
              key={r.bookId}
              onClick={() => activateResult(r)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                activeBookId === r.bookId
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                  : r.book
                    ? 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800'
                    : 'border-red-300 text-red-600 dark:border-red-700/60 dark:text-red-400'
              }`}
              title={r.error ? `${r.error}${r.detail ? ` — ${r.detail}` : ''}` : undefined}
            >
              {r.label} {r.book ? `· ${r.book.slips.length} slips` : '· failed'}
            </button>
          ))}
        </div>
      )}
      {results.find(r => r.bookId === activeBookId && r.error) && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          <strong>{results.find(r => r.bookId === activeBookId)!.error}</strong>
          {results.find(r => r.bookId === activeBookId)!.detail && (
            <span className="ml-1">— {results.find(r => r.bookId === activeBookId)!.detail}</span>
          )}
        </div>
      )}

      {book && data && (
        <section>
          {/* Edit toolbar */}
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <button onClick={printSlips}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
              🖨 Print slips
            </button>
            <button onClick={saveEdited} disabled={!dirty}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              Save edits
            </button>
            <button onClick={resetEdits} disabled={!dirty}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              Reset
            </button>
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">unsaved edits</span>}
            <span className="ml-auto text-xs text-zinc-400">edit below: ⇄ flip a leg · remove a leg · ⧉ duplicate / ✕ remove a slip</span>
          </div>

          {/* Book summary */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="Mode" value={book.objective === 'coverage' ? 'Coverage' : 'Moonshot'} />
            <Stat label="Slips placed" value={`${book.slips.length} / ${book.K}`} />
            <Stat label="P(any hit)" value={pct(book.meta.pAnyHit)} />
            <Stat label="Total stake" value={naira(book.totalStake)} />
            <Stat label="Worst hit" value={naira(book.minPayout)} />
            <Stat label="Win Boost" value={`+${book.slips[0]?.boostPct ?? 0}%`} />
            <Stat label="Legs (L)" value={String(book.legCount)} />
            <Stat label="Compression" value={`${Math.round(book.compressionRatio)}×`} />
          </div>

          {/* Floor banner — only meaningful/honest for coverage */}
          <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${book.guaranteedFloor
            ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-700/60 dark:bg-green-950/30 dark:text-green-200'
            : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200'}`}>
            {book.guaranteedFloor
              ? <><strong>Floor secured:</strong> if any one slip lands you get back ≥ {naira(book.totalStake)} (your whole stake). Worst single hit: {naira(book.minPayout)}. P(at least one hits) = {pct(book.meta.pAnyHit)}.</>
              : <><strong>No floor:</strong> the worst hit ({naira(book.minPayout)}) is below your total stake ({naira(book.totalStake)}) — a single hit may not cover the book. Raise Min Over-flips (A) or use Coverage mode.</>}
          </div>

          <div className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-800/50">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">Book EV/₦1: </span>
            <span className={book.verdict.evMultiple >= 1 ? 'text-green-600' : 'text-red-600 dark:text-red-400'}>
              {book.verdict.evMultiple.toFixed(3)} ({((book.verdict.evMultiple - 1) * 100).toFixed(1)}%)
            </span>
            <span className="text-zinc-500"> · +EV: {String(book.verdict.positiveEV)} · avg margin {pct(book.verdict.avgMargin, 1)}</span>
            <span className="ml-2 text-zinc-500">
              · scanned {data.meta.scanned} fixtures, {data.meta.qualifyingAxes} qualifying
            </span>
            {data.meta.advisory && data.meta.advisory.withForm > 0 && (
              <span className="ml-2 text-zinc-500">· model leans on {data.meta.advisory.withForm}/{data.meta.advisory.total} fixtures <em>(advisory only — no edge)</em></span>
            )}
          </div>

          {/* Decision summary — why each game was picked (advisory, not an edge claim) */}
          {decisions.length > 0 && (
            <details open className="mb-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Decision summary — most-likely side per game ({decisions.length}) <span className="font-normal text-zinc-500">· drove selection; slips scatter around it (see each slip&apos;s Pick) · advisory, not an edge</span>
              </summary>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {decisions.map(a => (
                  <div key={a.fixtureId} className="px-4 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">{a.game}</span>
                      <span className="flex items-center gap-2">
                        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{a.decision!.pick}</span>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">conf {a.decision!.confidence}</span>
                      </span>
                    </div>
                    <ul className="mt-1 ml-4 list-disc text-zinc-500 dark:text-zinc-400">
                      {a.decision!.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Slips */}
          <div className="space-y-2">
            {book.slips.map(slip => (
              <SlipRow
                key={slip.slipId}
                slip={slip}
                stake={book.stakePerSlip}
                advisoryByFixture={advByFixture}
                onFlip={fid => edit(b => flipLeg(b, slip.slipId, fid))}
                onRemoveLeg={fid => edit(b => removeLeg(b, slip.slipId, fid))}
                onRemoveSlip={() => edit(b => removeSlip(b, slip.slipId))}
                onDuplicate={() => edit(b => duplicateSlip(b, slip.slipId))}
              />
            ))}
          </div>

          {/* Placement bot */}
          <PlacementPanel book={book} savedBookId={currentId} dirty={dirty} />
        </section>
      )}

      {history.length > 0 && (
        <details className="mt-8 rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            History ({history.length}) — saved books
          </summary>
          <div className="border-t border-zinc-100 dark:border-zinc-800">
            {history.map(h => (
              <button
                key={h.id}
                onClick={() => loadBook(h.id)}
                className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-50 px-4 py-2 text-left text-xs hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/50 ${currentId === h.id ? 'bg-zinc-50 dark:bg-zinc-800/50' : ''}`}
              >
                <span className="font-mono text-zinc-400">{new Date(h.createdAt).toLocaleString()}</span>
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">{h.objective}</span>
                <span className="text-zinc-500">{h.slipCount} slips · L{h.legCount}</span>
                <span className="text-zinc-500">P(any) {pct(h.pAnyHit)}</span>
                {h.guaranteedFloor && <span className="text-green-600 dark:text-green-400">floor ✓</span>}
                {currentId === h.id && <span className="ml-auto text-zinc-400">loaded</span>}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  )
}

const jobBadge: Record<string, string> = {
  queued:    'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  waiting:   'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  placing:   'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  placed:    'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  simulated: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  skipped:   'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  failed:    'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

/**
 * Queue the book's slips to the placement bot and watch the run.
 * Dry-run is the default button; LIVE requires an explicit typed confirmation AND the server's
 * PLACEMENT_LIVE gate + per-book enable. A job is only "placed" once the BOOKMAKER confirmed it
 * (balance moved / bet in history) — the receipt is shown so you can check that yourself.
 */
function PlacementPanel({ book, savedBookId, dirty }: { book: PedlasBook; savedBookId: string | null; dirty: boolean }) {
  const [run, setRun] = useState<PlacementRunView | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [liveAllowed, setLiveAllowed] = useState(false)
  const bookId = book.bookId ?? 'betway_nigeria'

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/config')
        const j = await r.json()
        setLiveAllowed(Boolean(j.placementLive) && Boolean(j.config?.books?.[bookId]?.enabled))
      } catch { /* stays locked */ }
    })()
  }, [bookId])

  // Poll the active run until it finishes.
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/placement?runId=${run.runId}`)
        const j = await r.json()
        if (r.ok && j.run) setRun(j.run)
      } catch { /* poll is best-effort */ }
    }, 1_500)
    return () => clearInterval(t)
  }, [run])

  // SportyBet booking codes — the reliable placement bridge. The bot can't place real SportyBet
  // bets (their automated sessions are SIM-locked), so we hand each slip a code the user opens in
  // their own real-mode browser and taps Place Bet.
  const [codes, setCodes] = useState<Record<number, { code: string; url: string }>>({})
  const [codesBusy, setCodesBusy] = useState(false)
  const isSportybet = bookId === 'sportybet'

  async function getCodes() {
    setCodesBusy(true); setErr(null)
    try {
      const entries = await Promise.all(book.slips.map(async (s) => {
        const r = await fetch('/api/booking-code', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book: 'sportybet', legs: s.legs.map(l => ({ fixtureId: l.fixtureId, line: l.line, side: l.side })) }),
        })
        const j = await r.json()
        return [s.slipId, r.ok ? { code: j.code, url: j.url } : null] as const
      }))
      const map: Record<number, { code: string; url: string }> = {}
      for (const [id, v] of entries) if (v) map[id] = v
      setCodes(map)
      if (Object.keys(map).length === 0) setErr('Could not generate booking codes (SportyBet API).')
    } catch { setErr('Network error getting booking codes.') }
    finally { setCodesBusy(false) }
  }

  async function start(dryRun: boolean) {
    if (!dryRun) {
      const total = book.slips.reduce((s, x) => s + x.stake, 0)
      const answer = window.prompt(
        `REAL MONEY: place ${book.slips.length} slip(s) at ${bookId}, ${naira(total)} total.\n` +
        `Slips are placed one at a time with human-like delays. Type PLACE to confirm.`)
      if (answer !== 'PLACE') return
    }
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/placement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start', bookId, slips: book.slips, dryRun,
          pedlasBookId: dirty ? null : savedBookId,   // link the ledger to the saved book
        }),
      })
      const j = await r.json()
      if (!r.ok) { setErr(j.error || 'Failed to start run'); return }
      setRun({ runId: j.runId, bookId, dryRun, status: 'running', jobs: [], log: [] })
    } catch { setErr('Network error starting the bot.') }
    finally { setBusy(false) }
  }

  async function stop() {
    if (!run) return
    try { await fetch('/api/placement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', runId: run.runId }) }) } catch { /* best-effort */ }
  }

  const placedJobs = run?.jobs.filter(j => j.receipt?.bookingCode) ?? []

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Placement</h3>
        {isSportybet && (
          <button onClick={getCodes} disabled={codesBusy}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
            {codesBusy ? 'Getting codes…' : `🎟 Get booking codes (${book.slips.length})`}
          </button>
        )}
        <button onClick={() => start(true)} disabled={busy || run?.status === 'running'}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
          ▶ Dry-run pacing ({book.slips.length})
        </button>
        {run?.status === 'running' && (
          <button onClick={stop} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-700/60 dark:hover:bg-red-950/40">
            ■ Stop
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {isSportybet ? (
          <>SportyBet automated sessions are locked to SIM (play money), so the bot can&apos;t place real
          bets. Instead, get a <strong>booking code</strong> per slip and open it in your own browser
          (real mode) to place with one tap — then track it under <a href="/placements" className="underline">Placements</a>.</>
        ) : (
          <>Dry-run simulates paced, one-at-a-time placement using the /config pacing rules.</>
        )}
      </p>
      {err && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p>}

      {/* Booking codes — open each in your real-mode browser and tap Place Bet */}
      {Object.keys(codes).length > 0 && (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr><th className="py-1 pr-4">Slip</th><th className="pr-4">Legs</th><th className="pr-4">Stake → win</th><th className="pr-4">Code</th><th>Place</th></tr>
          </thead>
          <tbody>
            {book.slips.filter(s => codes[s.slipId]).map(s => (
              <tr key={s.slipId} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-4 font-medium text-zinc-800 dark:text-zinc-200">#{s.slipId}</td>
                <td className="pr-4 text-zinc-500">{s.legCount} · {s.combinedOdds.toFixed(2)}</td>
                <td className="pr-4 text-zinc-600 dark:text-zinc-400">{naira(s.stake)} → {naira(s.payout)}</td>
                <td className="pr-4">
                  <button onClick={() => navigator.clipboard?.writeText(codes[s.slipId].code)}
                    title="Copy booking code" className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700">
                    {codes[s.slipId].code} ⧉
                  </button>
                </td>
                <td>
                  <a href={codes[s.slipId].url} target="_blank" rel="noreferrer"
                    className="rounded border border-green-300 px-2 py-0.5 font-medium text-green-700 hover:bg-green-50 dark:border-green-700/60 dark:text-green-400 dark:hover:bg-green-950/40">
                    open in SportyBet →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-zinc-500">
            run {run.runId.slice(0, 8)} · {run.dryRun ? 'DRY-RUN' : 'LIVE'} · <strong>{run.status}</strong>
            {' · '}<a href="/placements" className="underline">open the ledger →</a>
          </p>
          {run.jobs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {run.jobs.map(j => (
                <span key={j.slipId} title={j.note ?? `delay ${j.plannedDelaySec}s`}
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${jobBadge[j.status] ?? jobBadge.queued}`}>
                  #{j.slipId} {j.status}
                </span>
              ))}
            </div>
          )}
          {/* Receipts — the bookmaker's own evidence, plus the code to reopen the slip by hand */}
          {placedJobs.length > 0 && (
            <table className="mt-3 w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr><th className="py-1 pr-4">Slip</th><th className="pr-4">Confirmed by</th><th className="pr-4">Booking code</th><th className="pr-4">Bet id</th><th>Balance</th></tr>
              </thead>
              <tbody>
                {placedJobs.map(j => (
                  <tr key={j.slipId} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-4 font-medium text-zinc-800 dark:text-zinc-200">#{j.slipId}</td>
                    <td className={`pr-4 ${j.receipt!.confirmed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {j.receipt!.confirmed ? j.receipt!.confirmedBy : 'NOT confirmed'}
                    </td>
                    <td className="pr-4 font-mono text-zinc-700 dark:text-zinc-300">{j.receipt!.bookingCode ?? '—'}</td>
                    <td className="pr-4 text-zinc-700 dark:text-zinc-300">{j.receipt!.betId ?? '—'}</td>
                    <td className="text-zinc-600 dark:text-zinc-400">
                      {j.receipt!.balanceBefore != null ? `${naira(j.receipt!.balanceBefore)} → ${naira(j.receipt!.balanceAfter ?? 0)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {run.log.length > 0 && (
            <pre className="mt-2 max-h-40 overflow-y-auto rounded bg-zinc-50 p-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
              {run.log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

interface SlipRowProps {
  slip: PedlasSlip
  stake: number
  advisoryByFixture?: Map<number, AxisAdvisory>
  onFlip: (fixtureId: number) => void
  onRemoveLeg: (fixtureId: number) => void
  onRemoveSlip: () => void
  onDuplicate: () => void
}

const leanStyle: Record<string, string> = {
  back: 'text-green-600 dark:text-green-400',
  fade: 'text-red-600 dark:text-red-400',
  neutral: 'text-zinc-400',
}

function SlipRow({ slip, stake, advisoryByFixture, onFlip, onRemoveLeg, onRemoveSlip, onDuplicate }: SlipRowProps) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn() }
  return (
    <details className="group rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-sm">
        <span className="font-bold text-zinc-900 dark:text-zinc-100">#{slip.slipId}</span>
        <span className="text-zinc-500">{slip.legs.filter(l => l.side === 'Over').length} Over · {slip.legCount} legs</span>
        <span className="text-zinc-700 dark:text-zinc-300">odds <strong>{slip.combinedOdds.toFixed(1)}</strong></span>
        <span className="text-green-700 dark:text-green-400">
          win <strong>{naira(slip.payout)}</strong>{slip.capped && <span className="ml-1 rounded bg-amber-200 px-1 text-xs text-amber-900">capped</span>}
        </span>
        <span className="text-zinc-500">hit {pct(slip.trueProb, 3)}</span>
        <span className="text-red-600 dark:text-red-400">EV {slip.evMultiple.toFixed(3)}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">score {slip.rankScore}</span>
          <button onClick={stop(onDuplicate)} title="Duplicate slip" className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">⧉</button>
          <button onClick={stop(onRemoveSlip)} title="Remove slip" className="rounded border border-red-300 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-700/60 dark:hover:bg-red-950/40">✕</button>
        </span>
      </summary>
      <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
        {(slip.reasoning || slip.hiddenRisk) && (
          <div className="mb-3 space-y-1 text-xs">
            {slip.reasoning && <p className="text-zinc-600 dark:text-zinc-400"><strong>NIM:</strong> {slip.reasoning}</p>}
            {slip.hiddenRisk && <p className="text-amber-700 dark:text-amber-400"><strong>Risk:</strong> {slip.hiddenRisk}</p>}
          </div>
        )}
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr><th className="py-1 pr-4">Kickoff</th><th className="py-1 pr-4">Match</th><th className="pr-4">League</th><th className="pr-4">Pick</th><th className="pr-4">Odds</th><th className="pr-4">Model</th><th>Edit</th></tr>
          </thead>
          <tbody>
            {slip.legs.map((l, i) => {
              const adv = advisoryByFixture?.get(l.fixtureId)
              return (
              <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-4 text-zinc-500">{kickoffTime(l.kickoff)}</td>
                <td className="py-1 pr-4 text-zinc-800 dark:text-zinc-200">{l.game}</td>
                <td className="pr-4 text-zinc-500">{l.league}</td>
                <td className={`pr-4 font-medium ${l.side === 'Over' ? 'text-orange-600 dark:text-orange-400' : 'text-zinc-700 dark:text-zinc-300'}`}>{l.outcome}</td>
                <td className="pr-4 text-zinc-700 dark:text-zinc-300">{l.odds.toFixed(2)}</td>
                <td className="pr-4 whitespace-nowrap" title={adv ? `${adv.note} · advisory only (no edge)` : 'no history'}>
                  {adv ? <span className={leanStyle[adv.lean]}>{adv.lean} {adv.edge.toFixed(2)}</span> : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="whitespace-nowrap">
                  <button onClick={() => onFlip(l.fixtureId)} title="Flip Under/Over" className="mr-1 rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">⇄ {l.side === 'Over' ? 'Under' : 'Over'}</button>
                  <button onClick={() => onRemoveLeg(l.fixtureId)} title="Remove leg" className="rounded border border-red-300 px-1.5 py-0.5 text-red-600 hover:bg-red-50 dark:border-red-700/60 dark:hover:bg-red-950/40">remove</button>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-400">Stake {naira(stake)} · all-or-nothing (every leg must land).</p>
      </div>
    </details>
  )
}
