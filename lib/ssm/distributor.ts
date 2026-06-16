// lib/ssm/distributor.ts
// Pure function: distributes 42 slips across 6 or 7 accounts using a
// deterministic round-robin cross-contamination algorithm.

import type { AccountAllocation, AccountProfile, SessionConfig, Slip } from './types'

// ---------------------------------------------------------------------------
// Distribution templates
// ---------------------------------------------------------------------------

interface AccountTemplate {
  core: number
  pivot: number
  chaos: number
  profile: AccountProfile
}

/** 7-account layout — total: 30 Core + 8 Pivot + 4 Chaos = 42 */
const DISTRIBUTION_7: AccountTemplate[] = [
  { core: 4, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 1
  { core: 4, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 2
  { core: 4, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 3
  { core: 4, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 4
  { core: 4, pivot: 2, chaos: 0, profile: 'Standard Accumulator' }, // Acc 5
  { core: 5, pivot: 1, chaos: 0, profile: 'Heavy Core' },          // Acc 6
  { core: 5, pivot: 1, chaos: 0, profile: 'Heavy Core' },          // Acc 7
]

// Sanity check (compile-time constant verification via static assertion):
// 4+4+4+4+4+5+5 = 30 core, 1+1+1+1+2+1+1 = 8 pivot, 1+1+1+1+0+0+0 = 4 chaos

/** 6-account layout — total: 30 Core + 8 Pivot + 4 Chaos = 42 */
const DISTRIBUTION_6: AccountTemplate[] = [
  { core: 5, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 1
  { core: 5, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 2
  { core: 5, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 3
  { core: 5, pivot: 1, chaos: 1, profile: 'Balanced Aggressive' }, // Acc 4 — receives 4th chaos slip
  { core: 5, pivot: 2, chaos: 0, profile: 'Standard Accumulator' }, // Acc 5
  { core: 5, pivot: 2, chaos: 0, profile: 'Standard Accumulator' }, // Acc 6
]

// 5+5+5+5+5+5 = 30 core, 1+1+1+1+2+2 = 8 pivot, 1+1+1+1+0+0 = 4 chaos → grand total = 42

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify that a distribution template sums to exactly 42 total slips and
 * that Core and Pivot totals match their available queues exactly.
 * Chaos total may be ≤ the available queue (the 6-account template uses 3 of
 * the 4 chaos slips; the 4th is simply unused).
 */
function validateTemplate(
  template: AccountTemplate[],
  availableCore: number,
  availablePivot: number,
  availableChaos: number,
  numAccounts: number,
): void {
  const totalCore  = template.reduce((s, t) => s + t.core,  0)
  const totalPivot = template.reduce((s, t) => s + t.pivot, 0)
  const totalChaos = template.reduce((s, t) => s + t.chaos, 0)
  const total = totalCore + totalPivot + totalChaos

  if (total !== 42) {
    throw new Error(
      `distributeToAccounts: template for ${numAccounts} accounts sums to ${total} slips, expected 42`,
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
 * Distribute 42 slips across 6 or 7 accounts using deterministic round-robin.
 *
 * Algorithm:
 *  1. Split slips into three queues ordered by slipId: coreSlips(30),
 *     pivotSlips(8), chaosSlips(4).
 *  2. For each account pull the required number of Core/Pivot/Chaos slips from
 *     their respective queues using a per-queue pointer wrapped with modulo —
 *     this ensures the pointer always advances and no slip appears in more than
 *     one account (because the total demand per tier equals the queue length).
 *  3. Set totalStake = slips.length * config.stakePerSlip on each allocation.
 *  4. Set sessionHashes = slips.map(s => s.sessionHash).
 *
 * @throws if config.numAccounts is not 6 or 7
 * @throws if the input slips don't contain exactly 30 Core, 8 Pivot, 4 Chaos
 * @throws if any account's slip counts don't match its expected profile
 * @throws if the total slip count across all accounts is not 42
 */
export function distributeToAccounts(
  slips: Slip[],
  config: SessionConfig,
): AccountAllocation[] {
  // ------------------------------------------------------------------
  // Guard: numAccounts must be 6 or 7
  // ------------------------------------------------------------------
  if (config.numAccounts !== 6 && config.numAccounts !== 7) {
    throw new Error(
      `distributeToAccounts: config.numAccounts must be 6 or 7, got ${config.numAccounts}`,
    )
  }

  // ------------------------------------------------------------------
  // Split into tier queues, ordered by slipId (ascending)
  // ------------------------------------------------------------------
  const coreSlips  = slips.filter(s => s.tier === 'CORE').sort((a, b) => a.slipId - b.slipId)
  const pivotSlips = slips.filter(s => s.tier === 'PIVOT').sort((a, b) => a.slipId - b.slipId)
  const chaosSlips = slips.filter(s => s.tier === 'CHAOS').sort((a, b) => a.slipId - b.slipId)

  if (coreSlips.length !== 30) {
    throw new Error(
      `distributeToAccounts: expected 30 CORE slips, got ${coreSlips.length}`,
    )
  }
  if (pivotSlips.length !== 8) {
    throw new Error(
      `distributeToAccounts: expected 8 PIVOT slips, got ${pivotSlips.length}`,
    )
  }
  if (chaosSlips.length !== 4) {
    throw new Error(
      `distributeToAccounts: expected 4 CHAOS slips, got ${chaosSlips.length}`,
    )
  }

  // ------------------------------------------------------------------
  // Select template and validate it sums to 42
  // ------------------------------------------------------------------
  const template = config.numAccounts === 7 ? DISTRIBUTION_7 : DISTRIBUTION_6
  validateTemplate(
    template,
    coreSlips.length,
    pivotSlips.length,
    chaosSlips.length,
    config.numAccounts,
  )

  // ------------------------------------------------------------------
  // Round-robin assignment
  // ------------------------------------------------------------------
  let corePtr  = 0
  let pivotPtr = 0
  let chaosPtr = 0

  const allocations: AccountAllocation[] = []

  for (let i = 0; i < template.length; i++) {
    const t = template[i]
    const accountSlips: Slip[] = []

    // Pull Core slips
    for (let c = 0; c < t.core; c++) {
      accountSlips.push(coreSlips[corePtr % coreSlips.length])
      corePtr++
    }

    // Pull Pivot slips
    for (let p = 0; p < t.pivot; p++) {
      accountSlips.push(pivotSlips[pivotPtr % pivotSlips.length])
      pivotPtr++
    }

    // Pull Chaos slips
    for (let ch = 0; ch < t.chaos; ch++) {
      accountSlips.push(chaosSlips[chaosPtr % chaosSlips.length])
      chaosPtr++
    }

    // ------------------------------------------------------------------
    // Validate this account's slip counts match its expected profile
    // ------------------------------------------------------------------
    const actualCore  = accountSlips.filter(s => s.tier === 'CORE').length
    const actualPivot = accountSlips.filter(s => s.tier === 'PIVOT').length
    const actualChaos = accountSlips.filter(s => s.tier === 'CHAOS').length

    if (actualCore !== t.core || actualPivot !== t.pivot || actualChaos !== t.chaos) {
      throw new Error(
        `distributeToAccounts: account ${i + 1} has ${actualCore}/${actualPivot}/${actualChaos} ` +
        `(Core/Pivot/Chaos) but expected ${t.core}/${t.pivot}/${t.chaos} ` +
        `for profile '${t.profile}'`,
      )
    }

    allocations.push({
      accountNumber:  i + 1,
      profile:        t.profile,
      slips:          accountSlips,
      totalStake:     accountSlips.length * config.stakePerSlip,
      sessionHashes:  accountSlips.map(s => s.sessionHash),
    })
  }

  // ------------------------------------------------------------------
  // Final invariant: total slips across all accounts must be 42
  // ------------------------------------------------------------------
  const grandTotal = allocations.reduce((sum, a) => sum + a.slips.length, 0)
  if (grandTotal !== 42) {
    throw new Error(
      `distributeToAccounts: total slips across all accounts is ${grandTotal}, expected 42`,
    )
  }

  return allocations
}
