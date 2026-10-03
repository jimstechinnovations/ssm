// lib/monitor/check.ts — the pure half of the live monitor (no I/O): the facts' shape, the plain factual
// update, the AI's instructions, and the fact check every AI draft must pass. Unit-tested.

export interface MonitorFacts {
  at: string
  jackpot: { total: number; aliveNow: number; aliveAtFullTime: number; chancePct: number; aliveChange: number; chanceChangePct: number }
  newlyCut: { game: string; score: string; slipsCut: number; wasBeatenInPlay?: boolean }[]   // wasBeatenInPlay: those slips were already counted out while the game was live
  newlyBeatenInPlay: { game: string; score: string; pick: string }[]
  live: { game: string; score: string; minute: number | null; slipsRiding: number }[]
  nextUp: { game: string; kickoffUtc: string; slipsRiding: number; overdue?: boolean }[]
  floor: { total: number; won: number; lost: number; open: number; returnedNaira: number; stakedNaira: number }
  placement: { placed: number; stakedNaira: number; openOnSportyBet: number | null; mismatches: string[]; checkNote: string | null }
  winners: { slip: string; paysNaira: number }[]
  firstCheck: boolean                                     // no previous check: changes = everything so far
  soFar: { cutGames: number; slipsCut: number; beatenInPlay: number }
}
/** The full lists behind an update, for the UI's fold-away sections (not sent to the AI). */
export interface MonitorDetail {
  cuts: { game: string; score: string; slipsCut: number }[]
  beatenInPlay: { game: string; score: string; pick: string; slip: string }[]
  live: { game: string; score: string; minute: number | null; slipsRiding: number }[]
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
export const forAi = (f: MonitorFacts) => ({ ...f, live: f.live.slice(0, 4), newlyCut: f.newlyCut.slice(0, 4), newlyBeatenInPlay: f.newlyBeatenInPlay.slice(0, 4), nextUp: f.nextUp.slice(0, 2) })

/** The plain factual update — always correct, used when the AI is off or its draft fails the check. */
export function factsText(f: MonitorFacts): string {
  const list = <T,>(xs: T[], fmt: (x: T) => string) => xs.slice(0, 3).map(fmt).join('; ') + (xs.length > 3 ? ` (+${xs.length - 3} more)` : '')
  const parts: string[] = []
  if (f.placement.mismatches.length) parts.push(`⚠ ${f.placement.mismatches[0]}.`)
  if (f.winners.length) parts.push(`WINNER: ${f.winners.map(w => `${w.slip} pays ₦${w.paysNaira.toLocaleString()}`).join(', ')}.`)
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
  const toks = text.toLowerCase().split(/[^a-z0-9]+/)
  if (!toks.includes(String(n)) && !(word && toks.includes(word))) issues.push(`doesn't state the ${n} slips alive`)
  if (text.length > 900) issues.push('too long')
  return [...new Set(issues)]
}

export const SYSTEM = `You write the live update for a betting session, like a calm sports desk. Use ONLY the facts given (JSON).
Rules: 1-3 short sentences, under 60 words. Lead with what changed since the last update. Always state how many jackpot slips are alive
and the chance of a win (as given, with %). If "firstCheck" is true, summarise "soFar" instead of listing games.
Name at most 3 games. A nextUp game with "overdue": true is past its kick-off time but SportyBet says it hasn't
started — call it delayed or possibly postponed, never "kicks off at". A newlyCut game with "wasBeatenInPlay": true only confirms slips that were ALREADY lost (no slip
died because of it) — say it confirmed earlier losses, never that it cut or knocked out slips. Mention floor tickets only if they changed. If "placement.mismatches" is not
empty, say so first. Amounts are Nigerian naira (₦) — never £, $ or €. Never invent a number, game, score or prediction;
never claim an edge. Don't say what made the chance change (it also moves as games are played) — just state it.
No headings, no bullet points.`

