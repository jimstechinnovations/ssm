'use client'

/**
 * app/bet-manager/page.tsx — the Bet Manager.
 * Set books + window + budget + target; the engine COMPUTES legs (from target/odds/boost) and slips
 * (budget/min stake), builds a scattered coverage book, persists it under a session id, and shows the
 * HONEST P(≥1 win). Everything server-side. No guarantee is implied — it's a scatter, not a lock.
 */

import React, { useEffect, useState } from 'react'
import { Spinner } from '@/components/Icons'

interface BookConfig { bookId: string; label: string; minStake: number; enabled: boolean; registered: boolean; feedVerified: boolean }
interface BuiltBook { bookId: string; slips?: number; legs?: number; pAnyWin?: number; medianPayout?: number; withHistory?: number; note?: string; error?: string; detail?: string }
interface SessionResult {
  session: { code: string; status: string; legCount: number | null; slipCount: number | null; poolSize: number | null; budget: number; targetWin: number }
  books: BuiltBook[]
  summary: { slips: number; staked: number }
}

const inputCls = 'w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
const naira = (n: number) => '₦' + Math.round(n).toLocaleString()
const todayPlus = (d: number) => { const t = new Date(Date.now() + d * 864e5); return t.toISOString().slice(0, 10) }

export default function BetManagerPage() {
  const [books, setBooks] = useState<BookConfig[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState(todayPlus(0))
  const [dateTo, setDateTo] = useState(todayPlus(1))
  const [budget, setBudget] = useState(5000)
  const [target, setTarget] = useState(500000)
  const [windowMin, setWindowMin] = useState<number | ''>('')   // '' = auto (computed from slip count)
  const [legPref, setLegPref] = useState<number | ''>('')
  const [requireHistory, setRequireHistory] = useState(false)
  const [building, setBuilding] = useState(false)
  const [result, setResult] = useState<SessionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const j = await (await fetch('/api/config')).json()
        const cfgs: BookConfig[] = j.configs ?? []
        setBooks(cfgs)
        const def = cfgs.find(c => c.bookId === 'sportybet') ?? cfgs.find(c => c.registered)
        if (def) setSelected([def.bookId])
      } catch { setError('Could not load books.') }
    })()
  }, [])

  const minStake = Math.max(1, ...books.filter(b => selected.includes(b.bookId)).map(b => b.minStake))
  const slipEstimate = Math.floor(budget / minStake)
  // mirror the server estimate: run ≈ slips × 20s, auto window = run + 75m buffer
  const estRunMin = Math.ceil((slipEstimate * 20) / 60)
  const estWindowMin = windowMin || Math.max(60, estRunMin + 75)
  const hrs = (m: number) => m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m}m`

  async function build() {
    if (selected.length === 0) { setError('Pick at least one book.'); return }
    setBuilding(true); setError(null); setResult(null)
    try {
      const body: Record<string, unknown> = {
        books: selected, date_from: dateFrom, date_to: dateTo,
        budget, target_win: target,
      }
      if (windowMin) body.selection_window_min = windowMin
      if (legPref) body.leg_pref = legPref
      if (requireHistory) body.require_history = true
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) { setError(j.issues?.join('; ') || j.error || 'Build failed'); return }
      setResult(j)
    } catch { setError('Network error building the session.') }
    finally { setBuilding(false) }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bet Manager</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Set the budget &amp; target — the engine computes the legs and scatters the slips.</p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Bookmakers</span>
          <div className="flex flex-wrap gap-2">
            {books.map(b => {
              const on = selected.includes(b.bookId)
              return (
                <button key={b.bookId} onClick={() => setSelected(s => on ? s.filter(x => x !== b.bookId) : [...s, b.bookId])}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${on
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}
                  title={b.registered ? (b.feedVerified ? 'feed verified' : 'adapter present') : 'config-only (no feed yet)'}>
                  {b.label}{!b.registered && ' ·cfg'}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Date from"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} /></Field>
          <Field label="Date to (≤ +2 days)"><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} /></Field>
          <Field label="Selection window (min — blank = auto)"><input type="number" min={15} max={600} placeholder="auto" value={windowMin} onChange={e => setWindowMin(e.target.value ? +e.target.value : '')} className={inputCls} /></Field>
          <Field label="Budget (₦)"><input type="number" min={10} step={500} value={budget} onChange={e => setBudget(+e.target.value)} className={inputCls} /></Field>
          <Field label="Target win (₦)"><input type="number" min={100} step={10000} value={target} onChange={e => setTarget(+e.target.value)} className={inputCls} /></Field>
          <Field label="Legs (auto — override optional)"><input type="number" min={3} max={60} placeholder="auto" value={legPref} onChange={e => setLegPref(e.target.value ? +e.target.value : '')} className={inputCls} /></Field>
        </div>

        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          min stake <strong>{naira(minStake)}</strong> · budget ÷ min stake ≈ <strong>{slipEstimate.toLocaleString()} slips</strong> ·
          est. place time <strong>~{hrs(estRunMin)}</strong> · {windowMin ? 'window' : 'auto window'} <strong>~{hrs(estWindowMin)}</strong> —
          only games kicking off after that are selected, so nothing goes live mid-placement.
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={requireHistory} onChange={e => setRequireHistory(e.target.checked)} />
          Require match history — only build on games we have H2H/form data for
          <span className="text-xs text-zinc-400">(falls back with a note until Sofascore history is added)</span>
        </label>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={build} disabled={building}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
            {building && <Spinner className="h-4 w-4" />}{building ? 'Building & analysing…' : 'Build session'}
          </button>
          {building && <span className="text-sm text-zinc-500">fetching pool → history/AI → scatter {slipEstimate} slips…</span>}
          {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </section>

      {result && <ResultCard result={result} onCloned={() => { /* dashboard shows it */ }} />}

      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
        Honest note: every slip is a −vig multibet. This spreads the budget so <em>at least one</em> slip <em>may</em> land —
        it is a scatter, not a guarantee. The <strong>P(≥1 win)</strong> shown is the real modelled chance for these exact slips.
      </p>
    </div>
  )
}

function ResultCard({ result, onCloned }: { result: SessionResult; onCloned: () => void }) {
  const { session, books, summary } = result
  const [cloning, setCloning] = useState(false)
  const [cloneCode, setCloneCode] = useState<string | null>(null)
  const pAny = books.find(b => b.pAnyWin != null)?.pAnyWin

  async function clone() {
    setCloning(true)
    try {
      const j = await (await fetch(`/api/sessions/${session.code}/clone`, { method: 'POST' })).json()
      if (j.session) { setCloneCode(j.session.code); onCloned() }
    } finally { setCloning(false) }
  }

  return (
    <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Session {session.code}</h2>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{session.status}</span>
        <a href={`/sessions/${session.code}`} className="ml-auto text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">open →</a>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Slips" value={(session.slipCount ?? summary.slips).toLocaleString()} />
        <Stat label="Legs / slip" value={String(session.legCount ?? '—')} />
        <Stat label="Pool games" value={String(session.poolSize ?? '—')} />
        <Stat label="P(≥1 win)" value={pAny != null ? (100 * pAny).toFixed(1) + '%' : '—'} highlight />
      </div>

      <div className="mt-4 space-y-1.5 text-sm">
        {books.map(b => (
          <div key={b.bookId} className="flex flex-wrap items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">{b.bookId}</span>
            {b.error ? <span className="text-red-600 dark:text-red-400">{b.error}{b.detail ? ` — ${b.detail}` : ''}</span>
              : <span>{b.slips} slips · {b.legs} legs · payout {b.medianPayout != null ? naira(b.medianPayout) : '—'} · P {b.pAnyWin != null ? (100 * b.pAnyWin).toFixed(1) + '%' : '—'}{b.withHistory != null ? ` · ${b.withHistory} w/ history` : ''}</span>}
            {b.note && <span className="text-amber-600 dark:text-amber-400">· {b.note}</span>}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={clone} disabled={cloning}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {cloning ? 'Cloning…' : 'Clone for parallel run'}
        </button>
        {cloneCode && <span className="text-sm text-green-600 dark:text-green-400">✓ cloned → {cloneCode}</span>}
      </div>

      <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
        <div className="mb-1 font-semibold text-zinc-700 dark:text-zinc-300">Place these slips</div>
        <code className="block">node scripts/place-session.mjs {session.code}            <span className="opacity-60"># dry-run (no money)</span></code>
        <code className="block">node scripts/place-session.mjs {session.code} --live     <span className="opacity-60"># REAL money — Chrome on :9222 logged into SportyBet</span></code>
      </div>
    </section>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? 'border-zinc-900 dark:border-zinc-100' : 'border-zinc-200 dark:border-zinc-700'}`}>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-lg font-bold ${highlight ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-800 dark:text-zinc-200'}`}>{value}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>{children}</label>
}
