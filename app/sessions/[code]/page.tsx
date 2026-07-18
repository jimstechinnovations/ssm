'use client'

/**
 * app/sessions/[code]/page.tsx — one session, end to end. Everything server-backed, so it survives a
 * refresh / closed laptop / crash: you return and see exactly the last state, then Stop or Resume.
 *
 * Run state is DERIVED (no fragile client flags): running = status 'placing' + a fresh heartbeat;
 * stalled = 'placing' but the heartbeat went cold (the run died) — offer Resume; done = 0 pending.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import { ArrowLeft, Copy, Play, StopIcon, Spinner, Loading, Dot, Check, Layers, Download, XMark, Refresh } from '@/components/Icons'
import { TotalsChart } from '@/components/TotalsChart'

interface Slip { id: string; slipId: number; status: string; stake: number; combinedOdds: number; potentialPayout: number | null; legCount: number; bookingCode: string | null; betId: string | null; failureReason: string | null; won: boolean | null }
interface Summary { slips: number; pending: number; placed: number; failed: number; won: number; lost: number; staked: number; returned: number; net: number }
interface Session { code: string; status: string; budget: number; targetWin: number; minStake: number; legCount: number | null; slipCount: number | null; poolSize: number | null; bookIds: string[]; updatedAt: string; dateTo: string; meta?: { pAnyWin?: number; windowMin?: number; stopRequested?: boolean } | null }
interface BrowserState { up: boolean; loggedIn?: boolean; balance?: number | null; mode?: string }
interface Game { fixtureId: number; game: string; league: string; kickoff: string; line: number; underOdds: number; history: { date: string; total: number }[]; overRate: number | null; source?: string; outcome?: { finished: boolean; total: number | null; over: boolean | null } | null }
interface SurvGame { order: number; game: string; underOdds: number; bucket: string; overSlips: number; finished: boolean; total: number | null; over: boolean | null; cut: number; aliveAfter: number }
interface SurvBucket { range: string; games: number; realisedOverRate: number | null; impliedOverApprox: number | null }
interface Realised { overs: number; finished: number; overFraction: number | null; maxOverRun: number; layer1_over50: boolean | null }
interface Survival { alive: number; dead: number; total: number; finishedGames: number; ofGames: number; realised?: Realised; curve: SurvGame[]; buckets: SurvBucket[] }
interface SlipLeg { fixtureId: number; game: string; kickoff: string; line: number; side: string; odds: number }
interface SlipDetail { slipId: number; status: string; stake: number; combinedOdds: number; payout: number | null; bookingCode: string | null; betId: string | null; legs: SlipLeg[] }

const naira = (n?: number | null) => n == null ? '—' : '₦' + Math.round(n).toLocaleString()
const HEARTBEAT_STALE_MS = 25_000
const statusTone: Record<string, 'green' | 'red' | 'amber' | 'zinc'> = { placed: 'green', won: 'green', failed: 'red', placing: 'amber', pending: 'zinc', lost: 'zinc', skipped: 'zinc' }

export default function SessionPage() {
  const code = String(useParams().code)
  const [session, setSession] = useState<Session | null>(null)
  const [slips, setSlips] = useState<Slip[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [games, setGames] = useState<Game[] | null>(null)
  const [showGames, setShowGames] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'warn' | 'info' } | null>(null)
  const [busy, setBusy] = useState<null | 'dry' | 'live' | 'stop' | 'clone'>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [workers, setWorkers] = useState(3)
  const [ai, setAi] = useState<{ text: string; source: string } | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [slipView, setSlipView] = useState<null | { slipId: number; loading: boolean; data?: SlipDetail }>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const notFound = useRef(false)
  const PAGE = 50

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/sessions/${code}?offset=${page * PAGE}&limit=${PAGE}`)
      if (r.status === 404) { notFound.current = true; setSession(null); return }
      const s = await r.json()
      if (s.session) { setSession(s.session); setSlips(s.slips ?? []); setSummary(s.summary); setTotal(s.page?.total ?? s.summary?.slips ?? 0) }
    } catch { /* keep last state */ }
  }, [code, page])
  const loadBrowser = useCallback(async () => {
    try { setBrowser(await fetch('/api/browser').then(r => r.json())) } catch { setBrowser({ up: false }) }
  }, [])
  const [prepBusy, setPrepBusy] = useState(false)
  async function prepareBrowser() {
    setPrepBusy(true); setMsg(null)
    try {
      const j = await (await fetch('/api/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare' }) })).json()
      setBrowser(j.status ?? { up: false })
      setMsg({ text: `Browser: ${(j.steps ?? []).join(' → ')}`, tone: j.status?.loggedIn ? 'ok' : 'warn' })
    } catch { setMsg({ text: 'Could not prepare the browser.', tone: 'warn' }) }
    finally { setPrepBusy(false) }
  }

  useEffect(() => { void load(); void loadBrowser() }, [load, loadBrowser])

  // derive run state
  const pending = summary?.pending ?? 0
  const done = summary != null && pending === 0
  const heartbeatMs = session ? Date.now() - Date.parse(session.updatedAt) : Infinity
  const fresh = heartbeatMs < HEARTBEAT_STALE_MS
  const stopReq = Boolean(session?.meta?.stopRequested)
  const running = session?.status === 'placing' && !done && fresh && !stopReq
  const stopping = stopReq && fresh && !done
  const stalled = session?.status === 'placing' && !done && !fresh && !stopReq

  // poll while there's anything in flight (progress + stall detection)
  useEffect(() => {
    if (done) return
    const t = setInterval(() => { void load() }, running || stopping ? 3000 : 6000)
    return () => clearInterval(t)
  }, [done, running, stopping, load])

  async function place(live: boolean) {
    const verb = summary && summary.placed > 0 ? 'Resume — place the remaining' : 'Place all'
    if (live && !confirm(`${verb} ${pending} pending slip(s) for REAL money (~${naira(pending * (session?.minStake ?? 10))})? This is irreversible.`)) return
    setBusy(live ? 'live' : 'dry'); setMsg(null)
    try {
      const j = await (await fetch(`/api/sessions/${code}/place`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live, workers }) })).json()
      setMsg(j.error ? { text: j.error, tone: 'warn' } : { text: `Started ${live ? 'LIVE' : 'dry-run'} placement of ${j.pending} slip(s) across ${j.workers} worker(s).`, tone: 'ok' })
      await load()
    } catch { setMsg({ text: 'Network error starting placement.', tone: 'warn' }) }
    finally { setBusy(null) }
  }
  async function stop() {
    setBusy('stop')
    try { await fetch(`/api/sessions/${code}/stop`, { method: 'POST' }); setMsg({ text: 'Stop requested — the run halts after the current slip. Resume anytime.', tone: 'info' }); await load() }
    finally { setBusy(null) }
  }
  async function clone() {
    setBusy('clone')
    try { const j = await (await fetch(`/api/sessions/${code}/clone`, { method: 'POST' })).json(); if (j.session) setMsg({ text: `Cloned → ${j.session.code} (open it to place in parallel).`, tone: 'ok' }) }
    finally { setBusy(null) }
  }
  const loadGames = useCallback(async () => {
    try { const j = await fetch(`/api/sessions/${code}/games`).then(r => r.json()); setGames(j.games ?? []) } catch { setGames([]) }
  }, [code])
  async function openGames() { setShowGames(v => !v); if (games == null) await loadGames() }
  const [histBusy, setHistBusy] = useState(false)
  async function fetchHistory() {
    setHistBusy(true); setMsg(null)
    try {
      const j = await (await fetch(`/api/sessions/${code}/fetch-history`, { method: 'POST' })).json()
      setMsg(j.error ? { text: j.error, tone: 'warn' } : { text: `Sofascore: processed ${j.processed}/${j.games} games · ${j.withH2H} have H2H (${j.rows} matches stored).${j.more ? ' Click again for the rest.' : ''}`, tone: 'ok' })
      await loadGames()
    } catch { setMsg({ text: 'Could not fetch history.', tone: 'warn' }) }
    finally { setHistBusy(false) }
  }
  function copy(text: string) { navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(null), 1200) }) }
  async function openSlip(slipId: number) {
    setSlipView({ slipId, loading: true })
    try { const data = await fetch(`/api/sessions/${code}/slip?slipId=${slipId}`).then(r => r.json()); setSlipView({ slipId, loading: false, data }) }
    catch { setSlipView({ slipId, loading: false }) }
  }
  async function analyze() {
    setAiBusy(true)
    try { const j = await (await fetch(`/api/sessions/${code}/analyze`, { method: 'POST' })).json(); setAi({ text: j.summary ?? j.error ?? '—', source: j.source ?? '' }) }
    catch { setAi({ text: 'Could not run analysis.', source: '' }) }
    finally { setAiBusy(false) }
  }
  const [settleBusy, setSettleBusy] = useState(false)
  async function settle() {
    setSettleBusy(true); setMsg(null)
    try {
      const j = await (await fetch(`/api/sessions/${code}/settle`, { method: 'POST' })).json()
      setMsg(j.error ? { text: j.error, tone: 'warn' } : { text: `Settled ${j.settled} (won ${j.won}, lost ${j.lost}) · ${j.pending} still pending · ${j.gamesFinished}/${j.of} games finished.`, tone: 'ok' })
      await load(); if (showSurvival) await loadSurvival()
    } catch { setMsg({ text: 'Could not check results.', tone: 'warn' }) }
    finally { setSettleBusy(false) }
  }

  const [survival, setSurvival] = useState<Survival | null>(null)
  const [showSurvival, setShowSurvival] = useState(false)
  const [survBusy, setSurvBusy] = useState(false)
  const loadSurvival = useCallback(async () => {
    setSurvBusy(true)
    try { const j = await fetch(`/api/sessions/${code}/survival`).then(r => r.json()); if (!j.error) setSurvival(j) }
    catch { /* keep last */ } finally { setSurvBusy(false) }
  }, [code])
  async function toggleSurvival() { setShowSurvival(v => !v); if (survival == null) await loadSurvival() }

  if (notFound.current) return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-sm text-zinc-500">Session <span className="font-mono">{code}</span> not found. <a href="/" className="text-blue-600 hover:underline dark:text-blue-400">Back to dashboard</a></div>
  if (!session) return <Loading label={`Loading ${code}…`} />

  const pAny = session.meta?.pAnyWin
  const liveReady = browser?.up && browser.loggedIn && browser.mode !== 'SIM'
  const runLabel = done ? 'complete' : running ? 'placing' : stopping ? 'stopping' : stalled ? 'stalled' : session.status
  const runTone = done ? 'green' : running ? 'amber' : stalled ? 'red' : 'zinc'

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <a href="/" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /> Dashboard</a>
        <h1 className="font-mono text-xl font-bold text-zinc-900 dark:text-zinc-100">{session.code}</h1>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {(running || stopping) ? <Spinner className="h-3 w-3" /> : <Dot tone={runTone} />} {runLabel}
        </span>
        <div className="ml-auto flex gap-2">
          {(summary?.placed ?? 0) > 0 && (
            <button onClick={settle} disabled={settleBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {settleBusy ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" />} Check results
            </button>
          )}
          {(summary?.placed ?? 0) > 0 && (
            <button onClick={toggleSurvival} disabled={survBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {survBusy ? <Spinner className="h-4 w-4" /> : <Layers className="h-4 w-4" />} Survival
            </button>
          )}
          <button onClick={clone} disabled={busy != null} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {busy === 'clone' ? <Spinner className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Duplicate
          </button>
        </div>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Budget → target" value={`${naira(session.budget)} → ${naira(session.targetWin)}`} />
        <Stat label="Slips × legs" value={`${session.slipCount ?? summary?.slips ?? '—'} × ${session.legCount ?? '—'}`} />
        <Stat label="Pool games" value={String(session.poolSize ?? '—')} onClick={openGames} action />
        <Stat label="P(≥1 win)" value={pAny != null ? (100 * pAny).toFixed(1) + '%' : '—'} highlight />
      </div>

      {/* Games (collapsible) */}
      {showGames && (
        <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            <Layers className="h-4 w-4" /> Pool games {games ? `(${games.length})` : ''}
            <button onClick={fetchHistory} disabled={histBusy} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {histBusy ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />} Fetch H2H history
            </button>
          </div>
          {games == null ? <div className="py-3"><Spinner /></div> : (
            <>
            <p className="mb-2 text-xs text-zinc-400">Each bar = a past match's total goals; <span className="text-green-600 dark:text-green-400">green</span> stayed Under 4.5, <span className="text-red-600 dark:text-red-400">red</span> went Over. {games.filter(g => g.history.length).length}/{games.length} games have history.</p>
            <div className="max-h-96 overflow-y-auto text-sm">
              {games.map((g, i) => (
                <div key={g.fixtureId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 py-2 first:border-0 dark:border-zinc-800">
                  <span className="w-5 text-right text-xs text-zinc-400">{i + 1}</span>
                  <div className="min-w-[9rem] flex-1">
                    <div className="text-zinc-800 dark:text-zinc-200">{g.game}</div>
                    <div className="text-xs text-zinc-400">{g.league} · {new Date(g.kickoff).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                  <div className="text-zinc-500">
                    <TotalsChart history={g.history} />
                    {g.source && g.source !== 'none' && <div className="mt-0.5 text-center text-[10px] uppercase tracking-wide text-zinc-400">{g.source === 'h2h' ? 'H2H' : 'form'}</div>}
                  </div>
                  <span className="w-28 text-right text-xs text-zinc-600 dark:text-zinc-300">
                    {g.overRate != null && <span className={g.overRate > 0.25 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}>{Math.round(g.overRate * 100)}% over · </span>}
                    U{g.line} @ {g.underOdds}
                    {g.outcome?.finished
                      ? <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${g.outcome.over ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300'}`}>FT {g.outcome.total} · {g.outcome.over ? `OVER ${g.line}` : `UNDER ${g.line}`}</span>
                      : <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-400">upcoming</span>}
                  </span>
                </div>
              ))}
            </div>
            </>
          )}
        </section>
      )}

      {/* Survival curve — how many slips remain as each game finishes (+ §5F odds-bucket calibration) */}
      {showSurvival && survival && (
        <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            <Layers className="h-4 w-4" /> Survival curve
            <span className="text-xs font-normal text-zinc-500">{survival.alive}/{survival.total} alive · {survival.dead} cut · {survival.finishedGames}/{survival.ofGames} games in</span>
            <button onClick={loadSurvival} disabled={survBusy} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {survBusy ? <Spinner className="h-3.5 w-3.5" /> : <Refresh className="h-3.5 w-3.5" />} Refresh
            </button>
          </div>
          {survival.realised && survival.realised.finished > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/50">
              <span className="text-zinc-500">realised (Layer P/E check):</span>
              <span className="text-zinc-700 dark:text-zinc-300"><strong>{survival.realised.overs}</strong>/{survival.realised.finished} Over ({Math.round((survival.realised.overFraction ?? 0) * 100)}%)
                {survival.realised.layer1_over50 === false && <span className="ml-1 text-green-600 dark:text-green-400">✓ ≤50% (Layer 1 held)</span>}
                {survival.realised.layer1_over50 === true && <span className="ml-1 text-red-500">✗ &gt;50% Over — Layer 1 pruned reality</span>}</span>
              <span className="text-zinc-700 dark:text-zinc-300">max consecutive-Over run <strong>{survival.realised.maxOverRun}</strong>
                {survival.realised.maxOverRun < 3 && <span className="ml-1 text-green-600 dark:text-green-400">✓ &lt;3 (Layer 2 held)</span>}
                {survival.realised.maxOverRun >= 3 && <span className="ml-1 text-red-500">✗ ≥3 — Layer 2 pruned a real run</span>}</span>
            </div>
          )}
          <p className="mb-2 text-xs text-zinc-400">Each finished game cuts the slips that called it wrong. An Under result cuts the few that flipped it Over; an <span className="text-red-500">Over</span> cuts the many that kept it Under.</p>
          <div className="max-h-80 overflow-y-auto text-sm">
            {survival.curve.map(c => (
              <div key={c.order} className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 py-1.5 first:border-0 dark:border-zinc-800 ${c.finished ? '' : 'opacity-60'}`}>
                <span className="w-6 text-right text-xs text-zinc-400">{c.order}</span>
                <span className="min-w-[8rem] flex-1 text-zinc-800 dark:text-zinc-200">{c.game}</span>
                <span className="text-xs text-zinc-400">U@{c.underOdds}</span>
                {c.finished
                  ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${c.over ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300'}`}>FT {c.total} · {c.over ? 'OVER' : 'UNDER'}</span>
                  : <span className="text-[10px] uppercase tracking-wide text-zinc-400">upcoming</span>}
                <span className="w-32 text-right text-xs">
                  {c.finished ? <><span className="text-red-500">−{c.cut}</span> <span className="text-zinc-400">→</span> <span className="font-semibold text-zinc-700 dark:text-zinc-300">{c.aliveAfter} alive</span></> : <span className="text-zinc-400">{c.overSlips} slips Over</span>}
                </span>
              </div>
            ))}
          </div>
          {survival.buckets.length > 0 && (
            <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <div className="mb-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">§5F — Under-odds buckets (finished games): realised Over vs implied</div>
              <div className="space-y-0.5 text-xs">
                {survival.buckets.map(b => (
                  <div key={b.range} className="flex items-center gap-3 text-zinc-600 dark:text-zinc-400">
                    <span className="w-24 font-mono">{b.range}</span>
                    <span className="w-16">{b.games} game{b.games === 1 ? '' : 's'}</span>
                    <span className="w-28">realised <strong className={b.realisedOverRate && b.realisedOverRate > (b.impliedOverApprox ?? 1) ? 'text-red-500' : 'text-green-600 dark:text-green-400'}>{b.realisedOverRate != null ? Math.round(b.realisedOverRate * 100) : '—'}% O</strong></span>
                    <span className="text-zinc-400">implied ~{b.impliedOverApprox != null ? Math.round(b.impliedOverApprox * 100) : '—'}%</span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">Realised &lt; implied in the ≥1.20 buckets ⇒ Under underpriced (value on our side). Needs many sessions to be real — this is a log, not a verdict.</p>
            </div>
          )}
        </section>
      )}

      {/* Placement */}
      <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Placement</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <Dot tone={browser?.up ? (browser.mode === 'SIM' ? 'amber' : 'green') : 'zinc'} />
            {browser == null ? 'checking browser…' : browser.up ? `browser ${browser.loggedIn ? 'ready' : 'not logged in'} · ${browser.mode ?? '—'} · ${naira(browser.balance)}` : 'browser down'}
          </span>
          {!(running || stopping) && !liveReady && (
            <button onClick={prepareBrowser} disabled={prepBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800/60 dark:text-blue-300 dark:hover:bg-blue-950/30">
              {prepBusy ? <Spinner className="h-3.5 w-3.5" /> : <Play className="h-3 w-3" />} Prepare browser
            </button>
          )}
          {!(running || stopping) && (
            <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
              workers
              <select value={workers} onChange={e => setWorkers(Number(e.target.value))} className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800">
                {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <div className={`flex gap-2 ${(running || stopping) ? 'ml-auto' : ''}`}>
            {(running || stopping) ? (
              <button onClick={stop} disabled={busy != null || stopping} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60">
                {busy === 'stop' || stopping ? <Spinner className="h-4 w-4" /> : <StopIcon className="h-4 w-4" />} {stopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : done ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-400"><Check className="h-4 w-4" /> all slips processed</span>
            ) : (
              <>
                <button onClick={() => place(false)} disabled={busy != null || pending === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  {busy === 'dry' ? <Spinner className="h-4 w-4" /> : null} Dry-run
                </button>
                <button onClick={() => place(true)} disabled={busy != null || !liveReady || pending === 0}
                  title={liveReady ? '' : 'Launch the browser, log in, switch REAL first (Config)'}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40">
                  {busy === 'live' ? <Spinner className="h-4 w-4" /> : <Play className="h-3.5 w-3.5" />} {summary && summary.placed > 0 ? 'Resume LIVE' : 'Place LIVE'}
                </button>
              </>
            )}
          </div>
        </div>

        {summary && (() => {
          const total = Math.max(1, summary.placed + summary.failed + summary.pending)
          const pct = (n: number) => `${(100 * n / total).toFixed(2)}%`
          return (
            <div className="mt-3">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="bg-green-500 transition-all" style={{ width: pct(summary.placed) }} />
                <div className="bg-red-500 transition-all" style={{ width: pct(summary.failed) }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                <span><strong className="text-zinc-800 dark:text-zinc-200">{summary.placed}</strong>/{total} placed</span>
                <span className="inline-flex items-center gap-1"><Dot tone="zinc" /> pending {summary.pending}</span>
                {summary.failed > 0 && <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"><Dot tone="red" /> failed {summary.failed}</span>}
                <span>staked <strong>{naira(summary.staked)}</strong></span>
                {(summary.won + summary.lost) > 0 && <span>won {summary.won} · lost {summary.lost}</span>}
                {summary.returned > 0 && <span>returned {naira(summary.returned)} · net {naira(summary.net)}</span>}
              </div>
            </div>
          )
        })()}

        {stalled && <Banner tone="warn">This run stopped unexpectedly (browser closed, laptop slept, or a crash). {summary?.placed ?? 0} slip(s) are safely placed. Press <strong>Resume LIVE</strong> to place the rest — already-placed slips are skipped automatically.</Banner>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        {!liveReady && !running && !done && <Banner tone="muted">Live needs the browser up, logged in and in <strong>REAL</strong> mode — set it up on <a href="/config" className="underline">Config</a> (and <code>PLACEMENT_LIVE=1</code>).</Banner>}
      </section>

      {/* AI read */}
      <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">AI read</span>
          {ai?.source && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{ai.source}</span>}
          <button onClick={analyze} disabled={aiBusy} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {aiBusy ? <Spinner className="h-4 w-4" /> : <Layers className="h-4 w-4" />} {ai ? 'Re-analyse' : 'Analyse risk'}
          </button>
        </div>
        {ai ? <p className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{ai.text}</p>
          : <p className="mt-1 text-xs text-zinc-400">Honest risk read of this session — which games most threaten the all-Under base, grounded in history.</p>}
      </section>

      {/* Slips ledger */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Slips <span className="font-normal text-zinc-400">· {total} total</span></h2>
        <a href={`/sessions/${code}/print`} target="_blank" rel="noopener"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <Download className="h-3.5 w-3.5" /> Export PDF
        </a>
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
            <tr><Th>#</Th><Th>legs</Th><Th>odds</Th><Th>payout</Th><Th>status</Th><Th>booking code</Th></tr>
          </thead>
          <tbody>
            {slips.map(s => (
              <tr key={s.id} onClick={() => openSlip(s.slipId)} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
                <td className="px-3 py-1.5 font-medium text-blue-600 dark:text-blue-400">{s.slipId}</td>
                <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{s.legCount}</td>
                <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{s.combinedOdds?.toFixed?.(1) ?? '—'}</td>
                <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{naira(s.potentialPayout)}</td>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5"><Dot tone={statusTone[s.status] ?? 'zinc'} /><span className="capitalize">{s.status}</span></span>
                  {s.failureReason && s.status === 'failed' && <span className="ml-1 text-xs text-red-500">· {s.failureReason.slice(0, 40)}</span>}
                </td>
                <td className="px-3 py-1.5">
                  {s.bookingCode ? (
                    <button onClick={(e) => { e.stopPropagation(); copy(s.bookingCode!) }} className="inline-flex items-center gap-1 font-mono text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200" title="copy booking code">
                      {s.bookingCode} {copied === s.bookingCode ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 opacity-50" />}
                    </button>
                  ) : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"><ArrowLeft className="h-4 w-4" /> Prev</button>
          <span className="px-2 text-xs text-zinc-500">page {page + 1} of {Math.ceil(total / PAGE)} · slips {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)}</span>
          <button onClick={() => setPage(p => (p + 1) * PAGE < total ? p + 1 : p)} disabled={(page + 1) * PAGE >= total}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">Next <ArrowLeft className="h-4 w-4 rotate-180" /></button>
        </div>
      )}

      {slipView && <SlipModal view={slipView} onClose={() => setSlipView(null)} onCopy={copy} copied={copied} />}
    </div>
  )
}

function SlipModal({ view, onClose, onCopy, copied }: { view: { slipId: number; loading: boolean; data?: SlipDetail }; onClose: () => void; onCopy: (s: string) => void; copied: string | null }) {
  const d = view.data
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="max-h-[85vh] w-full max-w-lg overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h3 className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">Slip #{view.slipId}</h3>
          {d && <span className={`inline-flex items-center gap-1.5 text-xs ${STATUS_CLS_TEXT[d.status] ?? 'text-zinc-500'}`}><Dot tone={statusTone[d.status] ?? 'zinc'} /><span className="capitalize">{d.status}</span></span>}
          <button onClick={onClose} className="ml-auto rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><XMark className="h-5 w-5" /></button>
        </div>
        {view.loading || !d ? <div className="py-10"><Spinner className="mx-auto h-6 w-6" /></div> : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-zinc-100 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <span>{d.legs.length} legs</span><span>odds {d.combinedOdds?.toFixed?.(1)}</span>
              <span>stake {naira(d.stake)}</span><span>payout <strong className="text-zinc-800 dark:text-zinc-200">{naira(d.payout)}</strong></span>
              {d.bookingCode && <button onClick={() => onCopy(d.bookingCode!)} className="inline-flex items-center gap-1 font-mono text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200">{d.bookingCode} {copied === d.bookingCode ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 opacity-50" />}</button>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {d.legs.map((l, i) => (
                <div key={l.fixtureId} className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 dark:border-zinc-800">
                  <span className="w-5 text-right text-xs text-zinc-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-zinc-800 dark:text-zinc-200">{l.game}</div>
                    <div className="text-xs text-zinc-400">{new Date(l.kickoff).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${l.side === 'Under' ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'}`}>{l.side} {l.line}</span>
                  <span className="w-12 text-right text-xs text-zinc-500">{l.odds}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const STATUS_CLS_TEXT: Record<string, string> = { placed: 'text-green-600 dark:text-green-400', won: 'text-green-600 dark:text-green-400', failed: 'text-red-600 dark:text-red-400', lost: 'text-zinc-500', pending: 'text-zinc-500' }

function Stat({ label, value, highlight, onClick, action }: { label: string; value: string; highlight?: boolean; onClick?: () => void; action?: boolean }) {
  const base = `rounded-xl border p-3 text-left ${highlight ? 'border-zinc-900 dark:border-zinc-100' : 'border-zinc-200 dark:border-zinc-700'}`
  const inner = (
    <>
      <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">{label}{action && <span className="text-zinc-400">›</span>}</div>
      <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{value}</div>
    </>
  )
  return onClick
    ? <button onClick={onClick} className={`${base} bg-white transition hover:border-zinc-400 dark:bg-zinc-900 dark:hover:border-zinc-500`}>{inner}</button>
    : <div className={base}>{inner}</div>
}

function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-2 font-medium">{children}</th> }

function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'info' | 'muted'; children: React.ReactNode }) {
  const cls = {
    ok: 'border-green-200 bg-green-50 text-green-800 dark:border-green-800/50 dark:bg-green-950/30 dark:text-green-300',
    warn: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200',
    info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300',
    muted: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400',
  }[tone]
  return <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${cls}`}>{children}</p>
}
