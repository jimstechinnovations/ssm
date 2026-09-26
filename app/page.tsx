'use client'

/**
 * app/page.tsx — Sessions (home). Every build+place run in one list, newest first, with where each
 * one stands and the money it has actually moved. Net counts SETTLED slips only — an open stake is not
 * a loss yet, so a session that is still playing never shows a fake deficit.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Plus } from '@/components/Icons'
import { Page, PageHeader, Stat, Card, Empty, LinkButton, StatusBadge, Progress, Badge, naira, pct, ago } from '@/components/ui'

interface Summary { slips: number; pending: number; placed: number; failed: number; skipped: number; won: number; lost: number; open: number; staked: number; settledStaked: number; returned: number; net: number }
interface Session {
  code: string; status: string; budget: number; targetWin: number; legCount: number | null; slipCount: number | null
  poolSize: number | null; createdAt: string; updatedAt: string; bookIds: string[]; dateFrom: string; dateTo: string
  heartbeatAgeMs: number; ageMs: number; expired: boolean
  meta?: { pAnyWin?: number; stopRequested?: boolean; bookMetas?: Record<string, { keepRate?: number; variableLegs?: { min: number; max: number } }> } | null
  summary: Summary
}

/** Where a session stands, derived from its slips (not a stale status flag). */
function stage(s: Session): string {
  const sm = s.summary
  if (s.status === 'failed') return 'failed'
  const fresh = s.heartbeatAgeMs < 25_000
  if (s.status === 'placing' && sm.pending > 0 && fresh && !s.meta?.stopRequested) return 'running'
  if (sm.placed === 0) return s.expired ? 'expired' : 'ready'
  if (sm.pending > 0) return 'stopped'
  if (sm.open > 0) return 'placed'
  return sm.won > 0 ? 'won' : 'done'
}

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [totals, setTotals] = useState<{ placed: number; staked: number; returned: number; net: number; openStake: number } | null>(null)
  const [showStale, setShowStale] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(false)

  // state is only ever set inside promise callbacks (never synchronously in an effect)
  const load = useCallback(() => fetch('/api/sessions').then(r => r.json())
    .then(j => { setSessions(j.sessions ?? []); setTotals(j.totals ?? null); setErr(false) })
    .catch(() => setErr(true))
    .finally(() => setLoading(false)), [])
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])

  // Totals come from the server ledger (EVERY real slip) — identical to the Results page.
  const tot = { placed: totals?.placed ?? 0, staked: totals?.staked ?? 0, returned: totals?.returned ?? 0, net: totals?.net ?? 0, open: totals?.openStake ?? 0 }
  // Sessions built but never placed, older than a day: their games have kicked off, so they can't be
  // placed any more — fold them away so the live and placed sessions are what you see.
  const isStale = (s: Session) => s.summary.placed === 0 && s.ageMs > 864e5
  const visible = sessions.filter(s => !isStale(s))
  const stale = sessions.filter(isStale)

  return (
    <Page>
      <PageHeader title="Sessions"
        subtitle="Each session spreads a budget across many slips so that at least one may land the target. Every slip is priced by the bookmaker — the numbers here are honest, not a promise."
        actions={<LinkButton href="/bet-manager" variant="primary"><Plus className="h-4 w-4" /> New session</LinkButton>} />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Slips placed (real)" value={tot.placed.toLocaleString()} />
        <Stat label="Total staked" value={naira(tot.staked)} hint={tot.open > 0 ? `${naira(tot.open)} still in play` : 'all settled'} />
        <Stat label="Returned" value={naira(tot.returned)} />
        <Stat label="Net (settled only)" value={naira(tot.net)} tone={tot.net > 0 ? 'pos' : tot.net < 0 ? 'neg' : undefined} />
      </div>

      {loading && <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />)}</div>}
      {!loading && err && <Empty title="Can't reach the database">The app couldn&apos;t load sessions. If the Supabase project is paused, restore it from the Supabase dashboard, then refresh.</Empty>}
      {!loading && !err && sessions.length === 0 && (
        <Empty title="No sessions yet" action={<LinkButton href="/bet-manager" variant="primary">Build your first session</LinkButton>}>
          Pick a budget and a target — the builder works out the slips, you review the honest odds, then place.
        </Empty>
      )}

      <div className="space-y-3">
        {[...visible, ...(showStale ? stale : [])].map(s => {
          const sm = s.summary
          const total = Math.max(1, s.slipCount ?? sm.slips)
          const st = stage(s)
          const keep = s.meta?.bookMetas ? Object.values(s.meta.bookMetas).find(m => m.keepRate != null)?.keepRate : undefined
          return (
            <a key={s.code} href={`/sessions/${s.code}`}
              className="block rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 hover:shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{s.code}</span>
                <StatusBadge status={st} />
                <span className="text-xs text-zinc-400">{s.bookIds.join(', ')} · {ago(s.createdAt)}</span>
                <span className="ml-auto text-sm font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{naira(s.budget)} <span className="text-zinc-400">→</span> {naira(s.targetWin)}</span>
              </div>
              <div className="mt-3"><Progress total={total} parts={[
                { value: sm.won, className: 'bg-emerald-500', label: 'won' },
                { value: sm.placed - sm.won, className: 'bg-sky-500', label: 'placed' },
                { value: sm.failed, className: 'bg-red-400', label: 'failed' },
                { value: sm.skipped, className: 'bg-zinc-300 dark:bg-zinc-600', label: 'skipped' },
              ]} /></div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span><strong className="text-zinc-800 dark:text-zinc-200">{sm.placed}</strong>/{total} placed</span>
                {sm.pending > 0 && <span>{sm.pending} pending</span>}
                {sm.failed > 0 && <span className="text-red-600 dark:text-red-400">{sm.failed} failed</span>}
                {s.meta?.pAnyWin != null && <span>win chance <strong className="text-zinc-800 dark:text-zinc-200">{pct(s.meta.pAnyWin)}</strong></span>}
                {keep != null && <span>returns ~₦{Math.round(keep * 100)} per ₦100 staked (avg)</span>}
                {sm.placed > 0 && <span>staked {naira(sm.staked)}</span>}
                {(sm.won + sm.lost) > 0 && <span>net <strong className={sm.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{naira(sm.net)}</strong></span>}
                {sm.won > 0 && <Badge tone="green">{sm.won} winning slip{sm.won === 1 ? '' : 's'}</Badge>}
              </div>
            </a>
          )
        })}
      </div>

      {stale.length > 0 && (
        <button onClick={() => setShowStale(v => !v)} className="mt-4 w-full rounded-xl border border-dashed border-zinc-300 px-4 py-3 text-sm text-zinc-500 hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:hover:text-zinc-200">
          {showStale ? 'Hide' : 'Show'} {stale.length} older session{stale.length === 1 ? '' : 's'} that were built but never placed
        </button>
      )}

      {sessions.length > 0 && (
        <Card className="mt-8" title="How to read this">
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li><strong>Win chance</strong> is the modelled chance that at least one slip in the session lands — for these exact slips.</li>
            <li><strong>Returns per ₦100</strong> is the bookmaker&apos;s price: on average every ₦100 staked comes back as less than ₦100. No mix of slips changes that.</li>
            <li><strong>Net</strong> only counts settled slips. Money on games still being played isn&apos;t counted as lost until they finish.</li>
          </ul>
        </Card>
      )}
    </Page>
  )
}
