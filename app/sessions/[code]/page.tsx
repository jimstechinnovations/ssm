'use client'

/**
 * app/sessions/[code]/page.tsx — one session: params, honest metrics, the slips + their status, and
 * the placement controls (dry / live) with browser readiness. Polls while a run is placing.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'

interface Slip { id: string; slipId: number; status: string; stake: number; combinedOdds: number; potentialPayout: number | null; legCount: number; bookingCode: string | null; betId: string | null; failureReason: string | null; won: boolean | null }
interface Summary { slips: number; pending: number; placed: number; failed: number; won: number; lost: number; staked: number; returned: number; net: number }
interface Session { code: string; status: string; budget: number; targetWin: number; minStake: number; legCount: number | null; slipCount: number | null; poolSize: number | null; bookIds: string[]; meta?: { pAnyWin?: number; windowMin?: number } | null }
interface BrowserState { up: boolean; loggedIn?: boolean; balance?: number | null; mode?: string }

const naira = (n?: number | null) => n == null ? '—' : '₦' + Math.round(n).toLocaleString()
const STATUS_CLS: Record<string, string> = {
  pending: 'text-zinc-500', placing: 'text-amber-600 dark:text-amber-400', placed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400', won: 'text-green-700 dark:text-green-300', lost: 'text-zinc-500', skipped: 'text-zinc-400',
}

export default function SessionPage() {
  const code = String(useParams().code)
  const [session, setSession] = useState<Session | null>(null)
  const [slips, setSlips] = useState<Slip[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [workers, setWorkers] = useState(3)

  // session data renders immediately; browser status (slow — it talks to Chrome) loads separately
  const load = useCallback(async () => {
    try {
      const s = await fetch(`/api/sessions/${code}`).then(r => r.json())
      if (s.session) { setSession(s.session); setSlips(s.slips ?? []); setSummary(s.summary) }
    } catch { /* ignore */ }
  }, [code])

  const loadBrowser = useCallback(async () => {
    try { setBrowser(await fetch('/api/browser').then(r => r.json())) } catch { setBrowser({ up: false }) }
  }, [])

  useEffect(() => { void load(); void loadBrowser() }, [load, loadBrowser])
  useEffect(() => {
    if (session?.status !== 'placing') return
    const t = setInterval(load, 4000); return () => clearInterval(t)
  }, [session?.status, load])

  async function clone() {
    setBusy(true)
    try { const j = await (await fetch(`/api/sessions/${code}/clone`, { method: 'POST' })).json(); if (j.session) setMsg(`Cloned → ${j.session.code}`) } finally { setBusy(false) }
  }
  async function place(live: boolean) {
    if (live && !confirm(`Place REAL money on all ${summary?.pending} pending slips? This stakes ${naira(session?.budget)} and is irreversible.`)) return
    setBusy(true); setMsg(null)
    try {
      const j = await (await fetch(`/api/sessions/${code}/place`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live, workers }) })).json()
      setMsg(j.error ? `⚠ ${j.error}` : `Started ${live ? 'LIVE' : 'dry-run'} placement of ${j.pending} slips across ${j.workers} worker(s).`)
      await load()
    } finally { setBusy(false) }
  }

  if (!session) return <div className="mx-auto max-w-4xl px-4 py-8 text-sm text-zinc-500">Loading {code}…</div>

  const pAny = session.meta?.pAnyWin
  const liveReady = browser?.up && browser.loggedIn && browser.mode !== 'SIM'

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center gap-2">
        <a href="/" className="text-sm text-zinc-500 hover:underline">← Dashboard</a>
        <h1 className="ml-2 font-mono text-xl font-bold text-zinc-900 dark:text-zinc-100">{session.code}</h1>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{session.status}</span>
        <button onClick={clone} disabled={busy} className="ml-auto rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Clone</button>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Budget → target" value={`${naira(session.budget)} → ${naira(session.targetWin)}`} />
        <Stat label="Slips × legs" value={`${session.slipCount ?? summary?.slips ?? '—'} × ${session.legCount ?? '—'}`} />
        <Stat label="Pool games" value={String(session.poolSize ?? '—')} />
        <Stat label="P(≥1 win)" value={pAny != null ? (100 * pAny).toFixed(1) + '%' : '—'} highlight />
      </div>

      {/* Placement controls */}
      <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Placement</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            browser {browser?.up ? 'up' : 'down'}{browser?.up ? ` · ${browser.loggedIn ? 'logged in' : 'not logged in'} · ${browser.mode ?? '—'} · ${naira(browser.balance)}` : ''}
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            workers
            <select value={workers} onChange={e => setWorkers(Number(e.target.value))} className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800">
              {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button onClick={() => place(false)} disabled={busy || (summary?.pending ?? 0) === 0}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Dry-run</button>
            <button onClick={() => place(true)} disabled={busy || !liveReady || (summary?.pending ?? 0) === 0}
              title={liveReady ? '' : 'Launch the browser, log in, switch REAL first (Config)'}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40">Place LIVE (real money)</button>
          </div>
        </div>
        {summary && (() => {
          const total = Math.max(1, summary.placed + summary.failed + summary.pending)
          const pct = (n: number) => `${(100 * n / total).toFixed(1)}%`
          return (
            <div className="mt-3">
              <div className="flex h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="bg-green-500" style={{ width: pct(summary.placed) }} title={`placed ${summary.placed}`} />
                <div className="bg-red-500" style={{ width: pct(summary.failed) }} title={`failed ${summary.failed}`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="text-green-600 dark:text-green-400">● placed {summary.placed}</span>
                <span className="text-zinc-400">● pending {summary.pending}</span>
                <span className="text-red-600 dark:text-red-400">● failed {summary.failed}</span>
                <span>staked <strong>{naira(summary.staked)}</strong></span>
                <span>won {summary.won} · lost {summary.lost}</span>
                {summary.returned > 0 && <span>returned {naira(summary.returned)} · net {naira(summary.net)}</span>}
              </div>
            </div>
          )
        })()}
        {msg && <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{msg}</p>}
        {!liveReady && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Live disabled until the browser is up, logged in, and in REAL mode — set it up on the Config page. Live also needs PLACEMENT_LIVE=1.</p>}
      </section>

      {/* Slips */}
      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Slips ({slips.length})</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
            <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">legs</th><th className="px-3 py-2">odds</th><th className="px-3 py-2">payout</th><th className="px-3 py-2">status</th><th className="px-3 py-2">code / bet</th></tr>
          </thead>
          <tbody>
            {slips.slice(0, 100).map(s => (
              <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-500">{s.slipId}</td>
                <td className="px-3 py-1.5">{s.legCount}</td>
                <td className="px-3 py-1.5">{s.combinedOdds?.toFixed?.(1) ?? '—'}</td>
                <td className="px-3 py-1.5">{naira(s.potentialPayout)}</td>
                <td className={`px-3 py-1.5 font-medium ${STATUS_CLS[s.status] ?? ''}`}>{s.status}{s.failureReason ? ` · ${s.failureReason}` : ''}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-zinc-500">{s.bookingCode ?? s.betId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {slips.length > 100 && <p className="mt-2 text-xs text-zinc-400">showing first 100 of {slips.length}</p>}
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? 'border-zinc-900 dark:border-zinc-100' : 'border-zinc-200 dark:border-zinc-700'}`}>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  )
}
