// lib/books/panel.ts
// Load the reference price panel (lib/books/reference.ts) for a set of SportyBet games: every source's
// board, each game matched to each source, wrong pairings dropped by the 1X2 guard. A source that fails to
// load is left out (the panel shrinks; it never blocks a build) and named in `errors`.

import type { SelectionGame } from '../pedlas/selections'
import { buildPanel, matchFixture, type PanelGame, type RefBoard } from './reference'
import { fetchPinnacleBoard } from './pinnacle'
import { fetchKambiBoard } from './kambi'

export interface Panel { games: Map<number, PanelGame>; sources: { source: string; fixtures: number; matched: number }[]; errors: string[] }

export async function loadPanel(games: SelectionGame[]): Promise<Panel> {
  const errors: string[] = []
  const boards: RefBoard[] = []
  const [pin, kambiList] = await Promise.all([
    fetchPinnacleBoard().catch(e => { errors.push(`pinnacle: ${e instanceof Error ? e.message : e}`); return null }),
    fetchKambiBoard(new Set()).catch(e => { errors.push(`kambi: ${e instanceof Error ? e.message : e}`); return null }),
  ])
  if (pin) boards.push(pin)
  if (kambiList) {
    // only fetch Kambi's full markets for fixtures that match one of our games (one request each)
    const ids = new Set(games.map(g => matchFixture(g, kambiList.fixtures)?.id).filter((x): x is string => !!x))
    boards.push(await fetchKambiBoard(ids).catch(e => { errors.push(`kambi markets: ${e instanceof Error ? e.message : e}`); return kambiList }))
  }
  const own = (g: SelectionGame) => {
    const p = (pick: 'H' | 'D' | 'A') => g.selections.find(s => s.rule.kind === '1x2' && s.rule.pick === pick)?.probability
    return { home: p('H'), draw: p('D'), away: p('A') }
  }
  const panelGames = buildPanel(games.map(g => ({ fixtureId: g.fixtureId, home: g.home, away: g.away, kickoff: g.kickoff, own1x2: own(g) })), boards)
  return {
    games: panelGames, errors,
    sources: boards.map(b => ({ source: b.source, fixtures: b.fixtures.length, matched: [...panelGames.values()].filter(pg => pg.sources.some(s => s.source === b.source)).length })),
  }
}
