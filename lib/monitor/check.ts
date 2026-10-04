// lib/monitor/check.ts — the pure half of the live monitor (no I/O): the facts' shape, the plain factual
// update, the AI's instructions, and the fact check every AI draft must pass. Unit-tested.

/** Who is ahead in a live game: scores are HOME-AWAY and the game is "Home vs Away". Given to the AI so it
 *  never reads "Athletic Bilbao B 1-3" as Bilbao leading (it did, 2026-10-04). */
export function leaderOf(game: string, score?: string | null): string {
  const m = /^(\d+)-(\d+)$/.exec((score ?? '').replace(/\s/g, '')); const [home, away] = game.split(' vs ')
  if (!m || !away) return 'unknown'
  return Number(m[1]) > Number(m[2]) ? home : Number(m[1]) < Number(m[2]) ? away : 'level'
}

export interface MonitorFacts {
  at: string
  jackpot: { total: number; aliveNow: number; aliveAtFullTime: number; chancePct: number; aliveChange: number; chanceChangePct: number }
  newlyCut: { game: string; score: string; slipsCut: number; wasBeatenInPlay?: boolean }[]   // wasBeatenInPlay: those slips were already counted out while the game was live
  newlyBeatenInPlay: { game: string; score: string; pick: string }[]
  live: { game: string; score: string; minute: number | null; slipsRiding: number; leading?: string }[]   // score is home-away; leading = team ahead or 'level'
  nextUp: { game: string; kickoffUtc: string; slipsRiding: number; overdue?: boolean }[]
  floor: { total: number; won: number; lost: number; open: number; returnedNaira: number; stakedNaira: number }
  placement: { placed: number; stakedNaira: number; openOnSportyBet: number | null; mismatches: string[]; checkNote: string | null }
  winners: { slip: string; paysNaira: number }[]
  cashedOut: { slips: number; returnedNaira: number; newly: { slip: string; paidNaira: number }[] }   // cashed out on SportyBet by the operator
  firstCheck: boolean                                     // no previous check: changes = everything so far
  soFar: { cutGames: number; slipsCut: number; beatenInPlay: number }
}
/** The full lists behind an update, for the UI's fold-away sections (not sent to the AI). */
export interface MonitorDetail {
  cuts: { game: string; score: string; slipsCut: number }[]
  beatenInPlay: { game: string; score: string; pick: string; slip: string }[]
  live: { game: string; score: string; minute: number | null; slipsRiding: number }[]
  alive?: { slip: string; needs: number; chancePct: number; paysNaira: number; worthNaira: number }[]   // worth = chance × pays
}
export interface MonitorEvent {
  at: string
  kind: 'update' | 'heartbeat' | 'alert'
  text: string                 // what the site shows
  source: 'ai' | 'facts'
  model?: string
  verified: boolean            // the AI draft passed the fact check (or no AI was used)
  issues?: string[]            // why an AI draft was rejected
  aiDraft?: string             // the rejected draft, kept for review
  latencyMs?: number
  facts: MonitorFacts
  detail?: MonitorDetail
}
/** What the AI sees: the facts minus the long lists (the UI shows those itself). */
// The lists are cut to a few examples, so the TOTALS go alongside: shown only the first 4 of 11 cut games,
// the AI reported "five slips cut across four matches" when 12 were cut in 11 (2026-10-04).
export const forAi = (f: MonitorFacts) => ({
  ...f, live: f.live.slice(0, 4), newlyCut: f.newlyCut.slice(0, 4), newlyBeatenInPlay: f.newlyBeatenInPlay.slice(0, 4), nextUp: f.nextUp.slice(0, 2),
  cutSinceLastCheck: { games: f.newlyCut.filter(c => !c.wasBeatenInPlay).length, slips: f.newlyCut.filter(c => !c.wasBeatenInPlay).reduce((x, c) => x + c.slipsCut, 0), gamesListed: Math.min(4, f.newlyCut.length) },
})

/** The plain factual update — always correct, used when the AI is off or its draft fails the check. */
export function factsText(f: MonitorFacts): string {
  const list = <T,>(xs: T[], fmt: (x: T) => string) => xs.slice(0, 3).map(fmt).join('; ') + (xs.length > 3 ? ` (+${xs.length - 3} more)` : '')
  const parts: string[] = []
  if (f.placement.mismatches.length) parts.push(`⚠ ${f.placement.mismatches[0]}.`)
  if (f.winners.length) parts.push(`WINNER: ${f.winners.map(w => `${w.slip} pays ₦${w.paysNaira.toLocaleString()}`).join(', ')}.`)
  if (f.cashedOut.newly.length) parts.push(`Cashed out: ${f.cashedOut.newly.map(c => `${c.slip} for ₦${c.paidNaira.toLocaleString()}`).join(', ')}.`)
  parts.push(`${f.jackpot.aliveNow} of ${f.jackpot.total} jackpot slips alive (${f.jackpot.chancePct}% chance).`)
  if (f.firstCheck) parts.push(`Watching from here: ${f.soFar.slipsCut} slips cut so far in ${f.soFar.cutGames} games.`)
  if (f.newlyCut.length) parts.push(`Cut: ${list(f.newlyCut, c => `${c.game} ${c.score} (${c.wasBeatenInPlay ? 'confirms earlier losses' : `−${c.slipsCut}`})`)}.`)
  if (f.newlyBeatenInPlay.length) parts.push(`Beaten in play: ${list(f.newlyBeatenInPlay, k => `${k.game} ${k.score}`)}.`)
  if (!f.firstCheck && !f.newlyCut.length && !f.newlyBeatenInPlay.length && !f.winners.length) parts.push('No slips cut since the last check.')
  return parts.join(' ')
}
/** Every number in the AI's text must appear in the facts; amounts must be ₦. Returns the problems. */
export function checkDraft(text: string, facts: MonitorFacts): string[] {
  const issues: string[] = []
  if (/[£$€]/.test(text)) issues.push('uses a currency other than ₦')
  const allowed = new Set<string>()
  const add = (n: number) => { allowed.add(String(n)); allowed.add(String(Math.round(n))); allowed.add(n.toFixed(1)); allowed.add(n.toFixed(2)) }
  for (const m of JSON.stringify(facts).match(/-?\d+(?:\.\d+)?/g) ?? []) { const n = Math.abs(Number(m)); add(n) }
  for (const m of text.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []) {
    if (Number(m) <= 1) continue                      // "one", "1 game", "0" — never a claim worth flagging
    if (!allowed.has(m) && !allowed.has(String(Number(m)))) issues.push(`number "${m}" is not in the facts`)
  }
  // the alive count may be written as a digit or a word ("five slips alive" was wrongly rejected, 2026-10-03)
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
  const n = facts.jackpot.aliveNow, word = WORDS[n]
  const lower = text.toLowerCase()
  const toks = lower.split(/[^a-z0-9]+/)
  if (!toks.includes(String(n)) && !(word && toks.includes(word))) issues.push(`doesn't state the ${n} slips alive`)
  // Counts written as WORDS are claims too. "Five slips were cut across four finished matches" passed on
  // 2026-10-04 when 12 slips were cut in 11 games: only digits were checked.
  const val = (t: string) => /^\d+$/.test(t) ? Number(t) : WORDS.indexOf(t)
  for (const t of toks) { const v = WORDS.indexOf(t); if (v >= 2 && !allowed.has(String(v))) issues.push(`number "${t}" is not in the facts`) }
  const cutNew = facts.newlyCut.filter(c => !c.wasBeatenInPlay)
  const slipsCut = new Set([cutNew.reduce((x, c) => x + c.slipsCut, 0), facts.soFar.slipsCut, -facts.jackpot.aliveChange])
  for (const m of lower.matchAll(/\b([a-z]+|\d+) (?:more |jackpot |more jackpot )?slips? (?:were |was |have been |has been |got )?(?:cut|knocked out|eliminated)/g)) {
    const v = val(m[1]); if (v >= 0 && !slipsCut.has(v)) issues.push(`says ${m[1]} slips were cut; the facts say ${[...slipsCut].join(' / ')}`)
  }
  const games = new Set([cutNew.length, facts.newlyCut.length, facts.soFar.cutGames, facts.live.length, facts.nextUp.length, facts.newlyBeatenInPlay.length])
  for (const m of lower.matchAll(/\b([a-z]+|\d+) (?:finished |completed |live |more )?(?:matches|games)\b/g)) {
    const v = val(m[1]); if (v >= 2 && !games.has(v)) issues.push(`says ${m[1]} games; no game count in the facts is ${v}`)
  }
  // A SCORE must be one the facts give, as a pair: checking its numbers one by one passed "Kolos Kovalivka
  // 2–1 Oleksandriya" (the team's "2" run into the 0-1 score) on 2026-10-04, since 2 and 1 appear elsewhere.
  const scores = new Set([...facts.live, ...facts.newlyCut, ...facts.newlyBeatenInPlay].map(g => g.score.replace(/\s/g, '').replace(/[–‑:]/g, '-')))
  // a dash only: "13:00" is a kick-off time, not a score
  for (const m of text.matchAll(/(\d+)\s*[-–‑]\s*(\d+)(?!\s*(?:%|′|'|min))/g)) {
    const sc = `${m[1]}-${m[2]}`
    if (!scores.has(sc)) issues.push(`score "${m[0].trim()}" is not a score in the facts`)
  }
  // "<team> lead(s)/ahead" must name the team the facts say is leading (and "trail/behind" the other one)
  const keyWord = (team: string) => team.toLowerCase().split(/\s+/).find(w => w.length >= 4 && !/^(club|real|sporting|athletic|atletico|deportivo|city|united)$/.test(w)) ?? team.toLowerCase()
  for (const g of facts.live) {
    if (!g.leading || g.leading === 'unknown') continue
    const [home, away] = g.game.split(' vs '); if (!away) continue
    for (const team of [home, away]) {
      const w = keyWord(team).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const near = new RegExp(`${w}[^.;,]{0,25}?\\b(leads?|leading|ahead|trails?|trailing|behind|draw|level)\\b`, 'i').exec(text)
      if (!near) continue
      const says = /lead|ahead/i.test(near[1]) ? 'ahead' : /trail|behind/i.test(near[1]) ? 'behind' : 'level'
      const truth = g.leading === 'level' ? 'level' : g.leading === team ? 'ahead' : 'behind'
      if (says !== truth) issues.push(`says ${team} is ${says} in ${g.game}; the score ${g.score} has them ${truth}`)
    }
  }
  if (text.length > 900) issues.push('too long')
  // a reply cut off mid-sentence ("…Anagennisi Karditsas 1904 is", 2026-10-04) is not an update
  if (!/[.!?)"’”]\s*$/.test(text.trim())) issues.push('ends mid-sentence (the reply was cut off)')
  return [...new Set(issues)]
}

export const SYSTEM = `You write the live update for a betting session, like a calm sports desk. Use ONLY the facts given (JSON).
Rules: 1-3 short sentences, under 60 words. Lead with what changed since the last update. Always state how many jackpot slips are alive
and the chance of a win (as given, with %). If "firstCheck" is true, summarise "soFar" instead of listing games.
Name at most 3 games. A live score is HOME-AWAY (the game is "Home vs Away"); "leading" says who is ahead — use it. The lists are examples only: for how many slips or games were cut, use "cutSinceLastCheck" (never count the list). A nextUp game with "overdue": true is past its kick-off time but SportyBet says it hasn't
started — call it delayed or possibly postponed, never "kicks off at". A newlyCut game with "wasBeatenInPlay": true only confirms slips that were ALREADY lost (no slip
died because of it) — say it confirmed earlier losses, never that it cut or knocked out slips. Mention floor tickets only if they changed. If "cashedOut.newly" is not empty, say which slip was cashed out and for how much — it's money back, neither a win nor a loss. If "placement.mismatches" is not
empty, say so first. Amounts are Nigerian naira (₦) — never £, $ or €. Never invent a number, game, score or prediction;
never claim an edge. Don't say what made the chance change (it also moves as games are played) — just state it.
No headings, no bullet points.`

