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

import React, { useState } from 'react'
import type { PedlasBook, PedlasSlip } from '@/lib/pedlas/types'

interface PedlasResponse {
  book: PedlasBook
  meta: {
    scanned: number
    fixturesFound: number
    qualifyingAxes: number
    usedAxes: number
    minKickoffGapMinutes?: number
  }
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

export default function PedlasPage() {
  const [dateFrom, setDateFrom] = useState(todayPlus(0))
  const [dateTo, setDateTo] = useState(todayPlus(2))
  const [budget, setBudget] = useState(1000)
  const [legCount, setLegCount] = useState(11)
  const [minAnchorDistance, setMinAnchor] = useState(3)
  const [minSlipSeparation, setMinSep] = useState(4)
  const [maxPerLeague, setMaxPerLeague] = useState(3)
  const [minKickoffGapMinutes, setMinKickoffGapMinutes] = useState(60)

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PedlasResponse | null>(null)

  async function build() {
    setStatus('loading'); setError(null); setData(null)
    try {
      const res = await fetch('/api/pedlas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookmaker: 'betway_nigeria',
          date_from: dateFrom, date_to: dateTo,
          budget, legCount, minKickoffGapMinutes,
          params: { minAnchorDistance, minSlipSeparation, maxPerLeague },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.detail || json.error || `Request failed (HTTP ${res.status})`)
        setStatus('error'); return
      }
      setData(json); setStatus('done')
    } catch {
      setError('Network error — please retry.'); setStatus('error')
    }
  }

  const book = data?.book

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
            onClick={build}
            disabled={status === 'loading'}
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {status === 'loading' ? 'Building…' : 'Build slips'}
          </button>
        </div>
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
          {/* Book summary */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="Slips placed" value={`${book.slips.length} / ${book.K}`} />
            <Stat label="Legs (L)" value={String(book.legCount)} />
            <Stat label="Win Boost" value={`+${book.slips[0]?.boostPct ?? 0}%`} />
            <Stat label="Compression" value={`${Math.round(book.compressionRatio)}×`} />
            <Stat label="P(any hit)" value={pct(book.meta.pAnyHit)} />
            <Stat label="Ranked by" value={book.meta.ranked === 'nim' ? 'NIM' : 'deterministic'} />
            <Stat label="Kickoff gap" value={`${data.meta.minKickoffGapMinutes ?? minKickoffGapMinutes} min`} />
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
          </div>

          {/* Slips */}
          <div className="space-y-2">
            {book.slips.map(slip => <SlipRow key={slip.slipId} slip={slip} stake={book.stakePerSlip} />)}
          </div>
        </section>
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

function SlipRow({ slip, stake }: { slip: PedlasSlip; stake: number }) {
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
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">score {slip.rankScore}</span>
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
            <tr><th className="py-1 pr-4">Kickoff</th><th className="py-1 pr-4">Match</th><th className="pr-4">League</th><th className="pr-4">Pick</th><th>Odds</th></tr>
          </thead>
          <tbody>
            {slip.legs.map((l, i) => (
              <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-4 text-zinc-500">{kickoffTime(l.kickoff)}</td>
                <td className="py-1 pr-4 text-zinc-800 dark:text-zinc-200">{l.game}</td>
                <td className="pr-4 text-zinc-500">{l.league}</td>
                <td className={`pr-4 font-medium ${l.side === 'Over' ? 'text-orange-600 dark:text-orange-400' : 'text-zinc-700 dark:text-zinc-300'}`}>{l.outcome}</td>
                <td className="text-zinc-700 dark:text-zinc-300">{l.odds.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-400">Stake {naira(stake)} · all-or-nothing (every leg must land).</p>
      </div>
    </details>
  )
}
