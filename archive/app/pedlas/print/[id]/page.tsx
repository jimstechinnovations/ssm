'use client'

/**
 * app/pedlas/print/[id]/page.tsx
 *
 * Clean, printable slip sheet for a saved PEDLAS book. Loads the book by id and
 * auto-opens the print dialog. Honest footer is non-negotiable (still −vig).
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { PedlasBook } from '@/lib/pedlas/types'

const naira = (x: number) => '₦' + Math.round(x).toLocaleString('en-US')
const pct = (x: number, dp = 2) => (x * 100).toFixed(dp) + '%'
const kickoff = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

export default function PedlasPrintPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [book, setBook] = useState<PedlasBook | null>(null)
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    fetch(`/api/pedlas/books/${id}`)
      .then(r => r.json())
      .then(j => {
        if (j.book) { setBook(j.book); setCreatedAt(j.createdAt ?? null); setTimeout(() => window.print(), 500) }
        else setErr(j.error || 'Book not found')
      })
      .catch(() => setErr('Failed to load book'))
  }, [id])

  if (err) return <div className="p-8 text-red-600">{err}</div>
  if (!book) return <div className="p-8 text-zinc-500">Loading slips…</div>

  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-black">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">PEDLAS Slips — {book.objective === 'coverage' ? 'Coverage' : 'Moonshot'}</h1>
          <p className="text-xs text-gray-600">
            {book.slips.length} slips · L{book.legCount} · stake {naira(book.stakePerSlip)}/slip · total {naira(book.totalStake)} ·
            boost +{book.slips[0]?.boostPct ?? 0}% · P(any hit) {pct(book.meta.pAnyHit)}
            {createdAt ? ` · ${new Date(createdAt).toLocaleString()}` : ''}
          </p>
        </div>
        <button onClick={() => window.print()} className="rounded border border-gray-400 px-3 py-1.5 text-sm print:hidden">
          🖨 Print
        </button>
      </div>

      <div className="space-y-3">
        {book.slips.map(slip => (
          <div key={slip.slipId} className="break-inside-avoid rounded border border-gray-300 p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-bold">Slip #{slip.slipId}</span>
              <span className="text-gray-700">
                {slip.legs.filter(l => l.side === 'Over').length} Over · {slip.legCount} legs · odds <strong>{slip.combinedOdds.toFixed(2)}</strong>
                {' '}· win <strong>{naira(slip.payout)}</strong>{slip.capped ? ' (capped)' : ''} · hit {pct(slip.trueProb, 3)}
              </span>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr><th className="py-0.5 pr-3">#</th><th className="pr-3">Kickoff</th><th className="pr-3">Match</th><th className="pr-3">League</th><th className="pr-3">Pick</th><th>Odds</th></tr>
              </thead>
              <tbody>
                {slip.legs.map((l, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="py-0.5 pr-3 text-gray-400">{i + 1}</td>
                    <td className="pr-3 text-gray-500">{kickoff(l.kickoff)}</td>
                    <td className="pr-3">{l.game}</td>
                    <td className="pr-3 text-gray-500">{l.league}</td>
                    <td className={`pr-3 font-semibold ${l.side === 'Over' ? 'text-orange-700' : ''}`}>{l.outcome}</td>
                    <td>{l.odds.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <p className="mt-4 border-t border-gray-300 pt-3 text-[10px] leading-snug text-gray-500">
        Structured −vig lottery (book EV/₦1 {book.verdict.evMultiple.toFixed(3)}). PEDLAS diversifies a small
        stake across plausible high-payout slips; it does not beat the bookmaker margin or create edge. Win Boost
        is a subsidy, not edge. Each slip is all-or-nothing. Bet responsibly.
      </p>
    </div>
  )
}
