/**
 * scripts/lib-form-model.mjs — recency-weighted Poisson goals model, ported from
 * lib/pedlas/predict.ts + lib/pedlas/scoreline-model.ts so the plain-JS build scripts can use the
 * same math without a TS build step. Pure functions, no I/O.
 */

function poissonPmf(k, lambda) {
  let fact = 1
  for (let i = 2; i <= k; i++) fact *= i
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact
}

/** P(total goals > line) under independent Poisson(lambdaHome), Poisson(lambdaAway). */
export function pHatOver(lambdaHome, lambdaAway, line, maxGoals = 12) {
  let pUnder = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) if (h + a <= line) pUnder += ph * poissonPmf(a, lambdaAway)
  }
  return Math.max(0, Math.min(1, 1 - pUnder))
}

/** P(a single Poisson(lambda) variable exceeds line) — for the Home/Away team-goals O/U markets. */
export function pMarginalOver(lambda, line, maxGoals = 12) {
  let pUnder = 0
  for (let k = 0; k <= maxGoals; k++) if (k <= line) pUnder += poissonPmf(k, lambda)
  return Math.max(0, Math.min(1, 1 - pUnder))
}

/** P(both teams score at least 1) under independent Poisson(lambdaHome), Poisson(lambdaAway). */
export function pBothScore(lambdaHome, lambdaAway) {
  return Math.max(0, Math.min(1, 1 - Math.exp(-lambdaHome) - Math.exp(-lambdaAway) + Math.exp(-(lambdaHome + lambdaAway))))
}

/** P(total goals is odd) under the same independent-Poisson grid. */
export function pOddTotal(lambdaHome, lambdaAway, maxGoals = 12) {
  let pOdd = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) if ((h + a) % 2 === 1) pOdd += ph * poissonPmf(a, lambdaAway)
  }
  return Math.max(0, Math.min(1, pOdd))
}

/** P(home goals - away goals === diff) — diff=1 is "Home by 1", diff=-1 is "Away by 1". */
export function pMarginExact(lambdaHome, lambdaAway, diff, maxGoals = 12) {
  let p = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) if (h - a === diff) p += ph * poissonPmf(a, lambdaAway)
  }
  return Math.max(0, Math.min(1, p))
}

/** P(lo <= total goals <= hi), hi=Infinity for the "7+" style open-ended bucket — for Goal Range. */
export function pGoalRange(lambdaHome, lambdaAway, lo, hi, maxGoals = 12) {
  let p = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) { const total = h + a; if (total >= lo && total <= hi) p += ph * poissonPmf(a, lambdaAway) }
  }
  return Math.max(0, Math.min(1, p))
}

/** P(home wins) and P(away wins) under the same grid, EXCLUDING draws (renormalised) — this is
 *  the direct analog of a Draw-No-Bet / Asian -0.5 handicap price: the draw is void, not a loss. */
/** Raw (unnormalized, sums to 1) 1X2 probabilities under independent Poisson(lambdaHome/Away). */
export function pMatchResult1X2(lambdaHome, lambdaAway, maxGoals = 12) {
  let pHome = 0, pAway = 0, pDraw = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph * poissonPmf(a, lambdaAway)
      if (h > a) pHome += p; else if (h < a) pAway += p; else pDraw += p
    }
  }
  return { pHome, pDraw, pAway }
}

export function pDecisiveWin(lambdaHome, lambdaAway, maxGoals = 12) {
  const { pHome, pDraw, pAway } = pMatchResult1X2(lambdaHome, lambdaAway, maxGoals)
  const decisive = pHome + pAway
  return decisive > 0 ? { pHomeWin: pHome / decisive, pAwayWin: pAway / decisive } : { pHomeWin: 0.5, pAwayWin: 0.5 }
}

/**
 * Recency-weighted expected goals for a fixture from each team's OWN last-N results (their form,
 * not head-to-head). Half-life weighting (recent matches count more), same shape as
 * lib/pedlas/predict.ts#estimateLambdas but self-contained (no shared league-average dataset — we
 * approximate league scoring rate from the two teams' own combined average, which is honest given
 * we don't have full league corpora here; it degrades to a neutral 1.25/1.25 baseline when data is
 * thin, same fallback predict.ts uses).
 */
export function estimateLambdas(homeResults, awayResults, homeTeam, awayTeam, opts = {}) {
  const halfLife = opts.halfLifeMatches ?? 5
  const LEAGUE_AVG = 1.25

  function form(results, team) {
    const ms = [...(results || [])].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    let wScored = 0, wConceded = 0, wsum = 0, n = 0
    ms.forEach((m, i) => {
      const isTeamHome = (m.home || '').toLowerCase().includes(team.toLowerCase().split(' ').pop().toLowerCase())
      const w = Math.pow(2, (i - (ms.length - 1)) / halfLife)
      wScored += w * (isTeamHome ? m.hg : m.ag)
      wConceded += w * (isTeamHome ? m.ag : m.hg)
      wsum += w; n++
    })
    return wsum > 0 ? { att: wScored / wsum, def: wConceded / wsum, n } : { att: LEAGUE_AVG, def: LEAGUE_AVG, n: 0 }
  }

  const H = form(homeResults, homeTeam), A = form(awayResults, awayTeam)
  return {
    lambdaHome: LEAGUE_AVG * (H.att / LEAGUE_AVG) * (A.def / LEAGUE_AVG),
    lambdaAway: LEAGUE_AVG * (A.att / LEAGUE_AVG) * (H.def / LEAGUE_AVG),
    nHome: H.n, nAway: A.n,
  }
}

/**
 * Form-implied probability for one of our candidate markets, or null if the market isn't a
 * goals/decisive-win shape we model (DC has no clean Poisson analog here, skipped).
 * `outcome` is only needed for the generic OU<line> case, to tell which side ("Over X"/"Under X")
 * was actually picked.
 */
export function formProbFor(market, lambdaHome, lambdaAway, outcome) {
  switch (market) {
    case 'U45': return 1 - pHatOver(lambdaHome, lambdaAway, 4.5)
    case 'O15': return pHatOver(lambdaHome, lambdaAway, 1.5)
    case 'DNB':
    case 'HCP': {
      const { pHomeWin, pAwayWin } = pDecisiveWin(lambdaHome, lambdaAway)
      return { pHomeWin, pAwayWin }
    }
    case 'DC': {
      const { pHome, pDraw, pAway } = pMatchResult1X2(lambdaHome, lambdaAway)
      if (/home.*draw/i.test(outcome || '')) return pHome + pDraw
      if (/draw.*away/i.test(outcome || '')) return pDraw + pAway
      if (/home.*away/i.test(outcome || '')) return pHome + pAway
      return null
    }
    case 'BTTS': return /^no/i.test(outcome || '') ? 1 - pBothScore(lambdaHome, lambdaAway) : pBothScore(lambdaHome, lambdaAway)
    case 'MARGIN1': return pMarginExact(lambdaHome, lambdaAway, /^home/i.test(outcome || '') ? 1 : -1)
    case 'GOALRANGE': {
      const m = /(\d+)-(\d+)/.exec(outcome || '')
      const plus = /(\d+)\+/.exec(outcome || '')
      if (m) return pGoalRange(lambdaHome, lambdaAway, Number(m[1]), Number(m[2]))
      if (plus) return pGoalRange(lambdaHome, lambdaAway, Number(plus[1]), Infinity)
      return null
    }
    default:
      if (/^OU/.test(market)) {
        const line = Number(market.slice(2))
        const pOver = pHatOver(lambdaHome, lambdaAway, line)
        return /^under/i.test(outcome || '') ? 1 - pOver : pOver
      }
      if (/^HOU/.test(market) || /^AOU/.test(market)) {
        const line = Number(market.slice(3))
        const lambda = /^HOU/.test(market) ? lambdaHome : lambdaAway
        const pOver = pMarginalOver(lambda, line)
        return /^under/i.test(outcome || '') ? 1 - pOver : pOver
      }
      return null
  }
}
