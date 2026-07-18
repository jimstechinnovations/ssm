'use client'

/**
 * app/placements/page.tsx — the money ledger.
 *
 * What actually got placed (as the BOOKMAKER confirmed it), with the booking code and bet id
 * that tie our engine to the book, per-leg live progress against real scores, auto-settlement,
 * and manual override when the book disagrees with us. This is the "see the result, plan the
 * next one" half of the loop.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Spinner, Refresh } from '@/components/Icons'

interface Leg {
  fixtureId: number; game: string; league: string; kickoff: string
  line: number; side: 'Under' | 'Over'; outcome: string; odds: number
}
interface Placement {
  id: string; runId: string; bookId: string; slipId: number; dryRun: boolean
  stake: number; combinedOdds: number; potentialPayout: number | null
  legCount: number; legs: Leg[]; trueProb: number | null
  status: 'placed' | 'failed' | 'simulated' | 'skipped'
  confirmedBy: string | null; bookingCode: string | null; betId: string | null
  siteOdds: number | null; balanceBefore: number | null; balanceAfter: number | null
  failureReason: string | null
  settled: boolean; settledBy: string | null; won: boolean | null; returned: number | null
  legResults: { fixtureId: number; game: string; outcome: string; totalGoals: number | null; hit: boolean | null }[] | null
  notes: string | null; placedAt: string; createdAt: string
}
interface Summary {
  placed: number; settled: number; won: number; lost: number
  staked: number; returned: number; net: number; openStake: number
}
interface Grade {
  complete: boolean; won: boolean | null; finishedLegs: number; totalLegs: number
  legResults: { fixtureId: number; game: string; outcome: string; totalGoals: number | null; hit: boolean | null }[]
}

const naira = (x: number) => '₦' + Math.round(x).toLocaleString('en-US')
const when = (iso: string) => new Date(iso).toLocaleString()

const PAGE_SIZE = 25

export default function PlacementsPage() {
  const [rows, setRows] = useState<Placement[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [includeDry, setIncludeDry] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [grades, setGrades] = useState<Record<string, Grade>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (includeDry) qs.set('includeDryRun', '1')
      if (search.trim()) qs.set('search', search.trim())
      const r = await fetch(`/api/placements?${qs}`)
      const j = await r.json()
      setRows(j.placements ?? [])
      setTotal(j.total ?? (j.placements?.length ?? 0))
      setSummary(j.summary ?? null)
    } catch { setMsg('Could not load the ledger.') }
    finally { setLoading(false) }
  }, [includeDry, offset, search])

  // reset to first page when the filter/search changes
  useEffect(() => { setOffset(0) }, [includeDry, search])
  // debounce loads (search typing)
  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t) }, [load, search])

  async function autoSettle() {
    setBusy('settle'); setMsg(null)
    try {
      const r = await fetch('/api/placements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settle' }),
      })
      const j = await r.json()
      if (!r.ok) { setMsg(j.error ?? 'Auto-settle failed'); return }
      setMsg(`Auto-settled ${j.settled} slip(s)${j.pending?.length ? `; ${j.pending.length} still in play` : ''}.`)
      await load()
    } catch { setMsg('Network error during auto-settle.') }
    finally { setBusy(null) }
  }

  async function grade(id: string) {
    setBusy(id)
    try {
      const r = await fetch('/api/placements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grade', id }),
      })
      const j = await r.json()
      if (r.ok && j.grade) setGrades(g => ({ ...g, [id]: j.grade }))
    } catch { /* best-effort */ }
    finally { setBusy(null) }
  }

  async function manualSettle(id: string, won: boolean, potential: number | null) {
    const returned = won ? Number(prompt('Amount actually returned (₦):', String(Math.round(potential ?? 0))) ?? 0) : 0
    if (won && !Number.isFinite(returned)) return
    setBusy(id)
    try {
      const r = await fetch('/api/placements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settle', id, won, returned, notes: 'manual entry' }),
      })
      const j = await r.json()
      setMsg(r.ok ? 'Settled manually.' : (j.error ?? 'Manual settle failed'))
      await load()
    } catch { setMsg('Network error.') }
    finally { setBusy(null) }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Reports &amp; Results</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            What the <strong>bookmaker</strong> confirmed — not what the bot hoped. Every real slip carries its
            booking code (reopen the identical slip at the book) and settles against actual scores.
          </p>
        </div>
        <button onClick={autoSettle} disabled={busy === 'settle'}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {busy === 'settle' ? <Spinner className="h-4 w-4" /> : <Refresh className="h-4 w-4" />}{busy === 'settle' ? 'Settling…' : 'Auto-settle from results'}
        </button>
      </header>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Real slips placed" value={String(summary.placed)} />
          <Stat label="Settled" value={`${summary.settled} (${summary.won}W/${summary.lost}L)`} />
          <Stat label="Staked" value={naira(summary.staked)} />
          <Stat label="Returned" value={naira(summary.returned)} />
          <Stat label="Net" value={naira(summary.net)} tone={summary.net >= 0 ? 'good' : 'bad'} />
          <Stat label="Still in play" value={naira(summary.openStake)} />
          <Stat label="Hit rate" value={summary.settled ? `${Math.round((summary.won / summary.settled) * 100)}%` : '—'} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <input
          type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search booking code, slip #, or book…"
          className="w-64 max-w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200" />
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={includeDry} onChange={e => setIncludeDry(e.target.checked)} />
          include dry-run simulations
        </label>
        {loading && <Spinner className="h-4 w-4 text-zinc-400" />}
        <span className="text-zinc-500">{total} record{total === 1 ? '' : 's'}</span>
        {msg && <span className="text-zinc-600 dark:text-zinc-300">{msg}</span>}
      </div>

      {loading && rows.length === 0 && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-10 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          <Spinner className="h-4 w-4" /> Loading the ledger…
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          {search.trim() ? `No placements match “${search.trim()}”.` : <>No placements yet. Build a book, then place from a session.<br /><span className="text-xs">(If you expected rows here, apply <code>supabase/migrations/005_placements.sql</code>.)</span></>}
        </p>
      )}

      <div className={`space-y-2 ${loading ? 'opacity-60' : ''}`}>
        {rows.map(p => {
          const g = grades[p.id]
          const legResults = p.legResults ?? g?.legResults ?? null
          return (
            <details key={p.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <StatusPill status={p.status} settled={p.settled} won={p.won} dryRun={p.dryRun} />
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{p.bookId}</span>
                <span className="text-zinc-500">#{p.slipId} · {p.legCount} legs</span>
                <span className="text-zinc-700 dark:text-zinc-300">{naira(p.stake)} @ {p.combinedOdds.toFixed(2)}</span>
                <span className="text-green-700 dark:text-green-400">→ {naira(p.potentialPayout ?? 0)}</span>
                {p.bookingCode && (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    title="Paste this at the bookmaker to reopen the identical slip">
                    {p.bookingCode}
                  </span>
                )}
                {p.settled && p.won !== null && (
                  <span className={p.won ? 'font-semibold text-green-600 dark:text-green-400' : 'font-semibold text-red-600 dark:text-red-400'}>
                    {p.won ? `WON ${naira(p.returned ?? 0)}` : 'LOST'}
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-400">{when(p.placedAt ?? p.createdAt)}</span>
              </summary>

              <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
                {/* Confirmation evidence — the anti-false-positive record */}
                <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                  <span>confirmed by: <strong className="text-zinc-700 dark:text-zinc-300">{p.confirmedBy ?? '—'}</strong></span>
                  {p.betId && <span>bet id: <strong className="text-zinc-700 dark:text-zinc-300">{p.betId}</strong></span>}
                  {p.siteOdds != null && <span>site odds: {p.siteOdds.toFixed(2)}</span>}
                  {p.balanceBefore != null && (
                    <span>balance: {naira(p.balanceBefore)} → {naira(p.balanceAfter ?? 0)}</span>
                  )}
                  {p.trueProb != null && <span>modelled hit: {(p.trueProb * 100).toFixed(2)}%</span>}
                </div>

                {p.failureReason && (
                  <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
                    <strong>Not placed:</strong> {p.failureReason}
                  </p>
                )}

                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="py-1 pr-4">Match</th><th className="pr-4">Pick</th>
                      <th className="pr-4">Odds</th><th className="pr-4">Goals</th><th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.legs.map((l, i) => {
                      const lr = legResults?.find(r => r.fixtureId === l.fixtureId)
                      return (
                        <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-1 pr-4 text-zinc-800 dark:text-zinc-200">{l.game}</td>
                          <td className={`pr-4 font-medium ${l.side === 'Over' ? 'text-orange-600 dark:text-orange-400' : 'text-zinc-700 dark:text-zinc-300'}`}>{l.outcome}</td>
                          <td className="pr-4 text-zinc-600 dark:text-zinc-400">{l.odds.toFixed(2)}</td>
                          <td className="pr-4 text-zinc-600 dark:text-zinc-400">{lr?.totalGoals ?? '—'}</td>
                          <td>
                            {lr?.hit === true && <span className="text-green-600 dark:text-green-400">✓ hit</span>}
                            {lr?.hit === false && <span className="text-red-600 dark:text-red-400">✗ miss</span>}
                            {(!lr || lr.hit === null) && <span className="text-zinc-400">in play</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {g && !p.settled && (
                  <p className="mt-2 text-xs text-zinc-500">
                    {g.finishedLegs}/{g.totalLegs} legs finished
                    {g.won === false && <strong className="ml-1 text-red-600 dark:text-red-400"> — slip already dead (a leg missed)</strong>}
                    {g.won === true && <strong className="ml-1 text-green-600 dark:text-green-400"> — all legs landed</strong>}
                  </p>
                )}

                {p.status === 'placed' && !p.settled && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <button onClick={() => grade(p.id)} disabled={busy === p.id}
                      className="rounded border border-zinc-300 px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
                      {busy === p.id ? 'checking…' : 'Check results'}
                    </button>
                    <span className="text-zinc-400">or settle by hand if the book disagrees:</span>
                    <button onClick={() => manualSettle(p.id, true, p.potentialPayout)}
                      className="rounded border border-green-300 px-2 py-1 font-medium text-green-700 hover:bg-green-50 dark:border-green-700/60 dark:text-green-400 dark:hover:bg-green-950/40">
                      mark won
                    </button>
                    <button onClick={() => manualSettle(p.id, false, null)}
                      className="rounded border border-red-300 px-2 py-1 font-medium text-red-600 hover:bg-red-50 dark:border-red-700/60 dark:hover:bg-red-950/40">
                      mark lost
                    </button>
                  </div>
                )}
                {p.settled && (
                  <p className="mt-2 text-xs text-zinc-500">
                    settled {p.settledBy === 'manual' ? 'by hand' : 'automatically from results'}
                    {p.notes ? ` · ${p.notes}` : ''}
                  </p>
                )}
              </div>
            </details>
          )
        })}
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-zinc-500">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0 || loading}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Prev</button>
            <button onClick={() => setOffset(o => o + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-green-600 dark:text-green-400'
    : tone === 'bad' ? 'text-red-600 dark:text-red-400'
    : 'text-zinc-900 dark:text-zinc-100'
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  )
}

function StatusPill({ status, settled, won, dryRun }: { status: string; settled: boolean; won: boolean | null; dryRun: boolean }) {
  const [text, cls] =
    dryRun ? ['dry-run', 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300']
    : status === 'failed' ? ['not placed', 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300']
    : settled && won ? ['won', 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300']
    : settled ? ['lost', 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400']
    : ['placed · in play', 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300']
  return <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>{text}</span>
}
