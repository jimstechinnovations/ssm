'use client'

/**
 * app/config/page.tsx — per-book configuration (server-side CRUD via /api/config).
 * Each book is saved independently (upsert). You can add a config-only book now and wire its
 * feed/placement adapter later. Credentials are env vars only — shown as set/missing, never values.
 */

import React, { useEffect, useState, useCallback } from 'react'

interface BookConfig {
  bookId: string
  label: string
  currency: string
  minStake: number
  maxPayout: number
  enabled: boolean
  boost: unknown | null
  delayMinSec: number
  delayMaxSec: number
  kickoffCutoffMin: number
  dailyBudgetCap: number
  registered: boolean
  feedVerified: boolean
  credentialsConfigured: boolean
}

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'

export default function ConfigPage() {
  const [configs, setConfigs] = useState<BookConfig[]>([])
  const [placementLive, setPlacementLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/config')
      const j = await r.json()
      setConfigs(j.configs ?? [])
      setPlacementLive(Boolean(j.placementLive))
      setError(null)
    } catch { setError('Failed to load config.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Bookmaker Config</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Per-book staking rules, caps and pacing — stored server-side. Dry-run always works; LIVE
            placement additionally requires the book <em>enabled</em> here <em>and</em> the
            <code className="mx-1 rounded bg-zinc-100 px-1 dark:bg-zinc-800">PLACEMENT_LIVE=1</code> env gate.
          </p>
        </div>
        <a href="/pedlas" className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">← Builder</a>
      </header>

      <div className={`mb-6 rounded-lg border px-4 py-3 text-sm ${placementLive
        ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200'
        : 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300'}`}>
        <strong>Live gate:</strong> PLACEMENT_LIVE is {placementLive
          ? 'SET — live placement is possible for enabled books with verified placers'
          : 'not set — every run is dry-run regardless of settings'}. Placing bets with a bot can
        breach bookmaker terms and lead to limits or voided bets — that risk is yours.
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="space-y-4">
        {configs.map(c => (
          <BookCard key={c.bookId} config={c} onSaved={load} onDeleted={load} />
        ))}
      </div>

      <AddBookForm onAdded={load} existing={configs.map(c => c.bookId)} />
    </div>
  )
}

function BookCard({ config, onSaved, onDeleted }: { config: BookConfig; onSaved: () => void; onDeleted: () => void }) {
  const [c, setC] = useState<BookConfig>(config)
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'saved' | 'error'>('clean')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setC(config); setState('clean') }, [config])

  const set = (patch: Partial<BookConfig>) => { setC(prev => ({ ...prev, ...patch })); setState('dirty') }

  async function save() {
    setState('saving'); setErr(null)
    try {
      const r = await fetch('/api/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: c.bookId, label: c.label, currency: c.currency,
          minStake: c.minStake, maxPayout: c.maxPayout, enabled: c.enabled,
          delayMinSec: c.delayMinSec, delayMaxSec: c.delayMaxSec,
          kickoffCutoffMin: c.kickoffCutoffMin, dailyBudgetCap: c.dailyBudgetCap,
        }),
      })
      const j = await r.json()
      if (!r.ok) { setErr(j.issues?.join('; ') || j.error || 'Save failed'); setState('error'); return }
      setState('saved'); onSaved()
    } catch { setErr('Network error.'); setState('error') }
  }

  async function remove() {
    if (!confirm(`Delete config for "${c.label}"? It reverts to registry defaults (config-only books disappear).`)) return
    try {
      const r = await fetch(`/api/config?bookId=${encodeURIComponent(c.bookId)}`, { method: 'DELETE' })
      if (r.ok) onDeleted()
    } catch { /* ignore */ }
  }

  const Tag = ({ ok, on, off }: { ok: boolean; on: string; off: string }) => (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${ok
      ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300'
      : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>{ok ? on : off}</span>
  )

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{c.label}</h2>
        <span className="text-xs text-zinc-400">{c.bookId}</span>
        <Tag ok={c.registered} on="adapter" off="config-only" />
        <Tag ok={c.feedVerified} on="feed verified" off="no feed" />
        <Tag ok={c.credentialsConfigured} on="credentials set" off="no credentials" />
        <label className="ml-auto flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={c.enabled} onChange={e => set({ enabled: e.target.checked })} />
          enable LIVE
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Label"><input value={c.label} onChange={e => set({ label: e.target.value })} className={inputCls} /></Field>
        <Field label={`Min stake (${c.currency})`}><input type="number" min={1} step={5} value={c.minStake} onChange={e => set({ minStake: +e.target.value })} className={inputCls} /></Field>
        <Field label={`Max payout (${c.currency})`}><input type="number" min={1} step={100000} value={c.maxPayout} onChange={e => set({ maxPayout: +e.target.value })} className={inputCls} /></Field>
        <Field label={`Daily cap (${c.currency})`}><input type="number" min={1} step={500} value={c.dailyBudgetCap} onChange={e => set({ dailyBudgetCap: +e.target.value })} className={inputCls} /></Field>
        <Field label="Delay min (s)"><input type="number" min={1} value={c.delayMinSec} onChange={e => set({ delayMinSec: +e.target.value })} className={inputCls} /></Field>
        <Field label="Delay max (s)"><input type="number" min={1} value={c.delayMaxSec} onChange={e => set({ delayMaxSec: +e.target.value })} className={inputCls} /></Field>
        <Field label="Kickoff cutoff (min)"><input type="number" min={0} value={c.kickoffCutoffMin} onChange={e => set({ kickoffCutoffMin: +e.target.value })} className={inputCls} /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={state === 'saving' || state === 'clean'}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? '✓ Saved' : 'Save'}
        </button>
        <button onClick={remove} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700/60 dark:text-red-300 dark:hover:bg-red-950/40">Delete</button>
        {err && <span className="text-sm text-red-600 dark:text-red-400">{err}</span>}
      </div>
    </div>
  )
}

function AddBookForm({ onAdded, existing }: { onAdded: () => void; existing: string[] }) {
  const [open, setOpen] = useState(false)
  const [bookId, setBookId] = useState('')
  const [label, setLabel] = useState('')
  const [minStake, setMinStake] = useState(10)
  const [err, setErr] = useState<string | null>(null)

  async function add() {
    setErr(null)
    const id = bookId.trim().toLowerCase()
    if (!/^[a-z0-9_]+$/.test(id)) { setErr('id: lowercase letters, digits, underscore only'); return }
    if (existing.includes(id)) { setErr('a book with that id already exists'); return }
    try {
      const r = await fetch('/api/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: id, label: label.trim() || id, minStake }),
      })
      const j = await r.json()
      if (!r.ok) { setErr(j.issues?.join('; ') || j.error || 'Add failed'); return }
      setBookId(''); setLabel(''); setMinStake(10); setOpen(false); onAdded()
    } catch { setErr('Network error.') }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-4 rounded-lg border border-dashed border-zinc-400 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
        + Add bookmaker config
      </button>
    )
  }
  return (
    <div className="mt-4 rounded-lg border border-zinc-300 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add a bookmaker config</h3>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Creates a config row. A book only pulls odds / places once its adapter code exists — until then it shows as “config-only”.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Book id"><input value={bookId} onChange={e => setBookId(e.target.value)} placeholder="e.g. bet9ja" className={inputCls} /></Field>
        <Field label="Label"><input value={label} onChange={e => setLabel(e.target.value)} placeholder="Bet9ja" className={inputCls} /></Field>
        <Field label="Min stake"><input type="number" min={1} value={minStake} onChange={e => setMinStake(+e.target.value)} className={inputCls} /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={add} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">Add</button>
        <button onClick={() => { setOpen(false); setErr(null) }} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Cancel</button>
        {err && <span className="text-sm text-red-600 dark:text-red-400">{err}</span>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  )
}
