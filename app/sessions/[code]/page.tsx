'use client'

/**
 * app/sessions/[code]/page.tsx — one session, end to end. Everything is server-backed, so it survives
 * a refresh / closed laptop / crash: you come back to exactly the last state.
 *
 * Layout: numbers that matter → ONE "next step" panel (build ✓ → browser → place → results, showing
 * only the action that fits right now) → tabs for detail (slips, games, results, risk).
 *
 * Run state is DERIVED (no fragile client flags): running = status 'placing' + a fresh heartbeat;
 * stalled = 'placing' but the heartbeat went cold (the run died) — offer Resume; done = 0 pending.
 * Money shown per slip is the ACTUAL figure: what the site accepted at Confirm when captured, else
 * the shorter-combo reconciliation when a game was dropped, else the built number (labelled).
 */

import React, { Suspense, useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Copy, Check, Spinner, Download, Refresh, Play, StopIcon } from '@/components/Icons'
import { TotalsChart } from '@/components/TotalsChart'
import { CoverageTab } from '@/components/CoverageTab'
import { Page, PageHeader, Card, Stat, Button, LinkButton, Banner, Badge, StatusBadge, Progress, Tabs, Modal, Empty, naira, pct, ago, kickoff, cx, STATUS, inputCls } from '@/components/ui'

interface Actual { source: 'site' | 'reconciled' | 'built'; stake: number; odds: number; payout: number; legCount: number }
interface Slip { id: string; slipId: number; status: string; stake: number; combinedOdds: number; potentialPayout: number | null; legCount: number; bookingCode: string | null; betId: string | null; failureReason: string | null; won: boolean | null; returned: number | null; actual?: Actual }
interface Summary { slips: number; pending: number; placed: number; failed: number; skipped: number; verify: number; inFlight: number; won: number; lost: number; open: number; staked: number; settledStaked: number; returned: number; net: number }
interface Worker { workerId: string; host: string | null; account: string | null; live: boolean; state: string; currentSlip: number | null; placed: number; failed: number; lastSeenAgoMs: number }
interface VerifySlip { slipId: number; stake: number; legs: { game: string; outcome?: string }[]; submitStartedAt: string | null; lastError: string | null }
interface CutGame { order: number; game: string; overProb: number; ifOverCut: number; riskWeight: number }
interface CutRisk { worst: CutGame; expectedFinalAlive: number; top: CutGame[] }
interface BookMeta { cutRisk?: CutRisk | null; keepRate?: number; expectedNet?: number; variableLegs?: { min: number; max: number }; windowWarning?: string; withHistory?: number; pAnyWinCorrelated?: number; rhoStress?: number; note?: string; engine?: string; bot?: { rule: string; band: number; allowSubMinLegs: boolean; seed: number }; ceiling?: number; bonusSlips?: number; order?: string[] }
interface Session { code: string; status: string; budget: number; targetWin: number; minStake: number; legCount: number | null; slipCount: number | null; poolSize: number | null; bookIds: string[]; createdAt: string; updatedAt: string; dateFrom: string; dateTo: string; heartbeatAgeMs: number; expired: boolean; meta?: { pAnyWin?: number; windowMin?: number; stopRequested?: boolean; bookMetas?: Record<string, BookMeta> } | null }
interface BrowserState { up: boolean; loggedIn?: boolean; balance?: number | null; mode?: string }
interface Game { fixtureId: number; game: string; league: string; kickoff: string; line: number | null; underOdds: number | null; picks?: { name: string; count: number }[]; history: { date: string; total: number }[]; overRate: number | null; source?: string; outcome?: { finished: boolean; total: number | null; home?: number | null; away?: number | null; over: boolean | null } | null }
interface SurvGame { order: number; game: string; underOdds: number; finished: boolean; total: number | null; over: boolean | null; cut: number; aliveAfter: number; overSlips: number }
interface SurvLeague { league: string; games: number; overs: number; overRate: number | null; slipsCut: number }
interface Survival { alive: number; dead: number; total: number; finishedGames: number; ofGames: number; curve: SurvGame[]; leagues?: SurvLeague[]; winner?: { slipId: number; bookingCode: string | null; payout: number } | null }
interface SlipLeg { fixtureId: number; game: string; kickoff: string; line: number; side: string; pick?: string; odds: number; p?: number | null; why?: string | null; suspended?: boolean }
interface SlipDetail { slipId: number; status: string; stake: number; combinedOdds: number; payout: number | null; reconciledPayout?: number | null; bookingCode: string | null; betId: string | null; site?: { odds: number | null; stake: number | null; payout: number | null } | null; returned?: number | null; failureReason?: string | null; decision?: { why?: string; rule?: string; pWin?: number; keep?: number; bonusApplies?: boolean } | null; lastError?: string | null; legs: SlipLeg[] }

const HEARTBEAT_STALE_MS = 25_000
const PAGE = 50
type Tab = 'slips' | 'games' | 'survival' | 'risk'
const TABS: Tab[] = ['slips', 'games', 'survival', 'risk']

// useSearchParams needs a Suspense boundary (Next 16: required for production builds)
export default function SessionPageRoute() {
  return <Suspense fallback={<Page><div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-zinc-500"><Spinner /> Loading…</div></Page>}><SessionPage /></Suspense>
}

function SessionPage() {
  const code = String(useParams().code)
  const router = useRouter()
  const search = useSearchParams()
  const [session, setSession] = useState<Session | null>(null)
  const [slips, setSlips] = useState<Slip[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'warn' | 'info' | 'error' } | null>(null)
  const [busy, setBusy] = useState<null | 'dry' | 'live' | 'stop' | 'clone' | 'prep' | 'settle' | 'reconcile'>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // the tab lives in the URL (?tab=survival): it survives a refresh, can be shared, and Back works.
  // Old names (results, coverage) land on Survival, which merged them.
  const rawTab = search.get('tab')
  const tab: Tab = rawTab === 'results' || rawTab === 'coverage' ? 'survival' : TABS.includes(rawTab as Tab) ? rawTab as Tab : 'slips'
  const setTab = (t: Tab) => router.replace(t === 'slips' ? `/sessions/${code}` : `/sessions/${code}?tab=${t}`, { scroll: false })
  const [slipView, setSlipView] = useState<null | { slipId: number; loading: boolean; data?: SlipDetail }>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [windows, setWindows] = useState<'auto' | number>('auto')   // placement windows on this PC
  const [floorPct, setFloorPct] = useState(70)    // place a drifted payout down to this % of target (never below budget) — 70 default: at 100, 46% of one run was skipped for drift (docs/learnings.md)
  const [workersSeen, setWorkersSeen] = useState<Worker[]>([])
  const [filter, setFilterRaw] = useState('all')
  const [query, setQueryRaw] = useState('')
  const [sort, setSortRaw] = useState<{ by: string; dir: 'asc' | 'desc' }>({ by: 'slipId', dir: 'asc' })
  // any change to filter / search / sort goes back to the first page
  const setFilter = (v: string) => { setFilterRaw(v); setPage(0) }
  const setQuery = (v: string) => { setQueryRaw(v); setPage(0) }
  const setSort = (v: { by: string; dir: 'asc' | 'desc' }) => { setSortRaw(v); setPage(0) }
  const [notFound, setNotFound] = useState(false)

  // State is only set inside promise callbacks — never synchronously inside an effect.
  const load = useCallback(() => {
    const qs = new URLSearchParams({ offset: String(page * PAGE), limit: String(PAGE), status: filter, sort: sort.by, dir: sort.dir })
    if (query.trim()) qs.set('q', query.trim())
    return fetch(`/api/sessions/${code}?${qs}`)
      .then(r => r.status === 404 ? null : r.json())
      .then(s => {
        if (s == null) { setNotFound(true); setSession(null); return }
        if (s.session) { setSession(s.session); setSlips(s.slips ?? []); setSummary(s.summary); setTotal(s.page?.total ?? s.summary?.slips ?? 0); setWorkersSeen(s.workers ?? []) }
      })
      .catch(() => { /* keep last state */ })
  }, [code, page, filter, query, sort])
  const loadBrowser = useCallback(() => fetch('/api/browser').then(r => r.json())
    .then(b => setBrowser(b)).catch(() => setBrowser({ up: false })), [])
  useEffect(() => { void load(); void loadBrowser() }, [load, loadBrowser])

  // ── derived run state ──
  const pending = summary?.pending ?? 0
  const placed = summary?.placed ?? 0
  const allProcessed = summary != null && pending === 0
  const fresh = session ? session.heartbeatAgeMs < HEARTBEAT_STALE_MS : false   // server-computed (no clock read in render)
  const stopReq = Boolean(session?.meta?.stopRequested)
  const running = session?.status === 'placing' && !allProcessed && fresh && !stopReq
  const stopping = stopReq && fresh && !allProcessed
  const stalled = session?.status === 'placing' && !allProcessed && !fresh && !stopReq && placed > 0
  const liveReady = Boolean(browser?.up && browser.loggedIn && browser.mode !== 'SIM')

  useEffect(() => {
    if (allProcessed && !running) return
    const t = setInterval(() => { void load() }, running || stopping ? 3000 : 8000)
    return () => clearInterval(t)
  }, [allProcessed, running, stopping, load])

  const post = async (path: string, body?: unknown) => (await fetch(`/api/sessions/${code}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()

  async function prepareBrowser() {
    setBusy('prep'); setMsg(null)
    try {
      const j = await (await fetch('/api/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare' }) })).json()
      setBrowser(j.status ?? { up: false })
      setMsg({ text: `Browser: ${(j.steps ?? []).join(' → ')}`, tone: j.status?.loggedIn ? 'ok' : 'warn' })
    } catch { setMsg({ text: 'Could not prepare the browser.', tone: 'error' }) }
    finally { setBusy(null) }
  }
  async function place(live: boolean, join = false) {
    const cost = naira(pending * (session?.minStake ?? 10))
    if (live && !join && !confirm(`Place ${pending} slip(s) for REAL money (${cost})?\n\nThis is irreversible. Already-placed slips are skipped.`)) return
    setBusy(live ? 'live' : 'dry'); setMsg(null)
    try {
      if (join && !confirm(`Add THIS PC to the running placement?\n\nBoth PCs take slips from the same shared queue — no slip can be placed twice. Make sure this PC's browser is logged in (same or another account) and in REAL mode.`)) { setBusy(null); return }
      const j = await post('place', { live, join, browsers: windows, floorPct })
      type Win = { port: number; ok: boolean; note: string }
      const left = ((j.windows ?? []) as Win[]).filter(w => !w.ok)
      const wins = live ? ` in ${j.browsers} window${j.browsers === 1 ? '' : 's'}${left.length ? ` (left out: ${left.map(w => `:${w.port} ${w.note}`).join(', ')})` : ''}` : ''
      setMsg(j.error ? { text: j.error, tone: 'error' } : join ? { text: `This PC joined the run${wins} — ${j.pending} slip(s) left in the shared queue.`, tone: 'info' } : { text: live ? `Placing ${j.pending} slip(s) for real${wins} — progress updates below.` : `Dry-run started for ${j.pending} slip(s): nothing is staked; watch the placer window to verify each slip loads correctly.`, tone: live ? 'info' : left.length ? 'warn' : 'ok' })
      await load()
    } catch { setMsg({ text: 'Network error starting placement.', tone: 'error' }) }
    finally { setBusy(null) }
  }
  async function stop() {
    setBusy('stop')
    try { await post('stop'); setMsg({ text: 'Stop requested — the run halts after the current slip. Resume any time.', tone: 'info' }); await load() }
    finally { setBusy(null) }
  }
  async function clone() {
    setBusy('clone')
    try { const j = await post('clone'); if (j.session) setMsg({ text: `Duplicated → ${j.session.code}. Open it to place the same slips on another account.`, tone: 'ok' }) }
    finally { setBusy(null) }
  }
  async function settle() {
    setBusy('settle'); setMsg(null)
    try {
      const j = await post('settle')
      setMsg(j.error ? { text: j.error, tone: 'error' } : j.checked === 0 ? { text: j.note ?? 'Nothing to settle yet.', tone: 'info' }
        : { text: `${j.gamesFinished}/${j.of} games finished · settled ${j.settled} slip(s) (won ${j.won}, lost ${j.lost}) · ${j.pending} still in play.`, tone: j.won > 0 ? 'ok' : 'info' })
      await load()
    } catch { setMsg({ text: 'Could not check results.', tone: 'error' }) }
    finally { setBusy(null) }
  }
  async function reconcile() {
    setBusy('reconcile'); setMsg(null)
    try {
      const j = await post('reconcile')
      setMsg(j.error ? { text: j.error, tone: 'error' } : { text: j.affected ? `${j.affected} placed slip(s) had a game suspended — their payout is now the shorter-slip amount.` : 'No suspended games — every placed slip is intact.', tone: 'ok' })
      await load()
    } catch { setMsg({ text: 'Could not reconcile.', tone: 'error' }) }
    finally { setBusy(null) }
  }
  function copy(text: string) { navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(null), 1200) }) }
  async function openSlip(slipId: number) {
    setSlipView({ slipId, loading: true })
    try { const data = await fetch(`/api/sessions/${code}/slip?slipId=${slipId}`).then(r => r.json()); setSlipView({ slipId, loading: false, data }) }
    catch { setSlipView({ slipId, loading: false }) }
  }

  if (notFound) return <Page><Empty title={`Session ${code} not found`} action={<LinkButton href="/">Back to sessions</LinkButton>} /></Page>
  if (!session || !summary) return <Page><div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-zinc-500"><Spinner /> Loading {code}…</div></Page>

  const meta = session.meta?.bookMetas ? Object.values(session.meta.bookMetas)[0] : undefined
  const slipTotal = Math.max(1, session.slipCount ?? summary.slips)
  const stageKey = running ? 'running' : stopping ? 'placing' : stalled ? 'stalled' : placed === 0 ? (session.expired ? 'expired' : 'ready') : pending > 0 ? 'stopped' : summary.open > 0 ? 'placed' : summary.won > 0 ? 'won' : 'done'

  return (
    <Page>
      <PageHeader back={{ href: '/', label: 'Sessions', current: session.code }}
        title={<span className="font-mono">{session.code}</span>}
        badge={<StatusBadge status={stageKey} />}
        subtitle={<>{session.bookIds.join(', ')} · games {session.dateFrom}{session.dateTo !== session.dateFrom ? ` → ${session.dateTo}` : ''} · built {ago(session.createdAt)}</>}
        actions={<>
          <Button size="sm" onClick={clone} loading={busy === 'clone'} icon={<Copy className="h-3.5 w-3.5" />}>Duplicate</Button>
          <LinkButton size="sm" href={`/sessions/${code}/print`} target="_blank"><Download className="h-3.5 w-3.5" /> PDF</LinkButton>
        </>} />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Budget → target" value={<>{naira(session.budget)} <span className="text-zinc-400">→</span> {naira(session.targetWin)}</>} hint={`${slipTotal.toLocaleString()} slips × ${naira(session.minStake)}${meta?.variableLegs ? ` · ${meta.variableLegs.min}–${meta.variableLegs.max} legs` : session.legCount ? ` · ${session.legCount} legs` : ''}`} />
        <Stat label="Chance ≥ 1 slip wins" value={pct(session.meta?.pAnyWin)} hint="modelled for these slips" tone="accent" />
        <Stat label="Returns per ₦100 (avg)" value={meta?.keepRate != null ? `₦${Math.round(meta.keepRate * 100)}` : '—'} hint="bookmaker's price — below ₦100 = house edge" />
        <Stat label="Net (settled)" value={summary.won + summary.lost > 0 ? naira(summary.net) : '—'} tone={summary.net > 0 ? 'pos' : summary.net < 0 ? 'neg' : undefined}
          hint={summary.open > 0 ? `${naira(summary.staked - summary.settledStaked)} still in play` : summary.placed ? `${naira(summary.staked)} staked` : 'nothing placed yet'} />
      </div>

      {meta?.windowWarning && <div className="mb-5"><Banner tone="warn">{meta.windowWarning}</Banner></div>}

      {/* ── the one next step ── */}
      <Card className="mb-5" pad={false}>
        <Steps steps={[
          { label: 'Built', state: 'done', detail: `${slipTotal} slips` },
          { label: 'Browser', state: liveReady || placed > 0 ? 'done' : 'active', detail: browser == null ? 'checking…' : browser.up ? (browser.loggedIn ? `${browser.mode ?? '—'} · ${naira(browser.balance)}` : 'not logged in') : 'not running' },
          { label: 'Place', state: allProcessed ? 'done' : (liveReady || placed > 0) ? 'active' : 'todo', detail: `${placed}/${slipTotal} placed` },
          { label: 'Results', state: placed > 0 && summary.open === 0 && allProcessed ? 'done' : placed > 0 ? 'active' : 'todo', detail: summary.won + summary.lost > 0 ? `${summary.won} won · ${summary.lost} lost` : placed > 0 ? `${summary.open} in play` : '—' },
        ]} />
        <div className="border-t border-zinc-100 p-5 dark:border-zinc-800">
          <Progress total={slipTotal} parts={[
            { value: summary.won, className: 'bg-emerald-500', label: 'won' },
            { value: placed - summary.won, className: 'bg-sky-500', label: 'placed' },
            { value: summary.failed, className: 'bg-red-400', label: 'failed' },
            { value: summary.skipped, className: 'bg-zinc-300 dark:bg-zinc-600', label: 'skipped' },
          ]} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <Legend c="bg-sky-500" t={`${placed} placed`} />
            {summary.won > 0 && <Legend c="bg-emerald-500" t={`${summary.won} won`} />}
            {pending > 0 && <Legend c="bg-zinc-200 dark:bg-zinc-700" t={`${pending} to place`} />}
            {summary.failed > 0 && <Legend c="bg-red-400" t={`${summary.failed} failed`} />}
            {summary.skipped > 0 && <Legend c="bg-zinc-300 dark:bg-zinc-600" t={`${summary.skipped} skipped`} />}
            {placed > 0 && <span className="ml-auto">staked <strong className="text-zinc-700 dark:text-zinc-200">{naira(summary.staked)}</strong>{summary.returned > 0 && <> · returned <strong className="text-emerald-600">{naira(summary.returned)}</strong></>}</span>}
          </div>

          <div className="mt-5">
            {running || stopping ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200"><Spinner /> {stopping ? 'Stopping after the current slip…' : `Placing — ${pending} to go`}</span>
                <div className="ml-auto flex flex-wrap justify-end gap-2">
                  {!stopping && <WindowsPicker value={windows} onChange={setWindows} pending={pending} />}
                  {!stopping && <FloorPicker value={floorPct} onChange={setFloorPct} />}
                  {!stopping && <Button onClick={() => place(true, true)} loading={busy === 'live'} disabled={busy != null || !liveReady} title={liveReady ? 'Place from this PC too — the shared queue prevents double placing' : 'Prepare this PC\'s browser first'}>Add this PC</Button>}
                  <Button variant="danger" onClick={stop} loading={busy === 'stop'} disabled={stopping} icon={<StopIcon className="h-3.5 w-3.5" />}>Stop (all PCs)</Button>
                </div>
              </div>
            ) : pending > 0 ? (
              <div className="space-y-3">
                {stalled && <Banner tone="warn" title="The last run stopped unexpectedly">The browser closed, the PC slept or it crashed. {placed} slip(s) are safely placed. Resume here or on any other PC — unfinished slips return to the shared queue within 3 minutes, and a slip that was mid-submit is checked against bet history before anything is re-placed.</Banner>}
                {!liveReady && (
                  <Banner tone="muted" title="Get the browser ready first"
                    action={<Button variant="primary" onClick={prepareBrowser} loading={busy === 'prep'} icon={<Play className="h-3 w-3" />}>Prepare browser</Button>}>
                    Opens the placement Chrome and logs in to SportyBet. Then check it shows <strong>REAL</strong> mode in that window (the app never switches it for you).
                  </Banner>
                )}
                {liveReady && <ModeShots />}
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => place(false)} loading={busy === 'dry'} disabled={busy != null}>Dry run</Button>
                  <WindowsPicker value={windows} onChange={setWindows} pending={pending} />
                  <FloorPicker value={floorPct} onChange={setFloorPct} />
                  <Button variant="go" size="lg" className="ml-auto" onClick={() => place(true)} loading={busy === 'live'} disabled={busy != null || !liveReady}
                    title={liveReady ? '' : 'Prepare the browser first'} icon={<Play className="h-3.5 w-3.5" />}>
                    {placed > 0 ? 'Resume' : 'Place'} {pending} slip{pending === 1 ? '' : 's'} · {naira(pending * session.minStake)}
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">Every slip is checked on the betslip before Confirm and recorded with the site&apos;s own numbers. <strong>Windows</strong> places in parallel on this PC (each window has its own betslip; about 12s per slip per window). One account submits one slip at a time, so about 4 windows is the most that helps per account — for more speed, add a PC with another SportyBet account and press <strong>Add this PC</strong>. The shared queue makes sure no slip is placed twice. <strong>Floor</strong> controls what happens when the site&apos;s odds have moved since the build: at 100% a slip below target is skipped (nothing staked); below 100%, it&apos;s still placed as long as the payout is at or above that % of target and never below the session budget.</p>
              </div>
            ) : placed > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-700 dark:text-zinc-300">{summary.open > 0 ? 'All slips are placed. Check results as games finish — slips settle the moment one leg is decided.' : 'Every placed slip is settled.'}</span>
                <div className="ml-auto flex flex-wrap justify-end gap-2">
                  <Button onClick={reconcile} loading={busy === 'reconcile'} icon={<Refresh className="h-3.5 w-3.5" />}>Check suspended games</Button>
                  <Button variant="primary" onClick={settle} loading={busy === 'settle'} icon={<Check className="h-3.5 w-3.5" />}>Check results</Button>
                </div>
              </div>
            ) : (
              <Banner tone="warn" title="Nothing was placed">Every slip failed or was skipped. Open a failed slip to see why, then build a fresh session.</Banner>
            )}
          </div>
          {summary.verify > 0 && <VerifyPanel code={code} onDone={() => { void load() }} />}
          {workersSeen.length > 0 && <WorkersRoster workers={workersSeen} />}
          {msg && <div className="mt-4"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
        </div>
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'slips', label: 'Slips', count: summary.slips || slipTotal },
        { id: 'games', label: 'Games', count: session.poolSize ?? undefined },
        { id: 'survival', label: 'Survival' },
        { id: 'risk', label: 'Risk' },
      ]} />
      <div className="mt-4">
        {tab === 'slips' && <SlipsTab slips={slips} summary={summary} total={total} page={page} setPage={setPage} filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} sort={sort} setSort={setSort} onOpen={openSlip} onCopy={copy} copied={copied} />}
        {tab === 'games' && <GamesTab code={code} />}
        {tab === 'survival' && <div className="space-y-6"><CoverageTab code={code} />{placed > 0 && <ResultsTab code={code} placed={placed} />}</div>}
        {tab === 'risk' && <RiskTab code={code} cutRisk={meta?.cutRisk ?? null} note={meta?.note} stress={meta?.pAnyWinCorrelated} headline={session.meta?.pAnyWin} bot={meta?.engine === 'decision_bot' ? meta : undefined} />}
      </div>

      {slipView && <SlipModal view={slipView} onClose={() => setSlipView(null)} onCopy={copy} copied={copied} />}
    </Page>
  )
}

function Legend({ c, t }: { c: string; t: string }) { return <span className="inline-flex items-center gap-1.5"><span className={cx('h-2 w-2 rounded-full', c)} />{t}</span> }

function Steps({ steps }: { steps: { label: string; state: 'done' | 'active' | 'todo'; detail: string }[] }) {
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-t-2xl bg-zinc-100 sm:grid-cols-4 dark:bg-zinc-800">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-3 bg-white px-4 py-3.5 dark:bg-zinc-900">
          <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
            s.state === 'done' ? 'bg-emerald-500 text-white' : s.state === 'active' ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800')}>
            {s.state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <div className="min-w-0">
            <div className={cx('text-sm font-medium', s.state === 'todo' ? 'text-zinc-400' : 'text-zinc-900 dark:text-zinc-100')}>{s.label}</div>
            <div className="truncate text-xs text-zinc-500">{s.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

// ── Slips tab ──────────────────────────────────────────────────────────────────
function SlipsTab(p: { slips: Slip[]; summary: Summary; total: number; page: number; setPage: (f: (n: number) => number) => void; filter: string; setFilter: (s: string) => void; query: string; setQuery: (s: string) => void; sort: { by: string; dir: 'asc' | 'desc' }; setSort: (s: { by: string; dir: 'asc' | 'desc' }) => void; onOpen: (id: number) => void; onCopy: (s: string) => void; copied: string | null }) {
  const counts: Record<string, number> = { placed: p.summary.placed - p.summary.won - p.summary.lost, won: p.summary.won, lost: p.summary.lost, pending: p.summary.pending, failed: p.summary.failed, skipped: p.summary.skipped, verify: p.summary.verify }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['all', 'pending', 'placed', 'won', 'lost', 'failed', 'skipped', 'verify'] as const).map(f => (
            <button key={f} onClick={() => p.setFilter(f)}
              className={cx('rounded-full px-3 py-1 text-xs font-medium transition', p.filter === f ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700')}>
              {f === 'all' ? 'All' : STATUS[f]?.label ?? f}{f !== 'all' && counts[f] ? ` ${counts[f]}` : ''}
            </button>
          ))}
        </div>
        <input value={p.query} onChange={e => p.setQuery(e.target.value)} placeholder="Booking code or slip #" className={cx(inputCls, 'ml-auto h-8 w-48 text-xs')} />
      </div>
      {p.slips.length === 0 ? <Empty title="No slips match" /> : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
              <tr>
                <SortTh k="slipId" {...p}>#</SortTh>
                <SortTh k="legs" {...p}>Legs</SortTh>
                <SortTh k="odds" {...p}>Odds</SortTh>
                <SortTh k="payout" {...p}>Pays if it wins</SortTh>
                <SortTh k="status" {...p}>Status</SortTh>
                <th className="px-4 py-2.5 font-medium">Booking code</th>
              </tr>
            </thead>
            <tbody>
              {p.slips.map(s => {
                const a = s.actual
                const changed = a && a.source !== 'built' && (Math.abs(a.payout - (s.potentialPayout ?? 0)) > 1 || a.legCount !== s.legCount)
                return (
                  <tr key={s.id} onClick={() => p.onOpen(s.slipId)} className="cursor-pointer border-t border-zinc-100 transition hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">{s.slipId}</td>
                    <td className="px-4 py-2.5 tabular-nums">{a?.legCount ?? s.legCount}{changed && a!.legCount !== s.legCount && <span className="ml-1 text-xs text-zinc-400 line-through">{s.legCount}</span>}</td>
                    <td className="px-4 py-2.5 tabular-nums">{(a?.odds ?? s.combinedOdds)?.toFixed?.(1)}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{naira(a?.payout ?? s.potentialPayout)}</span>
                      {a?.source === 'site' && <span title="Amount confirmed on the SportyBet betslip at placement" className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600">site</span>}
                      {a?.source === 'reconciled' && <span title="A game was suspended — this is the shorter slip's payout" className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-600">adjusted</span>}
                      {changed && <span className="ml-1.5 text-xs text-zinc-400 line-through">{naira(s.potentialPayout)}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={s.status} />
                      {s.status === 'won' && s.returned != null && <span className="ml-2 text-xs font-medium text-emerald-600">{naira(s.returned)}</span>}
                      {s.failureReason && (s.status === 'failed' || s.status === 'skipped') && <div className="mt-0.5 max-w-[16rem] truncate text-[11px] text-zinc-500" title={s.failureReason}>{s.failureReason}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.bookingCode ? (
                        <button onClick={e => { e.stopPropagation(); p.onCopy(s.bookingCode!) }} className="inline-flex items-center gap-1 font-mono text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100" title="Copy booking code">
                          {s.bookingCode} {p.copied === s.bookingCode ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 opacity-40" />}
                        </button>
                      ) : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {p.total > PAGE && (
        <div className="mt-3 flex items-center justify-center gap-3 text-sm">
          <Button size="sm" onClick={() => p.setPage(n => Math.max(0, n - 1))} disabled={p.page === 0}>← Prev</Button>
          <span className="text-xs text-zinc-500">{p.page * PAGE + 1}–{Math.min(p.total, (p.page + 1) * PAGE)} of {p.total}</span>
          <Button size="sm" onClick={() => p.setPage(n => (n + 1) * PAGE < p.total ? n + 1 : n)} disabled={(p.page + 1) * PAGE >= p.total}>Next →</Button>
        </div>
      )}
    </>
  )
}

function SortTh({ k, sort, setSort, children }: { k: string; sort: { by: string; dir: 'asc' | 'desc' }; setSort: (s: { by: string; dir: 'asc' | 'desc' }) => void; children: React.ReactNode }) {
  const active = sort.by === k
  return (
    <th className="px-4 py-2.5 font-medium">
      <button onClick={() => setSort({ by: k, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })} className={cx('inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100', active && 'text-zinc-900 dark:text-zinc-100')}>
        {children}<span className="text-[9px] opacity-60">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  )
}

// ── Games tab ──────────────────────────────────────────────────────────────────
function GamesTab({ code }: { code: string }) {
  const [games, setGames] = useState<Game[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback(() => fetch(`/api/sessions/${code}/games`).then(r => r.json()).then(j => setGames(j.games ?? [])).catch(() => setGames([])), [code])
  useEffect(() => { void load() }, [load])
  async function fetchHistory() {
    setBusy(true); setNote(null)
    try {
      const j = await (await fetch(`/api/sessions/${code}/fetch-history`, { method: 'POST' })).json()
      setNote(j.error ?? `Synced ${j.processed}/${j.games} games · ${j.withH2H} with head-to-head · ${j.rows} matches stored.${j.requests?.blocked || j.requests?.failed ? ` ⚠ ${j.requests.blocked} request(s) blocked, ${j.requests.failed} failed — some history may be missing.` : ''}${j.more ? ' Run again for the rest.' : ''}`)
      await load()
    } catch { setNote('Could not fetch history (the debug Chrome must be running).') } finally { setBusy(false) }
  }
  if (games == null) return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Spinner /> Loading games…</div>
  const withHist = games.filter(g => g.history.length).length
  return (
    <Card pad={false} title={`${games.length} games in this session`} subtitle={`${withHist}/${games.length} have match history · bars = total goals in past matches (red = 5+)`}
      action={<Button size="sm" onClick={fetchHistory} loading={busy} icon={<Download className="h-3.5 w-3.5" />}>Sync history</Button>}>
      {note && <div className="px-5 pt-4"><Banner tone="muted">{note}</Banner></div>}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {games.map((g, i) => (
          <div key={g.fixtureId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <span className="w-5 text-right text-xs text-zinc-400">{i + 1}</span>
            <div className="min-w-[10rem] flex-1">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{g.game}</div>
              <div className="text-xs text-zinc-500">{g.league} · {kickoff(g.kickoff)}</div>
            </div>
            <TotalsChart history={g.history} />
            <div className="w-40 text-right text-xs">
              {g.picks && g.picks.length > 0 && <div className="mb-1 text-[11px] text-zinc-500">{g.picks.slice(0, 3).map(p => `${p.name} ×${p.count}`).join(' · ')}</div>}
              {g.outcome?.finished
                ? <Badge tone={g.outcome.over ? 'red' : 'zinc'}>FT {g.outcome.home != null ? `${g.outcome.home}–${g.outcome.away}` : `${g.outcome.total} goals`}</Badge>
                : g.line != null ? <span className="text-zinc-500">Under {g.line} @ {g.underOdds}</span> : <span className="text-zinc-400">not played yet</span>}
              {g.overRate != null && <div className="mt-0.5 text-[11px] text-zinc-500">{Math.round(g.overRate * 100)}% of past games had 5+</div>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Results tab (survival) ─────────────────────────────────────────────────────
function ResultsTab({ code, placed }: { code: string; placed: number }) {
  const [s, setS] = useState<Survival | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => fetch(`/api/sessions/${code}/survival`).then(r => r.json()).then(j => { if (!j.error) setS(j) }).catch(() => { /* keep last */ }), [code])
  const refresh = () => { setBusy(true); void load().finally(() => setBusy(false)) }
  useEffect(() => { if (placed > 0) void load() }, [load, placed])
  if (placed === 0) return <Empty title="No slips placed yet">Results appear here once slips are placed and games start finishing.</Empty>
  if (!s) return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Spinner /> Loading results…</div>
  return (
    <div className="space-y-4">
      {s.winner && <Banner tone="ok" title={`Winning slip #${s.winner.slipId} — ${naira(s.winner.payout)}`}>Booking code {s.winner.bookingCode}</Banner>}
      <Card pad={false} title="Slips still alive as each game finishes" subtitle={`${s.alive}/${s.total} alive · ${s.finishedGames}/${s.ofGames} games finished`}
        action={<Button size="sm" onClick={refresh} loading={busy} icon={<Refresh className="h-3.5 w-3.5" />}>Refresh</Button>}>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {s.curve.map(c => (
            <div key={c.order} className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm', !c.finished && 'opacity-55')}>
              <span className="w-5 text-right text-xs text-zinc-400">{c.order}</span>
              <span className="min-w-[10rem] flex-1 text-zinc-900 dark:text-zinc-100">{c.game}</span>
              {c.finished ? <Badge tone={c.over ? 'red' : 'green'}>FT {c.total}</Badge> : <span className="text-xs text-zinc-400">not finished</span>}
              <span className="w-36 text-right text-xs tabular-nums">
                {c.finished ? <><span className="text-red-500">−{c.cut}</span> → <strong className="text-zinc-800 dark:text-zinc-200">{c.aliveAfter} alive</strong></> : <span className="text-zinc-400">—</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
      {s.leagues && s.leagues.length > 0 && (
        <Card title="By league (finished games)" subtitle="Which competitions cut the most slips — the learning loop's evidence.">
          <div className="space-y-1.5 text-sm">
            {s.leagues.map(l => (
              <div key={l.league} className="flex items-center gap-3">
                <span className="w-16 text-xs tabular-nums text-zinc-500">{l.overs}/{l.games} 5+</span>
                <span className="w-20 text-xs text-zinc-500">cut {l.slipsCut}</span>
                <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">{l.league}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Risk tab ───────────────────────────────────────────────────────────────────
function RiskTab({ code, cutRisk, note, stress, headline, bot }: { code: string; cutRisk: CutRisk | null; note?: string; stress?: number; headline?: number; bot?: BookMeta }) {
  const [ai, setAi] = useState<{ text: string; source: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function analyze() {
    setBusy(true)
    try { const j = await (await fetch(`/api/sessions/${code}/analyze`, { method: 'POST' })).json(); setAi({ text: j.summary ?? j.error ?? '—', source: j.source ?? '' }) }
    catch { setAi({ text: 'Could not run analysis.', source: '' }) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4">
      <Card title="Plain-language risk read" subtitle="Which games threaten the most slips. Advisory only — it can't change the odds."
        action={<Button size="sm" onClick={analyze} loading={busy}>{ai ? 'Re-run' : 'Analyse'}</Button>}>
        {ai ? <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{ai.text}{ai.source && <Badge className="ml-2">{ai.source}</Badge>}</p>
          : <p className="text-sm text-zinc-500">Run it to get a short, honest summary of this session&apos;s exposure.</p>}
      </Card>
      {cutRisk && (
        <Card title="Most exposed games" subtitle={`If one of these goes 5+ goals it cuts that many slips at once · expected slips alive at the end ${cutRisk.expectedFinalAlive.toFixed(2)}`}>
          <div className="space-y-1.5 text-sm">
            {cutRisk.top.map(g => (
              <div key={g.order} className="flex items-center gap-3">
                <span className="w-14 text-xs tabular-nums text-zinc-500">{Math.round(g.overProb * 100)}% 5+</span>
                <span className="w-24 text-xs text-zinc-500">cuts {g.ifOverCut}</span>
                <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">{g.game}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {bot?.bot && (
        <Card title="How the Decision Bot built this session" subtitle="Open any slip to see the reason for every pick.">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-zinc-500">Rule</dt><dd className="font-medium capitalize">{bot.bot.rule}</dd></div>
            <div><dt className="text-xs text-zinc-500">Payout band</dt><dd className="font-medium">target +{(100 * bot.bot.band).toFixed(1)}%</dd></div>
            <div><dt className="text-xs text-zinc-500">Legs under 1.20</dt><dd className="font-medium">{bot.bot.allowSubMinLegs ? 'allowed (they don&apos;t count toward the bonus)' : 'not used'}</dd></div>
            <div><dt className="text-xs text-zinc-500">Seed</dt><dd className="font-mono text-xs">{bot.bot.seed}</dd></div>
          </dl>
          {bot.bonusSlips != null && <p className="mt-3 text-xs text-zinc-500">{bot.bonusSlips} slip(s) kept the bonus. Win chance {pct(headline, 2)} vs the price ceiling {pct(bot.ceiling, 2)} (the gap is overlap between slips that couldn&apos;t be removed).</p>}
          {bot.order && <p className="mt-2 text-xs text-zinc-500">Game order: {bot.order.slice(0, 8).join(' → ')}{bot.order.length > 8 ? ' → …' : ''}</p>}
        </Card>
      )}
      {stress != null && (
        <Card title="If games move together" subtitle="A stress figure, not a forecast.">
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            The headline chance ({pct(headline)}) prices the games the way the bookmaker does — independently. If goals really
            clustered across games on the same day as strongly as our earlier backtest suggested, these same slips would land
            at least once about <strong>{pct(stress)}</strong> of the time. Treat that as optimistic: taken at face value it implies the
            bookmaker underprices accumulators, which its own prices (and our settled results so far) don&apos;t support.
          </p>
        </Card>
      )}
      {note && (
        <Card title="How this session was built">
          <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{note}</p>
        </Card>
      )}
    </div>
  )
}

// ── Slip detail ────────────────────────────────────────────────────────────────
function SlipModal({ view, onClose, onCopy, copied }: { view: { slipId: number; loading: boolean; data?: SlipDetail }; onClose: () => void; onCopy: (s: string) => void; copied: string | null }) {
  const d = view.data
  const live = d?.legs.filter(l => !l.suspended) ?? []
  const actualPay = d?.site?.payout ?? d?.reconciledPayout ?? d?.payout ?? null
  const differs = d && actualPay != null && d.payout != null && Math.abs(actualPay - d.payout) > 1
  return (
    <Modal onClose={onClose} title={<>Slip <span className="font-mono">#{view.slipId}</span></>} headerExtra={d && <StatusBadge status={d.status} />}>
      {view.loading || !d ? <div className="flex justify-center py-12"><Spinner className="h-6 w-6" /></div> : (
        <>
          <div className="grid grid-cols-3 gap-px bg-zinc-100 text-center dark:bg-zinc-800">
            <Cell k="Stake" v={naira(d.site?.stake ?? d.stake)} />
            <Cell k="Odds" v={(d.site?.odds ?? d.combinedOdds)?.toFixed?.(2) ?? '—'} />
            <Cell k={d.status === 'won' ? 'Returned' : 'Pays if it wins'} v={naira(d.status === 'won' ? d.returned : actualPay)} strong />
          </div>
          <div className="space-y-2 border-b border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
            {d.site ? <div className="text-emerald-700 dark:text-emerald-400">✓ Amounts confirmed on the SportyBet betslip at placement.</div>
              : d.status === 'pending' ? <div>Built figures — the site&apos;s own numbers are recorded when this slip is placed.</div>
                : <div>Built figures (placed before site receipts were recorded).</div>}
            {differs && <div>Built payout was {naira(d.payout)} — the difference comes from {d.legs.some(l => l.suspended) ? 'a suspended game dropped from the slip' : 'odds moving before placement'}.</div>}
            {d.decision?.why && <div className="rounded-lg bg-zinc-50 px-3 py-2 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"><span className="font-medium">Why this slip: </span>{d.decision.why}{d.decision.pWin != null && <> · wins {(100 * d.decision.pWin).toFixed(4)}% alone</>}</div>}
            {d.failureReason && <div className="text-red-600 dark:text-red-400">{d.failureReason}</div>}
            {d.bookingCode && (
              <button onClick={() => onCopy(d.bookingCode!)} className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 font-mono text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200">
                {d.bookingCode} {copied === d.bookingCode ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 opacity-50" />}
              </button>
            )}
          </div>
          <div className="px-5 py-2 text-xs font-medium text-zinc-500">{live.length} legs{live.length !== d.legs.length && ` (${d.legs.length - live.length} dropped)`}</div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.legs.map((l, i) => (
              <div key={l.fixtureId} className={cx('flex items-center gap-3 px-5 py-2.5 text-sm', l.suspended && 'opacity-50')}>
                <span className="w-5 text-right text-xs text-zinc-400">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className={cx('truncate text-zinc-900 dark:text-zinc-100', l.suspended && 'line-through')}>{l.game}</div>
                  <div className="text-xs text-zinc-500">{kickoff(l.kickoff)}{l.p != null && <> · {(100 * l.p).toFixed(1)}% likely</>}</div>
                  {l.why && <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{l.why}</div>}
                </div>
                {l.suspended ? <Badge tone="amber">dropped</Badge> : <Badge tone="blue">{l.pick ?? `${l.side} ${l.line}`}</Badge>}
                <span className="w-12 text-right text-xs tabular-nums text-zinc-500">{l.odds}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

function Cell({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="bg-white px-3 py-3 dark:bg-zinc-900"><div className="text-[11px] text-zinc-500">{k}</div><div className={cx('mt-0.5 tabular-nums', strong ? 'text-base font-semibold text-zinc-900 dark:text-zinc-50' : 'text-sm font-medium text-zinc-800 dark:text-zinc-200')}>{v}</div></div>
}

// ── slips whose worker vanished mid-submit: resolve against bet history ─────────
function VerifyPanel({ code, onDone }: { code: string; onDone: () => void }) {
  const [list, setList] = useState<VerifySlip[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const load = useCallback(() => fetch(`/api/sessions/${code}/verify`).then(r => r.json()).then(j => setList(j.slips ?? [])).catch(() => setList([])), [code])
  useEffect(() => { void load() }, [load])
  async function resolve(slipId: number, placed: boolean) {
    setBusy(slipId)
    try { await fetch(`/api/sessions/${code}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slipId, placed, note: placed ? 'confirmed on bet history by hand' : 'not on bet history (checked by hand)' }) }); await load(); onDone() }
    finally { setBusy(null) }
  }
  return (
    <div className="mt-4">
      <Banner tone="warn" title={`${list?.length ?? '…'} slip(s) need checking against your SportyBet bet history`}>
        Their placing PC stopped in the middle of submitting, so they may or may not have been placed. They are never re-placed on a guess:
        the placer checks bet history automatically when it next starts, or you can check SportyBet yourself and resolve each one here.
      </Banner>
      {list && list.length > 0 && (
        <div className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white text-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {list.map(v => (
            <div key={v.slipId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="font-mono text-xs text-zinc-500">#{v.slipId}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-600 dark:text-zinc-400">{v.legs.slice(0, 3).map(l => `${l.game}${l.outcome ? `: ${l.outcome}` : ''}`).join(' · ')}{v.legs.length > 3 ? ` · +${v.legs.length - 3} more` : ''}</span>
              {v.submitStartedAt && <span className="text-[11px] text-zinc-400">submitted {new Date(v.submitStartedAt).toLocaleTimeString()}</span>}
              <Button size="sm" onClick={() => resolve(v.slipId, true)} loading={busy === v.slipId}>It is on bet history</Button>
              <Button size="sm" onClick={() => resolve(v.slipId, false)} disabled={busy === v.slipId}>Not there — re-queue</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── REAL/SIM check: a screenshot of each open window's toggle (the page's markup can't be trusted) ──
function ModeShots() {
  const [ports, setPorts] = useState<number[]>([])
  const [nonce, setNonce] = useState(() => Date.now())
  useEffect(() => {
    let off = false
    fetch('/api/browser?windows=1').then(r => r.json()).then(j => { if (!off) setPorts((j.windows ?? []).filter((w: { up: boolean }) => w.up).map((w: { port: number }) => w.port)) }).catch(() => {})
    return () => { off = true }
  }, [nonce])
  if (!ports.length) return null
  return (
    <div className="rounded-xl border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
      <div className="mb-1.5 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">REAL / SIM check</span>
        <span>each window&apos;s toggle as it looks right now — REAL must be the highlighted side</span>
        <button className="ml-auto text-sky-600 hover:underline" onClick={() => setNonce(Date.now())}>Refresh</button>
      </div>
      <div className="flex flex-wrap gap-3">
        {ports.map(p => (
          <figure key={p} className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a live local screenshot, not a static asset */}
            <img src={`/api/browser?shot=${p}&fresh=1&t=${nonce}`} alt={`REAL/SIM toggle of window :${p}`} className="h-7 rounded border border-zinc-200 dark:border-zinc-700" />
            <figcaption className="text-zinc-500">:{p}{p === 9222 ? ' main' : ''}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

// ── how many placement windows to use on this PC ───────────────────────────────
function WindowsPicker({ value, onChange, pending }: { value: 'auto' | number; onChange: (v: 'auto' | number) => void; pending: number }) {
  const auto = Math.min(4, Math.max(1, Math.ceil(pending / 50)))
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400" title="Parallel placement windows on this PC — each has its own betslip; all share the queue">
      Windows
      <select value={String(value)} onChange={e => onChange(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
        className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
        <option value="auto">Auto ({auto})</option>
        {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  )
}

// ── how far a drifted payout may fall below target and still be placed (never below budget) ────
function FloorPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400"
      title="If the site's odds moved since the build, place anyway as long as the payout is still at least this % of target (and never below the session budget). 100% = only place at/above the exact target. Default 70%.">
      Floor
      <select value={String(value)} onChange={e => onChange(Number(e.target.value))}
        className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
        <option value="100">100% (exact target)</option>
        <option value="75">75% of target</option>
        <option value="70">70% of target (default)</option>
        <option value="50">50% of target</option>
        <option value="25">25% of target</option>
      </select>
    </label>
  )
}

// ── which PCs are placing this session right now (shared queue) ─────────────────
function WorkersRoster({ workers }: { workers: Worker[] }) {
  const alive = workers.filter(w => w.lastSeenAgoMs < 30_000 && w.state === 'running')
  const byHost = new Map<string, Worker[]>()
  for (const w of workers) { const k = w.host ?? 'unknown PC'; byHost.set(k, [...(byHost.get(k) ?? []), w]) }
  return (
    <div className="mt-4 rounded-xl border border-zinc-200 px-4 py-3 text-xs dark:border-zinc-800">
      <div className="mb-1.5 font-medium text-zinc-700 dark:text-zinc-300">{alive.length ? `Placing on ${new Set(alive.map(w => w.host)).size} PC(s) now` : 'Recent placing PCs'}</div>
      <div className="space-y-1">
        {[...byHost.entries()].map(([host, ws]) => {
          const live = ws.some(w => w.lastSeenAgoMs < 30_000 && w.state === 'running')
          return (
            <div key={host} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600 dark:text-zinc-400">
              <Badge tone={live ? 'green' : 'zinc'} dot>{live ? 'active' : ws[0].state}</Badge>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{host}</span>
              <span>{ws.length} window{ws.length === 1 ? '' : 's'} · account {ws[0].account ?? '—'}</span>
              <span>placed {ws.reduce((s, w) => s + w.placed, 0)} · returned to queue {ws.reduce((s, w) => s + w.failed, 0)}</span>
              {ws.some(w => w.currentSlip != null) && <span>on slip #{ws.filter(w => w.currentSlip != null).map(w => w.currentSlip).join(', #')}</span>}
              {!live && <span className="text-zinc-400">last seen {Math.round(Math.min(...ws.map(w => w.lastSeenAgoMs)) / 1000)}s ago</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
