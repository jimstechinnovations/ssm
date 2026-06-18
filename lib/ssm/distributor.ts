// lib/ssm/distributor.ts
// Pure function: distributes 56 slips across 6 or 7 accounts using a
// deterministic round-robin algorithm.
//
// v3.1: Added BRIDGE tier (14 slips — three-flip + four-flip midpoint coverage).
// Total slips: 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS = 56.

import type { AccountAllocation, AccountProfile, SessionConfig, Slip } from './types'

// ---------------------------------------------------------------------------
// Distribution templates
// ---------------------------------------------------------------------------

interface AccountTemplate {
  core:   number
  pivot:  number
  bridge: number
  chaos:  number
  profile: AccountProfile
}

/**
 * 7-account layout — total: 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS = 56
 *
 * Design goals:
 *  - Every account gets at least 1 PIVOT (single-flip error-correcting)
 *  - BRIDGE slips spread evenly — 2 per account
 *  - CHAOS only in the first 4 "Balanced Aggressive" accounts (1 each)
 *  - CORE distributed to fill the remaining slots
 *
 * Account profiles:
 *   Acc 1–4: Balanced Aggressive  — 3 Core + 1 Pivot + 2 Bridge + 1 Chaos = 7 slips
 *   Acc 5:   Standard Accumulator — 4 Core + 2 Pivot + 2 Bridge + 0 Chaos = 8 slips
 *   Acc 6–7: Heavy Core           — 6 Core + 1 Pivot + 2 Bridge + 0 Chaos = 9 slips
 *
 * Totals: (3×4 + 4 + 6×2) = 12+4+12 = 28 ≠ 30. Adjust:
 *   Acc 1–4: 3 Core each = 12
 *   Acc 5:   4 Core       =  4
 *   Acc 6–7: 7 Core each = 14
 *   Total = 30 ✓
 *
 *   Pivot: 1+1+1+1+2+1+1 = 8 ✓
 *   Bridge: 2×7 = 14 ✓
 *   Chaos: 1+1+1+1+0+0+0 = 4 ✓
 *   Grand total: 56 ✓
 */
const DISTRIBUTION_7: AccountTemplate[] = [
  { core: 3, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 1
  { core: 3, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 2
  { core: 3, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 3
  { core: 3, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 4
  { core: 4, pivot: 2, bridge: 2, chaos: 0, profile: 'Standard Accumulator'}, // Acc 5
  { core: 7, pivot: 1, bridge: 2, chaos: 0, profile: 'Heavy Core'           }, // Acc 6
  { core: 7, pivot: 1, bridge: 2, chaos: 0, profile: 'Heavy Core'           }, // Acc 7
]
// Verify: core=3+3+3+3+4+7+7=30, pivot=1+1+1+1+2+1+1=8, bridge=2×7=14, chaos=1+1+1+1=4 → 56 ✓

/**
 * 6-account layout — total: 30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS = 56
 *
 *   Acc 1–4: Balanced Aggressive  — 4 Core + 1 Pivot + 2 Bridge + 1 Chaos = 8 slips
 *   Acc 5–6: Standard Accumulator — 7 Core + 2 Pivot + 3 Bridge + 0 Chaos = 12 slips
 *
 *   Core:  4×4 + 7×2 = 16+14 = 30 ✓
 *   Pivot: 1×4 + 2×2 = 4+4   =  8 ✓
 *   Bridge:2×4 + 3×2 = 8+6   = 14 ✓
 *   Chaos: 1×4 + 0   =  4    =  4 ✓
 *   Total: 56 ✓
 */
const DISTRIBUTION_6: AccountTemplate[] = [
  { core: 4, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 1
  { core: 4, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 2
  { core: 4, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 3
  { core: 4, pivot: 1, bridge: 2, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 4
  { core: 7, pivot: 2, bridge: 3, chaos: 0, profile: 'Standard Accumulator'}, // Acc 5
  { core: 7, pivot: 2, bridge: 3, chaos: 0, profile: 'Standard Accumulator'}, // Acc 6
]
// Verify: core=4+4+4+4+7+7=30, pivot=1+1+1+1+2+2=8, bridge=2+2+2+2+3+3=14, chaos=1×4=4 → 56 ✓

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateTemplate(
  template: AccountTemplate[],
  availableCore:   number,
  availablePivot:  number,
  availableBridge: number,
  availableChaos:  number,
  numAccounts: number,
): void {
  const totalCore   = template.reduce((s, t) => s + t.core,   0)
  const totalPivot  = template.reduce((s, t) => s + t.pivot,  0)
  const totalBridge = template.reduce((s, t) => s + t.bridge, 0)
  const totalChaos  = template.reduce((s, t) => s + t.chaos,  0)
  const total = totalCore + totalPivot + totalBridge + totalChaos

  if (total !== 56) {
    throw new Error(
      `distributeToAccounts: template for ${numAccounts} accounts sums to ${total} slips, expected 56`,
    )
  }
  if (totalCore !== availableCore) {
    throw new Error(
      `distributeToAccounts: template requires ${totalCore} CORE slips but ${availableCore} are available`,
    )
  }
  if (totalPivot !== availablePivot) {
    throw new Error(
      `distributeToAccounts: template requires ${totalPivot} PIVOT slips but ${availablePivot} are available`,
    )
  }
  if (totalBridge !== availableBridge) {
    throw new Error(
      `distributeToAccounts: template requires ${totalBridge} BRIDGE slips but ${availableBridge} are available`,
    )
  }
  if (totalChaos > availableChaos) {
    throw new Error(
      `distributeToAccounts: template requires ${totalChaos} CHAOS slips but only ${availableChaos} are available`,
    )
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Distribute 56 slips across 6 or 7 accounts using deterministic round-robin.
 *
 * @throws if config.numAccounts is not 6 or 7
 * @throws if slips don't contain exactly 30 CORE, 8 PIVOT, 14 BRIDGE, 4 CHAOS
 * @throws if total slip count across all accounts is not 56
 */
export function distributeToAccounts(
  slips: Slip[],
  config: SessionConfig,
): AccountAllocation[] {
  if (config.numAccounts !== 6 && config.numAccounts !== 7) {
    throw new Error(
      `distributeToAccounts: config.numAccounts must be 6 or 7, got ${config.numAccounts}`,
    )
  }

  const coreSlips   = slips.filter(s => s.tier === 'CORE'  ).sort((a, b) => a.slipId - b.slipId)
  const pivotSlips  = slips.filter(s => s.tier === 'PIVOT' ).sort((a, b) => a.slipId - b.slipId)
  const bridgeSlips = slips.filter(s => s.tier === 'BRIDGE').sort((a, b) => a.slipId - b.slipId)
  const chaosSlips  = slips.filter(s => s.tier === 'CHAOS' ).sort((a, b) => a.slipId - b.slipId)

  if (coreSlips.length !== 30) {
    throw new Error(`distributeToAccounts: expected 30 CORE slips, got ${coreSlips.length}`)
  }
  if (pivotSlips.length !== 8) {
    throw new Error(`distributeToAccounts: expected 8 PIVOT slips, got ${pivotSlips.length}`)
  }
  if (bridgeSlips.length !== 14) {
    throw new Error(`distributeToAccounts: expected 14 BRIDGE slips, got ${bridgeSlips.length}`)
  }
  if (chaosSlips.length !== 4) {
    throw new Error(`distributeToAccounts: expected 4 CHAOS slips, got ${chaosSlips.length}`)
  }

  const template = config.numAccounts === 7 ? DISTRIBUTION_7 : DISTRIBUTION_6
  validateTemplate(
    template,
    coreSlips.length,
    pivotSlips.length,
    bridgeSlips.length,
    chaosSlips.length,
    config.numAccounts,
  )

  let corePtr   = 0
  let pivotPtr  = 0
  let bridgePtr = 0
  let chaosPtr  = 0

  const allocations: AccountAllocation[] = []

  for (let i = 0; i < template.length; i++) {
    const t = template[i]
    const accountSlips: Slip[] = []

    for (let c = 0; c < t.core;   c++) { accountSlips.push(coreSlips[corePtr++])     }
    for (let p = 0; p < t.pivot;  p++) { accountSlips.push(pivotSlips[pivotPtr++])   }
    for (let b = 0; b < t.bridge; b++) { accountSlips.push(bridgeSlips[bridgePtr++]) }
    for (let ch = 0; ch < t.chaos; ch++) { accountSlips.push(chaosSlips[chaosPtr++]) }

    const actualCore   = accountSlips.filter(s => s.tier === 'CORE'  ).length
    const actualPivot  = accountSlips.filter(s => s.tier === 'PIVOT' ).length
    const actualBridge = accountSlips.filter(s => s.tier === 'BRIDGE').length
    const actualChaos  = accountSlips.filter(s => s.tier === 'CHAOS' ).length

    if (
      actualCore   !== t.core   ||
      actualPivot  !== t.pivot  ||
      actualBridge !== t.bridge ||
      actualChaos  !== t.chaos
    ) {
      throw new Error(
        `distributeToAccounts: account ${i + 1} has ` +
        `${actualCore}/${actualPivot}/${actualBridge}/${actualChaos} ` +
        `(Core/Pivot/Bridge/Chaos) but expected ` +
        `${t.core}/${t.pivot}/${t.bridge}/${t.chaos} for profile '${t.profile}'`,
      )
    }

    allocations.push({
      accountNumber:  i + 1,
      profile:        t.profile,
      slips:          accountSlips,
      totalStake:     accountSlips.reduce((sum, s) => sum + s.stake, 0),
      sessionHashes:  accountSlips.map(s => s.sessionHash),
    })
  }

  const grandTotal = allocations.reduce((sum, a) => sum + a.slips.length, 0)
  if (grandTotal !== 56) {
    throw new Error(
      `distributeToAccounts: total slips across all accounts is ${grandTotal}, expected 56`,
    )
  }

  return allocations
}
