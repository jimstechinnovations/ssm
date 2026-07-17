'use client'

/**
 * app/page.tsx — Dashboard. First screen: overview of recent sessions + the entry to build a new one.
 * Everything is server-backed (sessions API); this is the view/control surface.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Spinner, Dot, Plus } from '@/components/Icons'

interface Summary { slips: number; pending: number; placed: number; failed: number; won: number; lost: number; staked: number; returned: number; net: number }
interface Session {
  code: string; status: string; budget: number; targetWin: number; legCount: number | null; slipCount: number | null
  poolSize: number | null; createdAt: string; bookIds: string[]; meta?: { pAnyWin?: number } | null; summary: Summary
}

const naira = (n: number) => '₦' + Math.round(n).toLocaleString()
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago` }

const STATUS_CLS: Record<string, string> = {
  building: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  placing: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  done: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  stopped: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try { const j = await (await fetch('/api/sessions')).json(); setSessions(j.sessions ?? []) } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const tot = sessions.reduce((a, s) => ({ staked: a.staked + s.summary.staked, returned: a.returned + s.summary.returned, placed: a.placed + s.summary.placed }), { staked: 0, returned: 0, placed: 0 })

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Total-goals coverage — scatter a budget across many slips so at least one may land. Honest EV, no edge claims.</p>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Kpi label="Sessions" value={String(sessions.length)} />
        <Kpi label="Real slips placed" value={tot.placed.toLocaleString()} />
        <Kpi label="Net (settled)" value={naira(tot.returned - tot.staked)} tone={tot.returned - tot.staked >= 0 ? 'pos' : 'neg'} />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Recent sessions</h2>
      {loading && <div className="flex items-center gap-2 py-6 text-sm text-zinc-500"><Spinner /> Loading sessions…</div>}
      {!loading && sessions.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No sessions yet.</p>
          <a href="/bet-manager" className="mt-3 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">Build your first session →</a>
        </div>
      )}
      <div className="space-y-3">
        {sessions.map(s => {
          const pAny = s.meta?.pAnyWin
          return (
            <a key={s.code} href={`/sessions/${s.code}`} className="block rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">{s.code}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLS[s.status] ?? STATUS_CLS.stopped}`}>{s.status}</span>
                <span className="text-xs text-zinc-400">{s.bookIds.join(', ')} · {ago(s.createdAt)}</span>
                <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{naira(s.budget)} → {naira(s.targetWin)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                <span>{s.slipCount ?? s.summary.slips} slips · {s.legCount ?? '—'} legs · pool {s.poolSize ?? '—'}</span>
                {pAny != null && <span>P(≥1 win) <strong className="text-zinc-800 dark:text-zinc-200">{(100 * pAny).toFixed(1)}%</strong></span>}
                <span>placed {s.summary.placed} · pending {s.summary.pending} · failed {s.summary.failed}</span>
                {s.summary.placed > 0 && <span>staked {naira(s.summary.staked)}{s.summary.returned > 0 ? ` · returned ${naira(s.summary.returned)}` : ''}</span>}
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-xl font-bold ${tone === 'pos' ? 'text-green-600 dark:text-green-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-zinc-900 dark:text-zinc-100'}`}>{value}</div>
    </div>
  )
}
