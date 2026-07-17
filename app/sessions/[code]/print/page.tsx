'use client'

/**
 * app/sessions/[code]/print/page.tsx — a print-optimised report of a whole session (all slips + codes,
 * games, honest metrics). Opens in a new tab and auto-triggers the browser print dialog → Save as PDF.
 */

import React, { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Spinner, Download } from '@/components/Icons'

interface Slip { id: string; slipId: number; status: string; stake: number; combinedOdds: number; potentialPayout: number | null; legCount: number; bookingCode: string | null; won: boolean | null }
interface Session { code: string; status: string; budget: number; targetWin: number; legCount: number | null; slipCount: number | null; poolSize: number | null; bookIds: string[]; dateFrom: string; dateTo: string; createdAt: string; meta?: { pAnyWin?: number } | null }
interface Game { fixtureId: number; game: string; league: string; kickoff: string; line: number; underOdds: number }

const naira = (n?: number | null) => n == null ? '—' : '₦' + Math.round(n).toLocaleString()

export default function PrintPage() {
  const code = String(useParams().code)
  const [session, setSession] = useState<Session | null>(null)
  const [slips, setSlips] = useState<Slip[]>([])
  const [summary, setSummary] = useState<{ placed: number; pending: number; failed: number; staked: number } | null>(null)
  const [games, setGames] = useState<Game[]>([])

  useEffect(() => {
    (async () => {
      const [s, g] = await Promise.all([
        fetch(`/api/sessions/${code}?limit=1000`).then(r => r.json()),
        fetch(`/api/sessions/${code}/games`).then(r => r.json()).catch(() => ({ games: [] })),
      ])
      if (s.session) { setSession(s.session); setSlips(s.slips ?? []); setSummary(s.summary) }
      setGames(g.games ?? [])
    })()
  }, [code])

  useEffect(() => { if (session && slips.length) { const t = setTimeout(() => window.print(), 700); return () => clearTimeout(t) } }, [session, slips.length])

  if (!session) return <div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-zinc-500"><Spinner /> Preparing report…</div>

  const pAny = session.meta?.pAnyWin
  return (
    <div className="mx-auto max-w-4xl bg-white px-6 py-8 text-zinc-900">
      <div className="no-print mb-4 flex justify-end">
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white"><Download className="h-4 w-4" /> Save as PDF</button>
      </div>

      <header className="mb-5 border-b border-zinc-300 pb-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-bold">PEDLA session <span className="font-mono">{session.code}</span></h1>
          <span className="text-xs text-zinc-500">generated {new Date().toLocaleString()}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-600">
          {session.bookIds.join(', ')} · built {new Date(session.createdAt).toLocaleString()} · window {session.dateFrom} → {session.dateTo}
        </p>
      </header>

      <div className="mb-5 grid grid-cols-4 gap-3 text-sm">
        <Cell k="Budget → target" v={`${naira(session.budget)} → ${naira(session.targetWin)}`} />
        <Cell k="Slips × legs" v={`${session.slipCount} × ${session.legCount}`} />
        <Cell k="Pool games" v={String(session.poolSize ?? '—')} />
        <Cell k="P(≥1 win)" v={pAny != null ? (100 * pAny).toFixed(1) + '%' : '—'} />
        {summary && <>
          <Cell k="Placed" v={String(summary.placed)} />
          <Cell k="Pending" v={String(summary.pending)} />
          <Cell k="Failed" v={String(summary.failed)} />
          <Cell k="Staked" v={naira(summary.staked)} />
        </>}
      </div>

      <h2 className="mb-2 text-sm font-bold">Pool games ({games.length})</h2>
      <div className="mb-5 grid grid-cols-2 gap-x-6 text-xs">
        {games.map((g, i) => (
          <div key={g.fixtureId} className="flex justify-between border-b border-zinc-100 py-0.5">
            <span>{i + 1}. {g.game}</span>
            <span className="text-zinc-500">U{g.line} @ {g.underOdds}</span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-bold">Slips ({slips.length})</h2>
      <table className="w-full text-left text-xs">
        <thead className="border-b border-zinc-400 text-zinc-600">
          <tr><th className="py-1">#</th><th>legs</th><th>odds</th><th>payout</th><th>status</th><th>booking code</th></tr>
        </thead>
        <tbody>
          {slips.map(s => (
            <tr key={s.id} className="print-avoid-break border-b border-zinc-100">
              <td className="py-0.5 text-zinc-500">{s.slipId}</td>
              <td>{s.legCount}</td>
              <td>{s.combinedOdds?.toFixed?.(1) ?? '—'}</td>
              <td>{naira(s.potentialPayout)}</td>
              <td className="capitalize">{s.status}</td>
              <td className="font-mono">{s.bookingCode ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-6 border-t border-zinc-300 pt-2 text-[10px] text-zinc-500">
        Honest EV: every slip is a −vig multibet; this is a structured scatter, not an edge. Booking codes reopen the identical slip at SportyBet.
      </p>
    </div>
  )
}

function Cell({ k, v }: { k: string; v: string }) {
  return <div className="rounded border border-zinc-200 p-2"><div className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</div><div className="font-bold">{v}</div></div>
}
