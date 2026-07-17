/** Tiny total-goals history chart: one bar per past match (height = total goals), red when it went
 *  Over 4.5, green when Under, with a dashed threshold line at 4.5. Pure SVG, theme-aware. */
import React from 'react'

export function TotalsChart({ history, width = 132, height = 40 }: { history: { date: string; total: number }[]; width?: number; height?: number }) {
  if (!history.length) return <span className="text-xs text-zinc-400">no history</span>
  const max = Math.max(6, ...history.map(h => h.total))
  const n = history.length
  const gap = 2
  const bw = Math.max(2, (width - gap * (n - 1)) / n)
  const y = (v: number) => height - (v / max) * (height - 2)
  const line45 = y(4.5)
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" role="img" aria-label="recent total goals">
      <line x1="0" y1={line45} x2={width} y2={line45} stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" className="text-zinc-300 dark:text-zinc-600" />
      {history.map((h, i) => {
        const x = i * (bw + gap)
        const top = y(h.total)
        const over = h.total >= 5
        return <rect key={i} x={x} y={top} width={bw} height={height - top} rx="1"
          className={over ? 'fill-red-500' : 'fill-green-500'}>
          <title>{new Date(h.date).toLocaleDateString()} · {h.total} goals</title>
        </rect>
      })}
    </svg>
  )
}
