import { describe, it, expect } from 'vitest'
import { selectionsFromMarkets, ruleWins, orderGames, type SbMarket, type SelectionGame } from '../../../lib/pedlas/selections'
import { calibrateTable, probOf, devigged } from '../../../lib/pedlas/scoreline-table'
import { runDecisionBot } from '../../../lib/pedlas/decision-bot'
import { settleSlip, legOutcome } from '../../../lib/pedlas/settle-slips'
import { boostFor } from '../../../lib/pedlas/boost'
import { sportyBonus, type SportyBonusPlan } from '../../../lib/books/sportybet-bonus'

// ── synthetic book: true scoreline distribution = independent Poisson, every pair priced with a 5% margin ──
const pois = (l: number, k: number) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p }
function trueP(lh: number, la: number, pred: (h: number, a: number) => boolean) {
  let s = 0; for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) if (pred(h, a)) s += pois(lh, h) * pois(la, a); return s
}
const MARGIN = 0.05
const price = (p: number) => (1 / (p * (1 + MARGIN))).toFixed(2)
function markets(lh: number, la: number): SbMarket[] {
  const two = (id: string, spec: string, a: [string, string, (h: number, a: number) => boolean], b: [string, string, (h: number, a: number) => boolean]): SbMarket =>
    ({ id, specifier: spec, status: 0, outcomes: [{ id: a[0], desc: a[1], odds: price(trueP(lh, la, a[2])), isActive: 1 }, { id: b[0], desc: b[1], odds: price(trueP(lh, la, b[2])), isActive: 1 }] })
  const ms: SbMarket[] = [
    { id: '1', status: 0, outcomes: [{ id: '1', desc: 'Home', odds: price(trueP(lh, la, (h, a) => h > a)), isActive: 1 }, { id: '2', desc: 'Draw', odds: price(trueP(lh, la, (h, a) => h === a)), isActive: 1 }, { id: '3', desc: 'Away', odds: price(trueP(lh, la, (h, a) => a > h)), isActive: 1 }] },
    { id: '10', status: 0, outcomes: [{ id: '9', desc: 'Home or Draw', odds: price(trueP(lh, la, (h, a) => h >= a)), isActive: 1 }, { id: '10', desc: 'Home or Away', odds: price(trueP(lh, la, (h, a) => h !== a)), isActive: 1 }, { id: '11', desc: 'Draw or Away', odds: price(trueP(lh, la, (h, a) => a >= h)), isActive: 1 }] },
    two('29', '', ['74', 'Yes', (h, a) => h > 0 && a > 0], ['76', 'No', (h, a) => h === 0 || a === 0]),
    two('26', '', ['70', 'Odd', (h, a) => (h + a) % 2 === 1], ['72', 'Even', (h, a) => (h + a) % 2 === 0]),
    two('31', '', ['74', 'Yes', (_h, a) => a === 0], ['76', 'No', (_h, a) => a > 0]),
    two('32', '', ['74', 'Yes', (h) => h === 0], ['76', 'No', (h) => h > 0]),
  ]
  for (const L of [0.5, 1.5, 2.5, 3.5, 4.5]) ms.push(two('18', `total=${L}`, ['12', `Over ${L}`, (h, a) => h + a > L], ['13', `Under ${L}`, (h, a) => h + a < L]))
  for (const L of [0.5, 1.5]) {
    ms.push(two('19', `total=${L}`, ['12', `Over ${L}`, (h) => h > L], ['13', `Under ${L}`, (h) => h < L]))
    ms.push(two('20', `total=${L}`, ['12', `Over ${L}`, (_h, a) => a > L], ['13', `Under ${L}`, (_h, a) => a < L]))
  }
  return ms
}
const LAMBDAS: [number, number][] = [[1.6, 1.1], [2.1, 0.8], [1.2, 1.3], [1.9, 1.4], [0.9, 1.0], [2.4, 0.7], [1.4, 1.6], [1.1, 0.9], [1.7, 1.2], [2.0, 1.5], [1.3, 1.1], [1.8, 0.6], [1.0, 1.2], [1.5, 1.5], [2.2, 1.0], [1.2, 0.8]]
function games(): SelectionGame[] {
  return LAMBDAS.map(([lh, la], i) => ({
    fixtureId: 1000 + i, home: `Home${i}`, away: `Away${i}`, game: `Home${i} vs Away${i}`, league: 'Test League',
    kickoff: new Date(Date.UTC(2026, 9, 10, 12 + Math.floor(i / 3))).toISOString(), selections: selectionsFromMarkets(markets(lh, la)),
  }))
}

describe('selection catalogue', () => {
  it('every selection and its flip split every scoreline exactly (one wins, the other loses)', () => {
    const sels = games()[0].selections
    expect(sels.length).toBeGreaterThanOrEqual(30)
    for (const s of sels) {
      const flip = sels.find(x => x.key === s.flipKey)!
      expect(flip).toBeTruthy()
      for (let h = 0; h <= 8; h++) for (let a = 0; a <= 8; a++) expect(ruleWins(s.rule, h, a)).toBe(!ruleWins(flip.rule, h, a))
    }
  })
  it('orders games by kickoff, then shortest match name, then A→Z', () => {
    const k = '2026-10-10T14:00:00.000Z'
    const o = orderGames([
      { game: 'Ipswich Town vs Fulham', kickoff: k }, { game: 'Arsenal vs Leeds United', kickoff: '2026-10-10T11:30:00.000Z' },
      { game: 'Chelsea vs Bournemouth', kickoff: k }, { game: 'Leeds vs Spurs', kickoff: k },
    ])
    expect(o.map(g => g.game)).toEqual(['Arsenal vs Leeds United', 'Leeds vs Spurs', 'Chelsea vs Bournemouth', 'Ipswich Town vs Fulham'])
  })
})

describe('calibrated scoreline table', () => {
  it('recovers the book\'s de-vigged prices and never makes a selection look better than fair', () => {
    for (const g of games().slice(0, 6)) {
      const t = calibrateTable(g.selections)
      expect(t.maxError).toBeLessThan(0.01)
      for (const s of g.selections) {
        expect(Math.abs(probOf(t, s) - devigged(s, g.selections))).toBeLessThan(0.012)
        expect(probOf(t, s) * s.odds).toBeLessThan(1.005)          // keep per leg ≤ 1 (≈ 1/(1+margin))
      }
    }
  })
})

describe('Decision Bot', { timeout: 60_000 }, () => {
  const cfg = { stake: 10, target: 2000, budget: 300, boost: boostFor, rule: 'greedy' as const, seed: 42, allowSubMinLegs: false, evalDays: 4000 }
  it('every slip pays inside the target band and every slip is −vig', () => {
    const r = runDecisionBot(games(), cfg)
    expect(r.slips.length).toBe(30)
    for (const s of r.slips) {
      expect(s.payout).toBeGreaterThanOrEqual(2000)
      expect(s.payout).toBeLessThanOrEqual(2020)
      expect(s.keep).toBeLessThan(1)
      expect(s.legs.every(l => l.why.length > 10)).toBe(true)      // every pick is explained
    }
  })
  it('is reproducible: same seed ⇒ same slips and the same decision log', () => {
    const a = runDecisionBot(games(), cfg), b = runDecisionBot(games(), cfg)
    expect(a.slips.map(s => s.legs.map(l => l.selection.key).join('|'))).toEqual(b.slips.map(s => s.legs.map(l => l.selection.key).join('|')))
    expect(a.slips.map(s => s.why)).toEqual(b.slips.map(s => s.why))
  })
  it('slips walk the games in order from the first game, without skipping', () => {
    const r = runDecisionBot(games(), cfg)
    for (const s of r.slips) s.legs.forEach((l, i) => expect(l.game).toBe(i))
  })
  it('reports a book-consistent win chance: never above Σ P(slip wins)', () => {
    for (const rule of ['greedy', 'random', 'flip', 'weighted'] as const) {
      const r = runDecisionBot(games(), { ...cfg, rule })
      expect(r.pAnyWin).toBeLessThanOrEqual(r.ceiling + 1e-9)
      expect(r.keepRate).toBeLessThan(1)
    }
  })
  it('greedy beats random on the chance that ≥1 slip wins (fingerprint overlap removed)', () => {
    const g = runDecisionBot(games(), { ...cfg, rule: 'greedy' }), r = runDecisionBot(games(), { ...cfg, rule: 'random' })
    expect(g.pAnyWin).toBeGreaterThan(r.pAnyWin)
  })
  it('legs under 1.20 simply do not count toward the bonus (they do not cancel it)', () => {
    const r = runDecisionBot(games(), { ...cfg, allowSubMinLegs: true, rule: 'weighted' })
    for (const s of r.slips) {
      const q = s.legs.filter(l => l.selection.odds >= 1.2)
      const qOdds = q.reduce((x, l) => x * l.selection.odds, 1)
      // payout = stake × (Π all odds + Π qualifying odds × table(n qualifying)) — capped to the band by the build
      expect(s.payout).toBeCloseTo(10 * (s.combinedOdds + qOdds * boostFor(q.length)), 1)
    }
  })
  it('flip rule prefers the flip of the previous slip\'s picks', () => {
    const r = runDecisionBot(games(), { ...cfg, rule: 'flip' })
    expect(r.slips.slice(1).some(s => s.legs.some(l => /flip of slip/.test(l.why)))).toBe(true)
  })
})

describe('rule-aware settlement', () => {
  const R = (home: number, away: number) => ({ finished: true, total: home + away, home, away })
  it('settles every market from the final score', () => {
    const results = new Map([[1, R(2, 1)], [2, R(0, 0)], [3, R(1, 3)]])
    const legs = [
      { fixtureId: 1, rule: { kind: '1x2' as const, pick: 'H' as const } },
      { fixtureId: 2, rule: { kind: 'btts' as const, yes: false } },
      { fixtureId: 3, rule: { kind: 'clean_sheet' as const, team: 'home' as const, yes: false } },
    ]
    expect(settleSlip(legs, results)).toBe('won')
    expect(settleSlip([...legs, { fixtureId: 3, rule: { kind: 'dc' as const, pick: 'HD' as const } }], results)).toBe('lost')
  })
  it('legacy Over/Under legs still settle from a total-only result; other markets wait for the full score', () => {
    const totalOnly = new Map([[1, { finished: true, total: 3 }]])
    expect(settleSlip([{ fixtureId: 1, side: 'Under', line: 4.5 }], totalOnly)).toBe('won')
    expect(legOutcome({ fixtureId: 1, rule: { kind: '1x2', pick: 'H' } }, totalOnly.get(1))).toBeNull()
  })
  it('a dropped (suspended) leg never decides the slip', () => {
    const results = new Map([[1, R(3, 3)], [2, R(1, 0)]])
    expect(settleSlip([{ fixtureId: 1, rule: { kind: '1x2', pick: 'H' }, suspended: true }, { fixtureId: 2, rule: { kind: '1x2', pick: 'H' } }], results)).toBe('won')
  })
})

describe('SportyBet bonus = the site formula', () => {
  // plan MBB_1788955181864 (2026-09-09) as served by /promotion/v2/bonus/plans/valid; football factor 0.6
  const plan: SportyBonusPlan = {
    planName: 'MBB_1788955181864', oddsLimit: 1.2, factor: 1, fetchedAt: 0, tournamentFactor: new Map(),
    ratios: new Map([[4, { min: 0, max: 0.08 }], [6, { min: 0.07, max: 0.16 }]]), sportFactor: new Map([['sr:sport:1', 0.6]]),
  }
  it('matches real SportyBet betslips to the kobo (read 2026-09-25)', () => {
    // KPAQ1W: 9.5 × 3.6 × 2.85 × 4.9 on ₦10 → betslip showed Max bonus ₦229.24, Potential Win ₦5,005.28
    const b3 = sportyBonus([9.5, 3.6, 2.85, 4.9].map(odds => ({ odds })), plan)
    expect(b3.pct).toBeCloseTo(0.048, 6)
    expect(10 * (477.6 + b3.perStake)).toBeCloseTo(5005.28, 1)
    // M0T3BT at the site's odds of the moment (product 425.24): 6 qualifying legs → 9.6% → ₦408.23 bonus
    const b2 = sportyBonus([2.4, 4.1, 1.76, 3.25, 1.76, 4.4].map(odds => ({ odds })), plan)
    expect(b2.pct).toBeCloseTo(0.096, 6)
    // YE53N0: two legs under 1.20 don't count — 4 qualifying legs → still 4.8%, not cancelled
    const b1 = sportyBonus([4.8, 8.1, 2.85, 4.1, 1.02, 1.08].map(odds => ({ odds })), plan)
    expect(b1.qualifying).toBe(4)
    expect(b1.pct).toBeCloseTo(0.048, 6)
  })
})
