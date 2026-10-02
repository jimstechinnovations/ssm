'use client'

/**
 * components/CoverageTab.tsx — "do we have enough survivors?", both ways (GET /api/sessions/[code]/coverage).
 *
 *  1. Alive now: settled games + games IN PLAY (a leg dies the moment it can't win, as SportyBet does),
 *     and SportyBet's own open-bet count matched slip by slip (needs the prepared browser).
 *  2. Both ways: per game still to play — who rides on it, what each likely score does to the slips and
 *     to the chance of at least one win, and whether it's one-sided (can cut every slip on it).
 *  3. Slips & budget: how the chance moved game by game, P(≥1 win) as slips are added, and what more
 *     slips or budget would buy. Before anything is placed the same tab is the pre-placement check.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Refresh } from '@/components/Icons'
import { Card, Stat, Button, Banner, Badge, Empty, naira, pct, cx } from '@/components/ui'

interface ScoreRow { score: string; p: number; survivors: number; pWinIf: number | null }
interface JourneyGame { fixtureId: number; game: string; kickoff: string; status: 'live' | 'pending'; liveScore?: string; minute?: number; riding: number; picks: { name: string; p: number; slips: string[] }[]; pAllCut: number; oneSided: boolean; scores: ScoreRow[]; pAnyAliveAfter: number; expectedAliveAfter: number; pWinIfBest: number; pWinIfWorst: number }
interface Pass { slips: number; pAnyWin: number; expectedWinners: number; sumP: number; efficiency: number; keep: number; journey: JourneyGame[]; survivalDepth90: number; slipCurve: { n: number; pAnyWin: number }[] }
interface Coverage {
  mode: 'live' | 'plan'; sessions: string[]; generatedAt: string; slips: number; aliveNow: number; aliveAtFullTime: number
  earlyKilled: { key: string; game: string; pick: string; score: string }[]
  now: Pass; plan: Pass
  budget: { stake: number; target: number; keep: number; marginalPerSlip: number; fromScratch: { goal: number; slips: number | null; budget: number | null; atBest: number }[]; topUp: { goal: number; moreSlips: number | null; moreBudget: number | null }[] }
  aliveSlips: { key: string; slipId: number; session?: string; pWin: number; payout: number; needs: number }[]
  timeline: { game: string; kickoff: string; score: string | null; cut: number; aliveAfter: number; pAfter: number }[]
  site: null | { error?: string; openOnAccount?: number; openInFamily?: number; aliveHereSettledOnSite?: string[]; openOnSiteDeadHere?: string[]; openNotInFamily?: number }
}

const hm = (iso: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

export function CoverageTab({ code }: { code: string }) {
  const [c, setC] = useState<Coverage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'load' | 'site'>(null)
  const [combine, setCombine] = useState(true)
  // state is only set inside promise callbacks — never synchronously inside the effect
  const fetchCov = useCallback((site = false) => fetch(`/api/sessions/${code}/coverage?${combine ? 'combine=day&' : ''}${site ? 'site=1' : ''}`)
    .then(r => r.json())
    .then(j => { if (j.error) setErr(j.error); else { setErr(null); setC(j) } })
    .catch(() => setErr('Could not load coverage.')), [code, combine])
  useEffect(() => { void fetchCov() }, [fetchCov])
  const load = (site = false) => { setBusy(site ? 'site' : 'load'); void fetchCov(site).finally(() => setBusy(null)) }

  if (err && !c) return <Empty title="No coverage yet">{err}</Empty>
  if (!c) return <div className="py-8 text-sm text-zinc-500">Simulating the remaining games…</div>
  const live = c.mode === 'live'
  const pass = live ? c.now : c.plan
  const games = pass.journey.filter(g => g.riding > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={combine} onChange={e => setCombine(e.target.checked)} />
          Include every session from the same day ({c.sessions.length} now)
        </label>
        <div className="flex gap-2">
          {live && <Button size="sm" onClick={() => void load(true)} loading={busy === 'site'}>Check SportyBet</Button>}
          <Button size="sm" onClick={() => void load()} loading={busy === 'load'} icon={<Refresh className="h-3.5 w-3.5" />}>Refresh</Button>
        </div>
      </div>
      {err && <Banner tone="warn">{err}</Banner>}
      {!live && <Banner tone="info" title="Before placing">Nothing is staked yet. This is the check on the built slips: which games are one-sided, how far at least one slip survives, and what more slips or budget would buy.</Banner>}

      {/* ── 1. alive now ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={live ? 'Alive now' : 'Slips built'} big value={live ? `${c.aliveNow} / ${c.slips}` : c.slips}
          hint={live ? (c.earlyKilled.length ? `${c.aliveAtFullTime} at full time · ${c.earlyKilled.length} already beaten in play` : 'settled + in-play games') : undefined} />
        <Stat label="Chance at least one wins" big tone="accent" value={pct(pass.pAnyWin, 2)} hint={`≈ ${pass.expectedWinners.toFixed(3)} winning slips expected`} />
        <Stat label="Pays if one wins" value={naira(c.budget.target)} hint={`stake ${naira(c.budget.stake)} a slip`} />
        <Stat label={live ? 'SportyBet open bets' : 'Survives the first'} value={live ? (c.site?.openInFamily != null ? `${c.site.openInFamily}` : '—') : `${pass.survivalDepth90} games`}
          hint={live ? (c.site?.error ? 'browser not ready' : c.site ? `${c.site.openOnAccount} open on the account` : 'press Check SportyBet') : 'with ≥ 90% chance at least one is alive'} />
      </div>
      {c.earlyKilled.length > 0 && (
        <Card title="Already beaten in play" subtitle="SportyBet settles these the moment the score makes the pick impossible; the app's full-time count catches up when the game ends.">
          <ul className="space-y-1 text-sm">{c.earlyKilled.map(k => <li key={k.key}><span className="font-mono text-xs text-zinc-500">{k.key}</span> · {k.game} is {k.score}, so <strong>{k.pick}</strong> can&apos;t win</li>)}</ul>
        </Card>
      )}
      {c.site && !c.site.error && ((c.site.aliveHereSettledOnSite?.length ?? 0) > 0 || (c.site.openOnSiteDeadHere?.length ?? 0) > 0) && (
        <Banner tone="warn" title="The app and SportyBet disagree on some slips">
          {(c.site.aliveHereSettledOnSite?.length ?? 0) > 0 && <div>Settled on SportyBet, still alive here: {c.site.aliveHereSettledOnSite!.join(', ')}</div>}
          {(c.site.openOnSiteDeadHere?.length ?? 0) > 0 && <div>Still open on SportyBet, beaten here (SportyBet hasn&apos;t settled yet): {c.site.openOnSiteDeadHere!.join(', ')}</div>}
        </Banner>
      )}
      {c.site?.error && <Banner tone="muted">SportyBet check: {c.site.error}</Banner>}

      {/* ── how the chance moved ── */}
      {live && c.timeline.length > 1 && <Timeline t={c.timeline} />}

      {/* ── 2. both ways ── */}
      <Card pad={false} title={live ? 'Games still to play, both ways' : 'Every game, both ways'}
        subtitle="For each game: the picks riding on it, what each likely score leaves alive, and what it does to the chance of at least one win.">
        {games.length === 0 ? <p className="px-5 py-4 text-sm text-zinc-500">No games left to play.</p> : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {games.map(g => <GameRow key={g.fixtureId} g={g} />)}
          </div>
        )}
      </Card>

      {/* ── 3. slips & budget ── */}
      <Budget c={c} />

      {live && c.aliveSlips.length > 0 && (
        <Card title="Slips still alive, best chance first">
          <div className="space-y-1 text-sm">
            {c.aliveSlips.slice(0, 20).map(s => (
              <div key={s.key} className="flex items-center gap-3">
                <span className="w-28 font-mono text-xs text-zinc-500">{s.key}</span>
                <span className="w-16 text-right tabular-nums">{pct(s.pWin, 2)}</span>
                <span className="w-24 text-right text-xs text-zinc-500">{s.needs} leg{s.needs === 1 ? '' : 's'} to go</span>
                <span className="text-xs text-zinc-500">pays {naira(s.payout)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <p className="text-[11px] text-zinc-500">Simulated from each leg&apos;s calibrated probability (the book&apos;s de-vigged price at build time); games independent, as the book prices them. Figures move by a few tenths between refreshes; that&apos;s simulation noise.</p>
    </div>
  )
}

function GameRow({ g }: { g: JourneyGame }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-5 py-3 text-sm">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
        <span className="w-12 text-xs tabular-nums text-zinc-500">{g.status === 'live' ? `${g.minute}'` : hm(g.kickoff)}</span>
        <span className="min-w-[10rem] flex-1 font-medium text-zinc-900 dark:text-zinc-100">{g.game}</span>
        {g.status === 'live' && <Badge tone="blue" dot>live {g.liveScore}</Badge>}
        {g.oneSided && <Badge tone="red">one-sided</Badge>}
        <span className="text-xs text-zinc-500">{g.riding} slip{g.riding === 1 ? '' : 's'} ride</span>
        <span className="w-44 text-right text-xs tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">▲ {pct(g.pWinIfBest, 1)}</span>{' · '}<span className="text-red-500">▼ {pct(g.pWinIfWorst, 2)}</span>
        </span>
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1.5 pl-12">
        {g.picks.map(p => <span key={p.name} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{p.name} ×{p.slips.length} <span className="text-zinc-400">({pct(p.p, 0)})</span></span>)}
        <span className={cx('px-1.5 py-0.5 text-xs', g.pAllCut >= 0.5 ? 'text-red-500' : 'text-zinc-500')}>cuts every slip on it {pct(g.pAllCut, 0)} of the time</span>
      </div>
      {open && (
        <div className="mt-2 overflow-x-auto pl-12">
          <table className="text-xs tabular-nums">
            <thead><tr className="text-zinc-500"><th className="pr-4 text-left font-normal">Final score</th><th className="pr-4 text-right font-normal">Chance</th><th className="pr-4 text-right font-normal">Slips left on it</th><th className="text-right font-normal">Win chance after</th></tr></thead>
            <tbody>
              {g.scores.map(s => (
                <tr key={s.score}>
                  <td className="pr-4">{s.score}</td>
                  <td className="pr-4 text-right">{pct(s.p, 0)}</td>
                  <td className={cx('pr-4 text-right', s.survivors === 0 && 'text-red-500')}>{s.survivors}/{g.riding}</td>
                  <td className="text-right">{s.pWinIf == null ? '—' : pct(s.pWinIf, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The chance of at least one win after every finished game: up when a game goes our way, down when it cuts. */
function Timeline({ t }: { t: Coverage['timeline'] }) {
  const W = 640, H = 120, P = 6
  const max = Math.max(...t.map(x => x.pAfter), 1e-6)
  const x = (i: number) => P + (i / Math.max(1, t.length - 1)) * (W - 2 * P)
  const y = (v: number) => H - P - (v / max) * (H - 2 * P)
  const moves = t.slice(1).map((m, i) => ({ ...m, d: m.pAfter - t[i].pAfter })).filter(m => Math.abs(m.d) > 0.0001)
  return (
    <Card title="How the chance moved, game by game" subtitle={`Started at ${pct(t[0].pAfter, 2)} before kickoff. Each finished game moves it up (it went our way) or down (it cut slips). On average it neither rises nor falls.`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img" aria-label="Chance of at least one win over time">
        <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-800 dark:text-zinc-200" points={t.map((m, i) => `${x(i)},${y(m.pAfter)}`).join(' ')} />
      </svg>
      <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs">
        {moves.slice(-15).reverse().map((m, i) => (
          <div key={i} className="flex gap-3">
            <span className={cx('w-16 text-right tabular-nums', m.d > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>{m.d > 0 ? '▲' : '▼'} {pct(Math.abs(m.d), 2)}</span>
            <span className="w-14 tabular-nums text-zinc-500">{pct(m.pAfter, 2)}</span>
            <span className="flex-1 truncate">{m.game} {m.score}{m.cut ? ` · cut ${m.cut}` : ''}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Budget({ c }: { c: Coverage }) {
  const b = c.budget, plan = c.plan
  const max = Math.max(...plan.slipCurve.map(p => p.pAnyWin), 1e-6)
  return (
    <Card title="How many slips, what budget" subtitle={`Before kickoff these ${plan.slips} slips had ${pct(plan.pAnyWin, 2)} to land at least once; their keep is ${b.keep.toFixed(2)} (each ₦1 staked returns ₦${b.keep.toFixed(2)} on average). Chance ≤ keep × budget ÷ target: more slips raise it about in a straight line, and nothing beats that line.`}>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500">Chance of at least one win as slips are added</div>
          <div className="space-y-0.5 text-xs tabular-nums">
            {plan.slipCurve.map(p => (
              <div key={p.n} className="flex items-center gap-2">
                <span className="w-16 text-right text-zinc-500">{p.n} slips</span>
                <span className="h-2 rounded bg-zinc-800 dark:bg-zinc-200" style={{ width: `${Math.max(2, 100 * p.pAnyWin / max) * 0.6}%` }} />
                <span>{pct(p.pAnyWin, 2)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">{pct(plan.efficiency, 0)} of the slips&apos; combined chance survives overlap (100% = no two slips can both win).</p>
        </div>
        <div className="space-y-4">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-zinc-500"><th className="text-left font-normal">To land at least once</th><th className="text-right font-normal">Slips</th><th className="text-right font-normal">Budget</th><th className="text-right font-normal">Floor (no overlap)</th></tr></thead>
            <tbody>{b.fromScratch.map(r => (
              <tr key={r.goal}><td>{pct(r.goal, 0)} chance</td><td className="text-right">{r.slips ?? '—'}</td><td className="text-right">{naira(r.budget)}</td><td className="text-right text-zinc-500">{r.atBest} · {naira(r.atBest * b.stake)}</td></tr>
            ))}</tbody>
          </table>
          {c.mode === 'live' && (
            <table className="w-full text-xs tabular-nums">
              <thead><tr className="text-zinc-500"><th className="text-left font-normal">Top up now (new slips on games not started)</th><th className="text-right font-normal">More slips</th><th className="text-right font-normal">More budget</th></tr></thead>
              <tbody>{b.topUp.map(r => (
                <tr key={r.goal}><td>to {pct(r.goal, 0)} (now {pct(c.now.pAnyWin, 1)})</td><td className="text-right">{r.moreSlips ?? '—'}</td><td className="text-right">{naira(r.moreBudget)}</td></tr>
              ))}</tbody>
            </table>
          )}
          <p className="text-[11px] text-zinc-500">Every extra slip costs more than it returns on average (keep {b.keep.toFixed(2)} &lt; 1). A bigger budget buys a bigger chance, not an edge. Expected cost of each line ≈ budget × {(1 - b.keep).toFixed(2)}.</p>
        </div>
      </div>
    </Card>
  )
}
