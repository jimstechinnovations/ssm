// scripts/tier-sim.ts — should part of the budget go to "budget-back" slips (₦100 → ≥ ₦3,000, ~30×)
// instead of the jackpot? (operator's idea 2026-10-04; flexi-jackpot-bench.ts showed a 30× plain slip keeps
// ~0.97 per ₦1 vs ~0.75 at 510×.)
//
// Each split is BUILT with the real bot (buildDecisionBotForAdapter, exactly as a session is built: live
// board, reference panel, live bonus plan, odds cap + coverage, floor tickets) and then all of its tickets
// are scored TOGETHER over simulated days: every game's scoreline is drawn once per day from a table fitted
// to every pick on it (lib/pedlas/survivors.ts tableFromPicks), so tickets sharing a game win and lose
// together — the correlation a per-ticket estimate misses.
//
//   npx tsx --env-file=.env --conditions=react-server scripts/tier-sim.ts [dateFrom] [dateTo] [budget]
import { buildDecisionBotForAdapter, type BotPedlasSlip } from '../lib/pedlas/build-bot'
import { getBook } from '../lib/books/registry'
import { fetchSportyBonusPlan, sportyBoostFn } from '../lib/books/sportybet-bonus'
import { tableFromPicks } from '../lib/pedlas/survivors'
import { legRuleOf, ruleWins, type LegRule } from '../lib/pedlas/selections'

const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const dateFrom = process.argv[2] ?? d(0), dateTo = process.argv[3] ?? d(1), BUDGET = Number(process.argv[4] ?? 3000)
const DAYS = 20_000, STAKE = 100, JACKPOT = 51_000, BACK = Number(process.env.BACK_TARGET ?? 3000)

type Tier = 'jackpot' | 'back' | 'floor'
interface Ticket { tier: Tier; stake: number; payout: number; k?: number; legs: { fixtureId: number; rule: LegRule; p: number }[] }

async function build(budget: number, target: number, floorShare: number, tier: Tier): Promise<Ticket[]> {
  if (budget <= 0) return []
  const boost = sportyBoostFn(await fetchSportyBonusPlan())
  const r = await buildDecisionBotForAdapter(getBook('sportybet'), {
    dateFrom, dateTo, budget, stake: STAKE, target, minKickoffGapMinutes: 90, band: 0.01, rule: 'greedy',
    allowSubMinLegs: true, boost, skip: true, maxLegs: 8, deadlineMs: 6 * 60_000, floorShare,
  })
  if (!r.slips) throw new Error(`build failed: ${r.error} ${r.detail ?? ''}`)
  return r.slips.map((s: BotPedlasSlip) => {
    const flexi = (s.decision as { product?: string; k?: number })?.product === 'flexi'
    const legs = (s.legs as unknown as { fixtureId: number; odds?: number; p?: number | null; suspended?: boolean }[]).filter(l => !l.suspended)
      .flatMap(l => { const rule = legRuleOf(l as never); return rule ? [{ fixtureId: l.fixtureId, rule, p: typeof l.p === 'number' && l.p > 0 ? l.p : 1 / ((l.odds ?? 2) * 1.05) }] : [] })
    return { tier: flexi ? 'floor' : tier, stake: s.stake, payout: s.payout, k: flexi ? (s.decision as { k: number }).k : undefined, legs }
  })
}

function simulate(tickets: Ticket[]) {
  const picks = new Map<number, { rule: LegRule; p: number }[]>()
  for (const t of tickets) for (const l of t.legs) { const a = picks.get(l.fixtureId) ?? []; a.push({ rule: l.rule, p: l.p }); picks.set(l.fixtureId, a) }
  const fids = [...picks.keys()]
  const cdf = new Map<number, Float64Array>()
  let N = 0
  for (const f of fids) { const t = tableFromPicks(picks.get(f)!); N = Math.round(Math.sqrt(t.length)); const c = new Float64Array(t.length); let s = 0; for (let i = 0; i < t.length; i++) { s += t[i]; c[i] = s } cdf.set(f, c) }
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  const staked = tickets.reduce((x, t) => x + t.stake, 0)
  const returns: number[] = []; let jack = 0, back = 0
  const tierRet: Record<Tier, number> = { jackpot: 0, back: 0, floor: 0 }, tierStake: Record<Tier, number> = { jackpot: 0, back: 0, floor: 0 }
  for (const t of tickets) tierStake[t.tier] += t.stake
  const score = new Map<number, [number, number]>()
  for (let day = 0; day < DAYS; day++) {
    for (const f of fids) { const c = cdf.get(f)!; const u = rnd() * c[c.length - 1]; let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < u) lo = m + 1; else hi = m } score.set(f, [Math.floor(lo / N), lo % N]) }
    let ret = 0, j = false, b = false
    for (const t of tickets) {
      let right = 0
      for (const l of t.legs) { const [h, a] = score.get(l.fixtureId)!; if (ruleWins(l.rule, h, a)) right++ }
      const won = t.k != null ? right >= t.k : right === t.legs.length
      if (won) { ret += t.payout; tierRet[t.tier] += t.payout; if (t.tier === 'jackpot') j = true; if (t.tier === 'back') b = true }
    }
    returns.push(ret); if (j) jack++; if (b) back++
  }
  returns.sort((x, y) => x - y)
  const share = (f: (r: number) => boolean) => returns.filter(f).length / DAYS
  return {
    staked, mean: returns.reduce((x, r) => x + r, 0) / DAYS, median: returns[DAYS >> 1],
    pJackpot: jack / DAYS, pBack: back / DAYS, pBudget: share(r => r >= staked), pHalf: share(r => r >= staked / 2),
    // what each kind of ticket returns per ₦1 (the 'keep' of jackpot / budget-back / floor as the bot builds them)
    perTier: (Object.keys(tierStake) as Tier[]).filter(t => tierStake[t] > 0).map(t => `${t} ${(tierRet[t] / DAYS / tierStake[t]).toFixed(3)}`).join(', '),
  }
}

async function main() {
  const splits: { name: string; jackpot: number; back: number; floor: number }[] = [
    { name: 'now: 75% jackpot · 25% floor', jackpot: 0.75, back: 0, floor: 0.25 },
    { name: '50% jackpot · 40% back · 10% floor', jackpot: 0.5, back: 0.4, floor: 0.1 },
    { name: '40% jackpot · 50% back · 10% floor', jackpot: 0.4, back: 0.5, floor: 0.1 },
    { name: '25% jackpot · 65% back · 10% floor', jackpot: 0.25, back: 0.65, floor: 0.1 },
  ]
  console.log(`board ${dateFrom}..${dateTo} · budget ₦${BUDGET} · ₦${STAKE} slips · jackpot ₦${JACKPOT} · budget-back ₦${BACK} · ${DAYS} simulated days`)
  // ONLY="now,40%" runs just the splits whose names contain one of those
  for (const s of splits.filter(x => !process.env.ONLY || process.env.ONLY.split(',').some(w => x.name.includes(w)))) {
    const t0 = Date.now()
    // the floor rides with the jackpot build (as in a real session): floorShare is its share of THAT build's budget
    const jb = BUDGET * (s.jackpot + s.floor)
    const tickets = [...await build(jb, JACKPOT, s.floor / (s.jackpot + s.floor), 'jackpot'), ...await build(BUDGET * s.back, BACK, 0, 'back')]
    const r = simulate(tickets)
    const n = (t: Tier) => tickets.filter(x => x.tier === t).length
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`
    console.log(`${s.name.padEnd(36)} tickets ${n('jackpot')}/${n('back')}/${n('floor')} · staked ₦${r.staked.toFixed(0)} · back on average ₦${r.mean.toFixed(0)} (${(r.mean / r.staked).toFixed(3)}) · median ₦${r.median.toFixed(0)} · ≥ budget ${pct(r.pBudget)} · ≥ half ${pct(r.pHalf)} · jackpot ${pct(r.pJackpot)} · a budget-back hit ${pct(r.pBack)} · per ₦1 by kind: ${r.perTier} · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
// Result 2026-10-05 (boards 5–6 and 6–7 Oct, ₦3,000): moving 40–50% of the budget to budget-back slips
// (₦100 → ₦3,000) lifts P(get the budget back) from ~3% to 25–34%; jackpot chance falls ~3% → ~1.7–2%; the
// AVERAGE return doesn't improve (0.68–0.81 either way). Per ₦1 as the bot builds them: jackpot 0.69–0.76,
// budget-back 0.72 (not the 0.97 of flexi-jackpot-bench's hand-picked best-value legs), floor 0.95.
