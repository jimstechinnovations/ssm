// How does SportyBet price against the reference panel (Pinnacle + Kambi)? Today's board, read-only.
//   npx tsx --conditions=react-server scripts/sharp-probe.ts
import { sportybet } from '../lib/books/sportybet'
import { loadPanel } from '../lib/books/panel'
import { consensus } from '../lib/books/reference'
import { writeFileSync } from 'node:fs'

async function main() {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const { games } = await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 60 })
  const panel = await loadPanel(games)
  console.log(`SportyBet ${games.length} games · ${panel.sources.map(s => `${s.source}: ${s.fixtures} fixtures, ${s.matched} matched`).join(' · ')}${panel.errors.length ? ' · errors: ' + panel.errors.join('; ') : ''}`)
  const rejected = [...panel.games.entries()].flatMap(([fid, pg]) => pg.rejected.map(r => ({ game: games.find(g => g.fixtureId === fid)!.game, ...r })))
  console.log(`pairings dropped by the 1X2 guard: ${rejected.length}${rejected.length ? ' — e.g. ' + rejected.slice(0, 3).map(r => `${r.game} (${r.source}: ${r.why.split(' —')[0]})`).join(' · ') : ''}`)
  const rows: { game: string; name: string; odds: number; p: number; n: number; spread: number; by: Record<string, number>; own?: number; ev: number; kind: string }[] = []
  for (const g of games) for (const s of g.selections) {
    const c = consensus(panel.games.get(g.fixtureId), s.rule)
    if (c && c.p > 0.01 && c.p < 0.99) rows.push({ game: g.game, name: s.name, odds: s.odds, ...c, own: s.probability, ev: s.odds * c.p, kind: s.rule.kind })
  }
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(games.map(g => ({ fixtureId: g.fixtureId, game: g.game, kickoff: g.kickoff, tournamentId: g.tournamentId, picks: rows.filter(r => r.game === g.game) }))))
  const two = rows.filter(r => r.n >= 2)
  console.log(`picks with a reference price: ${rows.length} (both sources agree on the market: ${two.length})`)
  const q = (xs: number[], f: number) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(f * (a.length - 1))] }
  console.log(`odds × P(panel): median ${q(rows.map(r => r.ev), 0.5).toFixed(3)} · p90 ${q(rows.map(r => r.ev), 0.9).toFixed(3)} · p99 ${q(rows.map(r => r.ev), 0.99).toFixed(3)}`)
  if (two.length) console.log(`Pinnacle vs Kambi on the same pick: median gap ${(100 * q(two.map(r => r.spread), 0.5)).toFixed(1)} points · p90 ${(100 * q(two.map(r => r.spread), 0.9)).toFixed(1)}`)
  for (const t of [1.0, 1.02, 1.05]) console.log(`  SportyBet overpays by > ${((t - 1) * 100).toFixed(0)}%: ${rows.filter(r => r.ev > t).length} picks (${two.filter(r => r.ev > t && r.spread < 0.04).length} where both sources agree within 4 points)`)
  console.log('\ntop overpaid picks (both sources, agreeing within 4 points):')
  for (const r of two.filter(r => r.spread < 0.04).sort((a, b) => b.ev - a.ev).slice(0, 12))
    console.log(`  ${r.ev.toFixed(3)}  ${r.game.slice(0, 36).padEnd(36)} ${r.name.padEnd(18)} @${String(r.odds).padEnd(5)} panel ${(100 * r.p).toFixed(1)}% (${Object.entries(r.by).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}`).join(', ')}) · SportyBet ${r.own ? (100 * r.own).toFixed(1) + '%' : '—'}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })   // exit: the browser connection keeps the process alive
