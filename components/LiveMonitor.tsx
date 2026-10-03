'use client'

/**
 * components/LiveMonitor.tsx — the live panel for a placed session (lib/monitor/tick.ts).
 * Layout: three headline numbers → the latest short update → fold-away lists (live games, cuts, beaten in
 * play, earlier updates). While the page is open it refreshes every 30s and asks for a check every ~4.5 min
 * (the server ignores checks closer than 4 min). Each update says whether the AI wrote it and it passed the
 * fact check, or the plain facts were used — with the AI's rejected draft and why.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Refresh } from '@/components/Icons'
import { Button, Badge, cx, naira } from '@/components/ui'

interface Detail {
  cuts: { game: string; score: string; slipsCut: number }[]
  beatenInPlay: { game: string; score: string; pick: string; slip: string }[]
  live: { game: string; score: string; minute: number | null; slipsRiding: number }[]
}
interface MonitorEvent {
  at: string; kind: 'update' | 'heartbeat' | 'alert'; text: string; source: 'ai' | 'facts'; model?: string
  verified: boolean; issues?: string[]; aiDraft?: string; latencyMs?: number; detail?: Detail
  facts: {
    jackpot: { aliveNow: number; total: number; chancePct: number; chanceChangePct: number }
    floor: { total: number; won: number; lost: number; open: number; returnedNaira: number; stakedNaira: number }
    placement: { mismatches: string[]; checkNote: string | null }
  }
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0 rounded-xl bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/50">
      <div className="text-[11px] font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      {sub && <div className={cx('truncate text-[11px] tabular-nums', tone === 'up' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'down' ? 'text-red-500' : 'text-zinc-500')}>{sub}</div>}
    </div>
  )
}

function Fold({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <details className="group border-t border-zinc-100 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/40">
        <span>{title} <span className="text-zinc-400">({count})</span></span>
        <span className="text-zinc-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-5 pb-3">{children}</div>
    </details>
  )
}

export function LiveMonitor({ code, active, extraAction, embedded }: { code: string; active: boolean; extraAction?: React.ReactNode; embedded?: boolean }) {
  const [feed, setFeed] = useState<MonitorEvent[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ticking = useRef(false)

  // state only set in promise callbacks (never synchronously in an effect)
  const load = useCallback(() => fetch(`/api/sessions/${code}/monitor`).then(r => r.json()).then(j => { if (j.feed) setFeed(j.feed) }).catch(() => {}), [code])
  const tick = useCallback((force = false) => {
    if (ticking.current) return Promise.resolve()
    ticking.current = true
    return fetch(`/api/sessions/${code}/monitor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }) })
      .then(r => r.json()).then(j => { if (j.feed) { setFeed(j.feed); setErr(null) } else if (j.error) setErr(j.error) })
      .catch(() => setErr('Could not run the check.')).finally(() => { ticking.current = false })
  }, [code])

  useEffect(() => {
    void load()
    if (!active) return
    void tick()
    const a = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    const b = setInterval(() => { if (document.visibilityState === 'visible') void tick() }, 270_000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [load, tick, active])

  const checkNow = () => { setBusy(true); void tick(true).finally(() => setBusy(false)) }
  const items = [...(feed ?? [])].reverse()
  const last = items[0]
  const d = items.find(e => e.detail)?.detail
  const f = last?.facts
  const chg = f?.jackpot.chanceChangePct ?? 0

  return (
    <section className={embedded ? '-mx-5 -mb-5' : 'rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-900/[0.03] dark:border-zinc-800 dark:bg-zinc-900'}>
      <div className={cx('flex flex-wrap items-center gap-2 px-5', embedded ? 'pt-0' : 'pt-4')}>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {active && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}Live
        </h2>
        {last && <span className="text-xs text-zinc-500">updated {hm(last.at)}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {extraAction}
          <Button size="sm" onClick={checkNow} loading={busy} icon={<Refresh className="h-3.5 w-3.5" />}>Check now</Button>
        </div>
      </div>

      {f ? (
        <div className="grid grid-cols-3 gap-2 px-5 pt-3">
          <Tile label="Jackpot slips alive" value={<>{f.jackpot.aliveNow}<span className="text-sm font-normal text-zinc-400"> / {f.jackpot.total}</span></>} />
          <Tile label="Chance of a win" value={`${f.jackpot.chancePct}%`} sub={chg ? `${chg > 0 ? '▲' : '▼'} ${Math.abs(chg)}` : undefined} tone={chg > 0 ? 'up' : chg < 0 ? 'down' : undefined} />
          <Tile label="Floor tickets" value={<>{f.floor.won}<span className="text-sm font-normal text-zinc-400"> won</span></>} sub={`${naira(f.floor.returnedNaira)} back · ${f.floor.open} open`} />
        </div>
      ) : null}

      <div className="px-5 py-3">
        {err && <p className="mb-2 text-xs text-red-500">{err}</p>}
        {feed == null ? <p className="text-sm text-zinc-500">Loading…</p>
          : !last ? <p className="text-sm text-zinc-500">{active ? 'The first check is running…' : 'Nothing in play.'}</p>
          : (
            <div>
              {f && f.placement.mismatches.length > 0 && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">⚠ {f.placement.mismatches.join(' · ')}</p>}
              <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{last.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                {last.source === 'ai' ? <Badge tone="green">AI · fact-checked</Badge> : last.verified ? <Badge>facts</Badge> : <Badge tone="amber">facts · AI draft not used</Badge>}
                {last.model && <span>{last.model.split('/').pop()}{last.latencyMs ? ` · ${(last.latencyMs / 1000).toFixed(0)}s` : ''}</span>}
                {f?.placement.checkNote && <span>· {f.placement.checkNote}</span>}
              </div>
              {!last.verified && last.issues?.length ? (
                <details className="mt-1 text-xs text-zinc-500">
                  <summary className="cursor-pointer">Why the AI draft wasn&apos;t used</summary>
                  <ul className="mt-1 list-disc pl-5">{last.issues.map(x => <li key={x}>{x}</li>)}</ul>
                  {last.aiDraft && <p className="mt-1 break-words italic">“{last.aiDraft}”</p>}
                </details>
              ) : null}
            </div>
          )}
      </div>

      {d && (
        <>
          <Fold title="Live games with slips riding" count={d.live.length}>
            <ul className="space-y-1 text-sm">{d.live.map(g => <li key={g.game} className="flex gap-3"><span className="w-10 shrink-0 tabular-nums text-zinc-500">{g.minute != null ? `${g.minute}'` : ''}</span><span className="min-w-0 flex-1 truncate">{g.game}</span><span className="tabular-nums font-medium">{g.score}</span><span className="w-16 shrink-0 text-right text-xs text-zinc-500">{g.slipsRiding} slip{g.slipsRiding === 1 ? '' : 's'}</span></li>)}</ul>
          </Fold>
          <Fold title="Games that cut slips" count={d.cuts.length}>
            <ul className="space-y-1 text-sm">{d.cuts.map(c => <li key={c.game} className="flex gap-3"><span className="min-w-0 flex-1 truncate">{c.game}</span><span className="tabular-nums">{c.score}</span><span className="w-10 shrink-0 text-right tabular-nums text-red-500">−{c.slipsCut}</span></li>)}</ul>
          </Fold>
          <Fold title="Beaten in play (settle at full time)" count={d.beatenInPlay.length}>
            <ul className="space-y-1 text-sm">{d.beatenInPlay.map(k => <li key={k.slip} className="flex gap-3"><span className="min-w-0 flex-1 truncate">{k.game} <span className="text-zinc-400">{k.score}</span></span><span className="shrink-0 text-xs text-zinc-500">{k.pick}</span></li>)}</ul>
          </Fold>
        </>
      )}
      <Fold title="Earlier updates" count={Math.max(0, items.length - 1)}>
        <ol className="space-y-2 text-sm">{items.slice(1).map((e, i) => (
          <li key={e.at + i} className="flex gap-3"><span className="w-10 shrink-0 tabular-nums text-xs text-zinc-500">{hm(e.at)}</span><span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">{e.text}</span></li>
        ))}</ol>
      </Fold>
    </section>
  )
}
