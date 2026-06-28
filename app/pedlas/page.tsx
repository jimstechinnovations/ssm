'use client'

/**
 * app/pedlas/page.tsx
 *
 * PEDLAS odds builder — total-goals Under/Over coverage for a small stake.
 * Self-contained client page: form → POST /api/pedlas → render the PedlasBook.
 *
 * HONESTY (non-negotiable UI): this is a structured −vig lottery. The page shows
 * P(any hit), per-slip all-or-nothing reality, and never advertises +EV from
 * structure or the Win Boost. See pedlas_v1.md §5.
 */

import React, { useState, useEffect, useRef } from 'react'
import type { PedlasBook, PedlasSlip, AxisAdvisory } from '@/lib/pedlas/types'
import { flipLeg, removeLeg, removeSlip, duplicateSlip } from '@/lib/pedlas/edit'

interface PedlasResponse {
  book: PedlasBook
  meta: {
    scanned: number
    fixturesFound: number
    qualifyingAxes: number
    usedAxes: number
    minKickoffGapMinutes?: number
    advisory?: { withForm: number; total: number }
  }
  bookId?: string | null
  saved?: boolean
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
  const [dateTo, setDateTo] = useState(todayPlus(2))
  const [budget, setBudget] = useState(1000)
  const [legCount, setLegCount] = useState(7)
  const [minAnchorDistance, setMinAnchor] = useState(1)
  const [minSlipSeparation, setMinSep] = useState(4)
  const [maxPerLeague, setMaxPerLeague] = useState(3)
  const [minKickoffGapMinutes, setMinKickoffGapMinutes] = useState(60)

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PedlasResponse | null>(null)
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
      setData({ book: j.book, meta: j.meta }); setCurrentId(id); setSaved(true); setStatus('done')
    } catch { setError('Network error loading book.'); setStatus('error') }
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
          bookmaker: 'betway_nigeria',
          date_from: dateFrom, date_to: dateTo,
          budget, legCount, minKickoffGapMinutes, objective, save,
          params: { minAnchorDistance, minSlipSeparation, maxPerLeague },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.detail || json.error || `Request failed (HTTP ${res.status})`)
        setStatus('error'); setAutoRefresh(false); return  // stop auto-refresh on error (backoff)
      }
      setData(json); setStatus('done'); setLastRefresh(new Date())
      setSaved(json.saved ?? null); setCurrentId(json.bookId ?? null)
      if (save) loadHistory()
    } catch {
      setError('Network error — please retry.'); setStatus('error'); setAutoRefresh(false)
    }
  }

  // Restore the latest saved book on mount (survives refresh) + load history.
  useEffect(() => {
    (async () => {
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">PEDLAS Odds Builder</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Total-goals Under/Over coverage (Under ≥ 1.20, Win-Boost eligible). A small stake spread
          across diversified high-payout slips.
        </p>
      </header>

      {/* Honest disclosure — always visible */}
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Reality check:</strong> this is a <strong>structured −vig lottery</strong>. PEDLAS
        diversifies your stake across plausible high-payout slips — it does <strong>not</strong> beat
        the bookmaker margin or create edge, and the Win Boost is a subsidy, not edge. Each slip is
        all-or-nothing, and the chance any slip hits is small.
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
        <Field label="Slip separation (S)"><input type="number" min={1} max={legCount} value={minSlipSeparation} onChange={e => setMinSep(+e.target.value)} className={inputCls} /></Field>
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
