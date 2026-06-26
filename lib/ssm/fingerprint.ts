// lib/ssm/fingerprint.ts
// Resolution fingerprint engine: a scoreline resolves a whole set of markets at once.
// Pure, no I/O. The rules ARE the table — the 0-0..N-N grid is generated from them.

export type FpMarket =
  | 'BTTS_YES' | 'BTTS_NO'
  | 'OVER_0_5' | 'OVER_1_5' | 'OVER_2_5' | 'OVER_3_5' | 'OVER_4_5' | 'OVER_5_5'
  | 'UNDER_1_5' | 'UNDER_2_5' | 'UNDER_3_5' | 'UNDER_4_5' | 'UNDER_5_5'
  | 'ODD' | 'EVEN'
  | 'DC12' | 'DC1X' | 'DCX2'
  | 'HOME' | 'DRAW' | 'AWAY'

export interface Scoreline { home: number; away: number }

/** True iff market `m` resolves Yes for scoreline `s`. Single source of truth. */
export function resolveMarket(m: FpMarket, s: Scoreline): boolean {
  const t = s.home + s.away
  switch (m) {
    case 'BTTS_YES':  return s.home > 0 && s.away > 0
    case 'BTTS_NO':   return s.home === 0 || s.away === 0
    case 'OVER_0_5':  return t >= 1
    case 'OVER_1_5':  return t >= 2
    case 'OVER_2_5':  return t >= 3
    case 'OVER_3_5':  return t >= 4
    case 'OVER_4_5':  return t >= 5
    case 'OVER_5_5':  return t >= 6
    case 'UNDER_1_5': return t <= 1
    case 'UNDER_2_5': return t <= 2
    case 'UNDER_3_5': return t <= 3
    case 'UNDER_4_5': return t <= 4
    case 'UNDER_5_5': return t <= 5
    case 'ODD':       return t % 2 === 1
    case 'EVEN':      return t % 2 === 0
    case 'DC12':      return s.home !== s.away
    case 'DC1X':      return s.home >= s.away
    case 'DCX2':      return s.home <= s.away
    case 'HOME':      return s.home > s.away
    case 'DRAW':      return s.home === s.away
    case 'AWAY':      return s.home < s.away
  }
}

/** All scorelines with each side in [0, maxGoals]. */
export function allScorelines(maxGoals = 6): Scoreline[] {
  const out: Scoreline[] = []
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) out.push({ home: h, away: a })
  }
  return out
}

const ALL_MARKETS: FpMarket[] = [
  'BTTS_YES', 'BTTS_NO',
  'OVER_0_5', 'OVER_1_5', 'OVER_2_5', 'OVER_3_5', 'OVER_4_5', 'OVER_5_5',
  'UNDER_1_5', 'UNDER_2_5', 'UNDER_3_5', 'UNDER_4_5', 'UNDER_5_5',
  'ODD', 'EVEN', 'DC12', 'DC1X', 'DCX2', 'HOME', 'DRAW', 'AWAY',
]

/** The full resolved-market set for a scoreline. */
export function fingerprint(s: Scoreline): Record<FpMarket, boolean> {
  const out = {} as Record<FpMarket, boolean>
  for (const m of ALL_MARKETS) out[m] = resolveMarket(m, s)
  return out
}

/** Maps the exact odds labels v3 emits (OddsValue.label) onto fingerprint markets. */
const LABEL_TO_MARKET: Record<string, FpMarket> = {
  'BTTS Yes': 'BTTS_YES', 'BTTS No': 'BTTS_NO',
  'Over 0.5': 'OVER_0_5', 'Over 1.5': 'OVER_1_5', 'Over 2.5': 'OVER_2_5', 'Over 3.5': 'OVER_3_5',
  'Under 1.5': 'UNDER_1_5', 'Under 2.5': 'UNDER_2_5', 'Under 3.5': 'UNDER_3_5',
  'Odd': 'ODD', 'Even': 'EVEN',
  'DC 12': 'DC12', 'DC 1X': 'DC1X', 'DC X2': 'DCX2',
  'Home': 'HOME', 'Draw': 'DRAW', 'Away': 'AWAY',
}

export function labelToMarket(label: string): FpMarket | null {
  return LABEL_TO_MARKET[label] ?? null
}
