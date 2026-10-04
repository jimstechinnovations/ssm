// lib/monitor/tick.ts — the live monitor: one "tick" does what an operator watching a session does.
//   1. settle results (finished games settle slips; floor tickets settle as "at least k of N")
//   2. survivors now (in-play kills too), chance of ≥1 jackpot, the games still riding on them
//   3. placement correctness: every placed slip vs the account's open bets on SportyBet (when the
//      browser is up), and the site's receipts vs what was built
//   4. diff against the previous tick → what CHANGED (cuts, in-play kills, floor wins/losses, chance)
//   5. an update written by the AI from those facts only — then VERIFIED: every number it writes must
//      appear in the facts and the currency must be ₦. A failed check keeps the factual text instead
//      and records the AI's draft + the problems, so its quality can be reviewed.
// The feed lives in session.meta.monitor (newest last, capped).

import { getSession, updateSession, listSessionSlips } from '../sessions/store'
import { settleSessionNow } from '../sessions/settle'
import { runCoverage } from '../pedlas/coverage-run'
import { refreshLogin } from '../placement/browser'
import { nimChat, nimConfigured, nimModel } from '../llm/nim'
import { SYSTEM, checkDraft, factsText, forAi, leaderOf, type MonitorFacts, type MonitorDetail, type MonitorEvent } from './check'
export type { MonitorFacts, MonitorDetail, MonitorEvent } from './check'

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>

interface Snapshot { aliveKeys?: string[]; aliveNow: number; chancePct: number; cutGames: string[]; inPlayKeys: string[]; floorWon: number; floorLost: number; winners: string[]; at: string }
interface MonitorState { last?: Snapshot; feed: MonitorEvent[] }

const FEED_CAP = 80
const MIN_GAP_MS = 4 * 60_000            // ticks closer than this return the feed unchanged
const HEARTBEAT_MS = 30 * 60_000         // an update even when nothing changed, so the feed shows it's alive

const r2 = (x: number) => Math.round(x * 100) / 100
const RELOGIN_GAP_MS = 15 * 60_000      // at most one automatic re-login per 15 min (an OTP/captcha won't loop)
let lastRelogin = 0

/** Build the facts for one tick (also used by scripts/monitor-eval.ts to grade models). */
export async function buildFacts(session: Session, prev: Snapshot | undefined, opts: { site?: boolean } = {}): Promise<{ facts: MonitorFacts; snap: Snapshot; detail: MonitorDetail }> {
  await settleSessionNow(session).catch(() => null)
  const fresh = (await getSession(session.id)) ?? session
  let cov = await runCoverage(fresh, { site: opts.site ?? true })
  // SportyBet expired the login (HTTP 401 on the account check): log back in once and check again
  let relogin: string | null = null
  const siteErr = 'site' in cov ? String((cov.site as { error?: string } | null)?.error ?? '') : ''
  if (/401/.test(siteErr) && Date.now() - lastRelogin > RELOGIN_GAP_MS) {
    lastRelogin = Date.now()
    const r = await refreshLogin()
    relogin = r.ok ? 'logged back into SportyBet automatically' : `automatic re-login failed (${r.steps.at(-1) ?? 'unknown'}) — log in in the Chrome window`
    if (r.ok) cov = await runCoverage(fresh, { site: true })
  }
  let slips = await listSessionSlips(fresh.id, { withLegs: false })
  // a game can finish between the settle above and the survival read: if the database still holds more
  // unsettled jackpot slips than are alive at full time, settle again so both agree before writing
  // (caught by the audit 2026-10-03: survival said 1 alive, the database still had 2 open)
  const openJack = (xs: typeof slips) => xs.filter(s => (s.decision as { product?: string } | null)?.product !== 'flexi' && (s.status === 'placed' || s.status === 'won')).length
  if ('mode' in cov && openJack(slips) !== cov.aliveAtFullTime) {
    await settleSessionNow((await getSession(session.id)) ?? fresh).catch(() => null)
    slips = await listSessionSlips(fresh.id, { withLegs: false })
  }
  const isFloor = (s: { decision?: unknown }) => (s.decision as { product?: string } | null)?.product === 'flexi'
  const floor = slips.filter(isFloor), jack = slips.filter(s => !isFloor(s))
  const placedish = (s: { status: string }) => ['placed', 'won', 'lost', 'cashed_out'].includes(s.status)
  const cashed = slips.filter(s => s.status === 'cashed_out')
  // cash-outs this check found on SportyBet and recorded (lib/pedlas/coverage-run.ts)
  const newlyCashed = ('site' in cov ? (cov.site as { cashedOut?: { key: string; paid: number }[] } | null)?.cashedOut : undefined) ?? []
  const floorWon = floor.filter(s => s.status === 'won'), floorLost = floor.filter(s => s.status === 'lost')

  const c = 'mode' in cov ? cov : null
  const aliveNow = c?.aliveNow ?? 0, chancePct = c ? r2(100 * c.now.pAnyWin) : 0
  const cutNow = (c?.timeline ?? []).slice(1).filter(t => t.cut > 0)
  const prevCut = new Set(prev?.cutGames ?? [])
  const ek = c?.earlyKilled ?? []
  const prevEk = new Set(prev?.inPlayKeys ?? [])
  const winnersNow = jack.filter(s => s.status === 'won')
  // which slips actually DIED since the last check: the survival timeline re-assigns a loss to an earlier-
  // kicking-off game when that game finishes later, so "cut by game X" can appear with no slip newly lost
  // (live 2026-10-03: "two matches each knocked out one slip" while 3 stayed alive)
  const aliveKeysNow = (c?.aliveSlips ?? []).map(x => x.key)
  const lostSince = prev?.aliveKeys ? prev.aliveKeys.filter(k => !aliveKeysNow.includes(k)).length : null

  const facts: MonitorFacts = {
    at: new Date().toISOString(),
    jackpot: {
      total: jack.filter(placedish).length, aliveNow, aliveAtFullTime: c?.aliveAtFullTime ?? 0, chancePct,
      aliveChange: prev ? aliveNow - prev.aliveNow : 0, chanceChangePct: prev ? r2(chancePct - prev.chancePct) : 0,
    },
    newlyCut: prev ? cutNow.filter(t => !prevCut.has(t.game)).map(t => ({ game: t.game, score: t.score ?? '', slipsCut: t.cut, wasBeatenInPlay: lostSince === 0 || (prev.inPlayKeys ?? []).some(k => k.endsWith(`|${t.game}`)) })) : [],
    newlyBeatenInPlay: prev ? ek.filter(k => !prevEk.has(`${k.key}|${k.game}`)).map(k => ({ game: k.game, score: k.score, pick: k.pick })) : [],
    live: (c?.now.journey ?? []).filter(g => g.status === 'live' && g.riding > 0).map(g => ({ game: g.game, score: g.liveScore ?? '', minute: g.minute ?? null, slipsRiding: g.riding, leading: leaderOf(g.game, g.liveScore) })),
    // soonest first (sorting by slips riding listed tomorrow 13:00 as "next" ahead of tonight's 22:00 games);
    // a kick-off on another UTC day carries the weekday ("Sun 13:00") so it can't read as today
    nextUp: (c?.now.journey ?? []).filter(g => g.status === 'pending' && g.riding > 0).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || b.riding - a.riding).slice(0, 3)
      .map(g => ({ game: g.game, kickoffUtc: (g.kickoff.slice(0, 10) === new Date().toISOString().slice(0, 10) ? '' : new Date(g.kickoff).toUTCString().slice(0, 3) + ' ') + g.kickoff.slice(11, 16), slipsRiding: g.riding, ...(Date.parse(g.kickoff) < Date.now() - 20 * 60_000 ? { overdue: true } : {}) })),   // overdue: past kick-off but SportyBet says not started (delayed / postponed)
    floor: {
      total: floor.filter(placedish).length, won: floorWon.length, lost: floorLost.length, open: floor.filter(s => s.status === 'placed').length,
      returnedNaira: Math.round(floorWon.reduce((x, s) => x + (s.returned ?? 0), 0)), stakedNaira: Math.round(floor.filter(placedish).reduce((x, s) => x + s.stake, 0)),
      // what changed since the last check (the AI only saw totals and left out 5 floor wins, 2026-10-04)
      newlyWon: prev ? floorWon.length - prev.floorWon : 0, newlyLost: prev ? floorLost.length - prev.floorLost : 0,
    },
    placement: { placed: slips.filter(placedish).length, stakedNaira: Math.round(slips.filter(placedish).reduce((x, s) => x + s.stake, 0)), openOnSportyBet: null, mismatches: [], checkNote: null },
    cashedOut: { slips: cashed.length, returnedNaira: Math.round(cashed.reduce((x, s) => x + (s.returned ?? 0), 0)), newly: newlyCashed.map(k => ({ slip: `#${k.key.split('#')[1]}`, paidNaira: Math.round(k.paid) })) },
    winners: winnersNow.map(s => ({ slip: `#${s.slipId}`, paysNaira: Math.round(s.returned ?? s.sitePayout ?? s.potentialPayout ?? 0) })),
    firstCheck: !prev,
    soFar: { cutGames: cutNow.length, slipsCut: cutNow.reduce((x, t) => x + t.cut, 0), beatenInPlay: ek.length },
  }
  // placement correctness against the account (only possible with the logged-in browser)
  const site = c?.site as Record<string, unknown> | null | undefined
  if (site && !site.error) {
    facts.placement.openOnSportyBet = Number(site.openInFamily ?? 0)
    if (relogin) facts.placement.checkNote = relogin
    const a = (site.aliveHereSettledOnSite as string[] | undefined) ?? [], b = (site.openOnSiteDeadHere as string[] | undefined) ?? []
    if (a.length) facts.placement.mismatches.push(`${a.length} slip(s) alive here but already settled on SportyBet: ${a.slice(0, 5).join(', ')}`)
    if (b.length) facts.placement.mismatches.push(`${b.length} slip(s) still open on SportyBet but beaten here (site not settled yet): ${b.slice(0, 5).join(', ')}`)
    if (Number(site.openNotInFamily ?? 0) > 0) facts.placement.mismatches.push(`${site.openNotInFamily} open bet(s) on the account that are not in this session`)
  } else facts.placement.checkNote = relogin && !/^logged back/.test(relogin) ? relogin : site?.error ? (/401/.test(String(site.error)) ? 'SportyBet login expired — log in in the Chrome window' : /browser|ECONNREFUSED/i.test(String(site.error)) ? 'SportyBet check needs the browser open' : `SportyBet check unavailable (${String(site.error).slice(0, 60)})`) : 'SportyBet check skipped'
  // the site's receipts must match what was placed
  const receiptOff = slips.filter(s => placedish(s) && s.siteStake != null && Math.abs(s.siteStake - s.stake) > 0.5)
  if (receiptOff.length) facts.placement.mismatches.push(`${receiptOff.length} slip(s) where SportyBet's stake differs from ours: ${receiptOff.slice(0, 5).map(s => `#${s.slipId} ₦${s.siteStake} vs ₦${s.stake}`).join(', ')}`)

  const snap: Snapshot = {
    // CUMULATIVE: a game whose result briefly failed to load drops out of the timeline and would otherwise
    // come back as a "new" cut (Chrobry 1-3 Warta, finished 12:50, reported as new at 14:08 on 2026-10-03)
    aliveKeys: aliveKeysNow, aliveNow, chancePct, cutGames: [...new Set([...(prev?.cutGames ?? []), ...cutNow.map(t => t.game)])],
    inPlayKeys: [...new Set([...(prev?.inPlayKeys ?? []), ...ek.map(k => `${k.key}|${k.game}`)])],
    floorWon: floorWon.length, floorLost: floorLost.length, winners: winnersNow.map(s => String(s.slipId)), at: facts.at,
  }
  const detail: MonitorDetail = {
    cuts: cutNow.map(t => ({ game: t.game, score: t.score ?? '', slipsCut: t.cut })).reverse(),
    beatenInPlay: ek.map(k => ({ game: k.game, score: k.score, pick: k.pick, slip: k.key })),
    live: facts.live,
    // what each surviving slip is worth now = its chance × what it pays: the yardstick for a cash-out offer
    // (on 2026-10-04 #22 was cashed out for ₦488 when it was worth ~₦730; later offers ran ~80-85%)
    alive: (c?.aliveSlips ?? []).map(s => ({ slip: `#${s.slipId}`, needs: s.needs, chancePct: r2(100 * s.pWin), paysNaira: Math.round(s.payout), worthNaira: Math.round(s.pWin * s.payout) }))
      .sort((a, b) => b.worthNaira - a.worthNaira),
  }
  return { facts, snap, detail }
}


export async function writeUpdate(facts: MonitorFacts): Promise<Omit<MonitorEvent, 'at' | 'kind' | 'facts'>> {
  const plain = factsText(facts)
  if (!nimConfigured()) return { text: plain, source: 'facts', verified: true }
  const t0 = Date.now()
  try {
    // reasoning models sometimes answer with their working-out instead of the update (seen live 2026-10-03):
    // the fact check catches it, and one more try (slightly different sampling) usually comes back clean
    const ask = (temperature: number) => nimChat([{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(forAi(facts)) }], { temperature, maxTokens: 1500, timeoutMs: 60_000 }).then(x => x.trim())
    let draft = await ask(0)
    let issues = checkDraft(draft, facts)
    if (issues.length || !draft) { const second = await ask(0.4); const i2 = checkDraft(second, facts); if (!i2.length && second) { draft = second; issues = [] } }
    if (!issues.length && draft) return { text: draft, source: 'ai', model: nimModel(), verified: true, latencyMs: Date.now() - t0 }
    return { text: plain, source: 'facts', model: nimModel(), verified: false, issues: issues.length ? issues : ['empty answer'], aiDraft: draft, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { text: plain, source: 'facts', verified: false, issues: [`AI unavailable: ${e instanceof Error ? e.message.slice(0, 100) : e}`], latencyMs: Date.now() - t0 }
  }
}

/** One monitor tick for a session. Returns the feed (unchanged when called again within MIN_GAP_MS). */
type TickResult = { feed: MonitorEvent[]; ticked: boolean; event?: MonitorEvent }
// One tick per session at a time: the background scheduler, an open page and a forced "Check now" can all
// ask at once, and two overlapping ticks would race on the same feed. A second caller shares the first's result.
// A tick that never finishes must not block every later one: on 4 Oct a check started while the internet
// was down hung, and every check for 2 hours waited on it. After TICK_LIMIT_MS the waiters give up and the
// next tick starts fresh (the stuck one can't be cancelled, but it re-reads the feed before it writes).
const TICK_LIMIT_MS = 4 * 60_000
const inFlight = new Map<string, Promise<TickResult>>()
export function monitorTick(sessionId: string, opts: { force?: boolean } = {}): Promise<TickResult> {
  const cur = inFlight.get(sessionId)
  if (cur) return cur
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`monitor check gave up after ${TICK_LIMIT_MS / 60_000} min (network or browser not answering)`)), TICK_LIMIT_MS) })
  const p = Promise.race([tickOnce(sessionId, opts), limit]).finally(() => { clearTimeout(timer); inFlight.delete(sessionId) })
  inFlight.set(sessionId, p)
  return p
}

async function tickOnce(sessionId: string, opts: { force?: boolean }): Promise<TickResult> {
  const session = await getSession(sessionId)
  if (!session) throw new Error('Unknown session')
  const state = ((session.meta ?? {}) as { monitor?: MonitorState }).monitor ?? { feed: [] }
  const last = state.feed.at(-1)
  if (!opts.force && last && Date.now() - Date.parse(last.at) < MIN_GAP_MS) return { feed: state.feed, ticked: false }

  const { facts, snap, detail } = await buildFacts(session, state.last)
  const changed = !state.last || facts.newlyCut.length > 0 || facts.newlyBeatenInPlay.length > 0 || facts.jackpot.aliveChange !== 0
    || snap.floorWon !== state.last.floorWon || snap.floorLost !== state.last.floorLost || snap.winners.length !== state.last.winners.length
    || facts.placement.mismatches.length > 0 || Math.abs(facts.jackpot.chanceChangePct) >= 0.15
  const stale = !last || Date.now() - Date.parse(last.at) >= HEARTBEAT_MS
  let event: MonitorEvent | undefined
  if (changed || stale) {
    const w = await writeUpdate(facts)
    event = { at: facts.at, detail, kind: facts.placement.mismatches.length || facts.winners.length > (state.last?.winners.length ?? 0) ? 'alert' : changed ? 'update' : 'heartbeat', facts, ...w }
  }
  // re-read right before writing: settle / placer may have written meta meanwhile
  const latest = (await getSession(session.id)) ?? session
  const cur = ((latest.meta ?? {}) as { monitor?: MonitorState }).monitor ?? { feed: [] }
  const feed = event ? [...cur.feed.map(e => ({ ...e, detail: undefined })), event].slice(-FEED_CAP) : cur.feed
  await updateSession(latest.id, { meta: { ...(latest.meta ?? {}), monitor: { last: snap, feed } } }, { touch: false })
  return { feed, ticked: true, event }
}
