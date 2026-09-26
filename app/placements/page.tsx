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
import { Page, PageHeader, Stat as UiStat, Button, Banner, Badge, StatusBadge, Empty, inputCls, cx } from '@/components/ui'

interface Leg {
  fixtureId: number; game: string; league: string; kickoff: string
  line: number; side: 'Under' | 'Over'; outcome: string; odds: number
}
interface Placement {
  id: string; runId: string; bookId: string; slipId: number; dryRun: boolean
  stake: number; combinedOdds: number; potentialPayout: number | null
  legCount: number; legs: (Leg & { suspended?: boolean })[]; trueProb: number | null
  status: string
  confirmedBy: string | null; bookingCode: string | null; betId: string | null
  siteOdds: number | null; siteStake: number | null; sitePayout: number | null; balanceBefore: number | null; balanceAfter: number | null
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

const naira = (x?: number | null) => x == null ? '—' : '₦' + Math.round(x).toLocaleString('en-US')
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
    <Page wide>
      <PageHeader title="Results"
        subtitle={<>Every real slip, as the <strong>bookmaker</strong> confirmed it — with its booking code, the amounts the site accepted, and the final scores.</>}
        actions={<Button variant="primary" onClick={autoSettle} loading={busy === 'settle'} icon={<Refresh className="h-4 w-4" />}>Settle finished games</Button>} />

      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <UiStat label="Slips placed" value={summary.placed.toLocaleString()} />
          <UiStat label="Settled" value={`${summary.won} won · ${summary.lost} lost`} hint={`${summary.settled} of ${summary.placed}`} />
          <UiStat label="Staked" value={naira(summary.staked)} />
          <UiStat label="Returned" value={naira(summary.returned)} />
          <UiStat label="Net (settled)" value={naira(summary.net)} tone={summary.net > 0 ? 'pos' : summary.net < 0 ? 'neg' : undefined} />
          <UiStat label="Still in play" value={naira(summary.openStake)} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <input type="search" value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }} placeholder="Booking code, slip # or book…" className={cx(inputCls, 'w-72 max-w-full')} />
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={includeDry} onChange={e => { setIncludeDry(e.target.checked); setOffset(0) }} /> include dry runs
        </label>
        {loading && <Spinner className="h-4 w-4 text-zinc-400" />}
        <span className="ml-auto text-xs text-zinc-500">{total.toLocaleString()} record{total === 1 ? '' : 's'}</span>
      </div>
      {msg && <div className="mb-4"><Banner tone="muted">{msg}</Banner></div>}

      {!loading && rows.length === 0 && (
        <Empty title={search.trim() ? `Nothing matches “${search.trim()}”` : 'No real slips placed yet'}>
          {search.trim() ? undefined : 'Build a session and place it — every confirmed slip lands here.'}
        </Empty>
      )}

      <div className={cx('space-y-2', loading && 'opacity-60')}>
        {rows.map(p => {
          const g = grades[p.id]
          const legResults = p.legResults ?? g?.legResults ?? null
          const pays = p.sitePayout ?? p.potentialPayout
          const st = p.dryRun ? 'dry' : p.status === 'failed' ? 'failed' : p.settled ? (p.won ? 'won' : 'lost') : p.status
          return (
            <details key={p.id} className="group rounded-2xl border border-zinc-200 bg-white open:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3.5 text-sm">
                {st === 'dry' ? <Badge>Dry run</Badge> : <StatusBadge status={st} />}
                <span className="font-mono text-xs text-zinc-500">#{p.slipId}</span>
                <span className="text-zinc-600 dark:text-zinc-400">{p.legs.filter(l => !l.suspended).length} legs · {naira(p.siteStake ?? p.stake)} @ {(p.siteOdds ?? p.combinedOdds).toFixed(2)}</span>
                <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">pays {naira(pays)}{p.sitePayout != null && <span className="ml-1 text-[10px] font-medium uppercase text-emerald-600">site</span>}</span>
                {p.bookingCode && <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" title="Paste at the bookmaker to reopen this exact slip">{p.bookingCode}</span>}
                {p.settled && p.won && <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{naira(p.returned ?? 0)}</span>}
                <span className="ml-auto text-xs text-zinc-400">{p.bookId} · {when(p.placedAt ?? p.createdAt)}</span>
              </summary>

              <div className="border-t border-zinc-100 px-5 py-4 dark:border-zinc-800">
                <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                  <span>confirmed by <strong className="text-zinc-700 dark:text-zinc-300">{p.confirmedBy ?? '—'}</strong></span>
                  {p.betId && <span>bet id <strong className="text-zinc-700 dark:text-zinc-300">{p.betId}</strong></span>}
                  {p.sitePayout != null && p.potentialPayout != null && Math.abs(p.sitePayout - p.potentialPayout) > 1 && <span>built payout was {naira(p.potentialPayout)}</span>}
                  {p.balanceBefore != null && <span>balance {naira(p.balanceBefore)} → {naira(p.balanceAfter ?? 0)}</span>}
                </div>
                {p.failureReason && <div className="mb-3"><Banner tone="error" title="Not placed">{p.failureReason}</Banner></div>}

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-xs">
                    <thead className="text-zinc-500"><tr><th className="py-1.5 pr-4 font-medium">Match</th><th className="pr-4 font-medium">Pick</th><th className="pr-4 font-medium">Odds</th><th className="pr-4 font-medium">Goals</th><th className="font-medium">Result</th></tr></thead>
                    <tbody>
                      {p.legs.map((l, i) => {
                        const lr = legResults?.find(r => r.fixtureId === l.fixtureId)
                        return (
                          <tr key={i} className={cx('border-t border-zinc-100 dark:border-zinc-800', l.suspended && 'opacity-50')}>
                            <td className={cx('py-1.5 pr-4 text-zinc-800 dark:text-zinc-200', l.suspended && 'line-through')}>{l.game}</td>
                            <td className="pr-4 font-medium text-zinc-700 dark:text-zinc-300">{l.outcome}</td>
                            <td className="pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">{l.odds.toFixed(2)}</td>
                            <td className="pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">{lr?.totalGoals ?? '—'}</td>
                            <td>
                              {l.suspended ? <span className="text-amber-600">dropped (suspended)</span>
                                : lr?.hit === true ? <span className="text-emerald-600 dark:text-emerald-400">✓ landed</span>
                                  : lr?.hit === false ? <span className="text-red-600 dark:text-red-400">✗ missed</span>
                                    : <span className="text-zinc-400">not finished</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {g && !p.settled && (
                  <p className="mt-2 text-xs text-zinc-500">{g.finishedLegs}/{g.totalLegs} legs finished
                    {g.won === false && <strong className="ml-1 text-red-600 dark:text-red-400"> — already lost (a leg missed)</strong>}
                    {g.won === true && <strong className="ml-1 text-emerald-600 dark:text-emerald-400"> — every leg landed</strong>}
                  </p>
                )}
                {p.status === 'placed' && !p.settled && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <Button size="sm" onClick={() => grade(p.id)} loading={busy === p.id}>Check this slip</Button>
                    <span className="text-zinc-400">If SportyBet disagrees, settle by hand:</span>
                    <Button size="sm" onClick={() => manualSettle(p.id, true, pays)}>Mark won</Button>
                    <Button size="sm" onClick={() => manualSettle(p.id, false, null)}>Mark lost</Button>
                  </div>
                )}
                {p.settled && <p className="mt-2 text-xs text-zinc-500">Settled {p.settledBy === 'manual' ? 'by hand' : 'automatically from final scores'}{p.notes ? ` · ${p.notes}` : ''}</p>}
              </div>
            </details>
          )
        })}
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <Button size="sm" onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0 || loading}>← Prev</Button>
          <span className="text-xs text-zinc-500">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
          <Button size="sm" onClick={() => setOffset(o => o + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>Next →</Button>
        </div>
      )}
    </Page>
  )
}
