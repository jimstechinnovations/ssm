// __tests__/lib/placement/queue.test.ts
// Placement bot safety rails: dry-run default, pacing, idempotency, kickoff cutoff,
// daily cap, kill switch, and the PLACEMENT_LIVE gate.

import { describe, it, expect, beforeEach } from 'vitest'
import type { PedlasSlip } from '../../../lib/pedlas/types'
import {
  startRun, getRun, stopRun, jitteredDelaySec, slipIdempotencyKey, isLivePlacementAllowed,
} from '../../../lib/placement/queue'
import type { BookPlacementConfig } from '../../../lib/placement/config'
import { balanceConfirms, parseMoney, type PlacementReceipt } from '../../../lib/placement/receipt'

/** A bookmaker-confirmed receipt (balance actually moved). */
const okReceipt = (stake = 100): PlacementReceipt => ({
  confirmed: true, confirmedBy: 'balance+history', bookingCode: 'ABC123', betId: 'BET-1',
  balanceBefore: 500, balanceAfter: 500 - stake,
})

const cfg: BookPlacementConfig = {
  enabled: true, minStake: 100, dailyBudgetCap: 5_000,
  delayMinSec: 45, delayMaxSec: 180, kickoffCutoffMinutes: 20,
}

function slip(slipId: number, opts: { stake?: number; kickoffInMin?: number } = {}): PedlasSlip {
  const kickoff = new Date(Date.now() + (opts.kickoffInMin ?? 120) * 60_000).toISOString()
  return {
    slipId,
    vector: [0, 1],
    legs: [
      { fixtureId: slipId * 10 + 1, game: 'A vs B', league: 'L', kickoff, line: 4.5, side: 'Under', market: 'OVER_UNDER_4.5', outcome: 'Under 4.5', odds: 1.27 },
      { fixtureId: slipId * 10 + 2, game: 'C vs D', league: 'L', kickoff, line: 4.5, side: 'Over', market: 'OVER_UNDER_4.5', outcome: 'Over 4.5', odds: 3.6 },
    ],
    legCount: 2, combinedOdds: 4.57, trueProb: 0.17, boostPct: 0,
    stake: opts.stake ?? 100, payout: 457, uncappedPayout: 457, capped: false,
    evMultiple: 0.78, rankScore: 50,
  }
}

const noSleep = async () => {}
async function finished(runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = getRun(runId)!
    if (r.status !== 'running') return r
    await new Promise(res => setTimeout(res, 10))
  }
  throw new Error('run never finished')
}

// The queue keeps cross-run state (idempotency, daily caps) in globalThis — reset per test.
beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__pedlaBot
})

describe('placement bot', () => {
  it('live is locked unless PLACEMENT_LIVE=1', () => {
    expect(isLivePlacementAllowed()).toBe(false) // test env: not set
    expect(() => startRun({ bookId: 'betway_nigeria', slips: [slip(1)], dryRun: false, config: cfg }))
      .toThrow(/PLACEMENT_LIVE/)
  })

  it('jittered delay stays inside the configured human-pacing window', () => {
    for (let i = 0; i < 200; i++) {
      const d = jitteredDelaySec(cfg)
      expect(d).toBeGreaterThanOrEqual(cfg.delayMinSec)
      expect(d).toBeLessThanOrEqual(cfg.delayMaxSec)
    }
    expect(jitteredDelaySec(cfg, () => 0)).toBe(45)
    expect(jitteredDelaySec(cfg, () => 1)).toBe(180)
  })

  it('dry-run simulates every slip one at a time, first immediately, rest paced', async () => {
    const run = startRun({ bookId: 'betway_nigeria', slips: [slip(1), slip(2), slip(3)], dryRun: true, config: cfg, sleep: noSleep })
    expect(run.dryRun).toBe(true)
    expect(run.jobs[0].plannedDelaySec).toBe(0)
    for (const j of run.jobs.slice(1)) expect(j.plannedDelaySec).toBeGreaterThanOrEqual(cfg.delayMinSec)

    const done = await finished(run.runId)
    expect(done.status).toBe('done')
    expect(done.jobs.every(j => j.status === 'simulated')).toBe(true)
  })

  it('skips slips whose first kickoff is inside the cutoff', async () => {
    const run = startRun({
      bookId: 'betway_nigeria',
      slips: [slip(1, { kickoffInMin: 5 }), slip(2, { kickoffInMin: 120 })],
      dryRun: true, config: cfg, sleep: noSleep,
    })
    const done = await finished(run.runId)
    expect(done.jobs[0].status).toBe('skipped')
    expect(done.jobs[0].note).toMatch(/cutoff/)
    expect(done.jobs[1].status).toBe('simulated')
  })

  it('idempotency key is stable for the same legs and differs for different slips', () => {
    const a = slipIdempotencyKey('betway_nigeria', slip(1))
    expect(slipIdempotencyKey('betway_nigeria', slip(1))).toBe(a)
    expect(slipIdempotencyKey('sportybet', slip(1))).not.toBe(a)
    expect(slipIdempotencyKey('betway_nigeria', slip(2))).not.toBe(a)
  })

  it('LIVE path: places via the adapter placer, enforces daily cap and idempotency', async () => {
    process.env.PLACEMENT_LIVE = '1'
    try {
      const placed: number[] = []
      const placeLive = async (job: { slipId: number }) => { placed.push(job.slipId); return okReceipt() }
      // cap 250: two ₦100 slips fit, the third breaches the cap
      const tight = { ...cfg, dailyBudgetCap: 250 }
      const run = startRun({ bookId: 'betway_nigeria', slips: [slip(1), slip(2), slip(3)], dryRun: false, config: tight, placeLive, sleep: noSleep })
      const done = await finished(run.runId)
      expect(placed).toEqual([1, 2])
      expect(done.jobs.map(j => j.status)).toEqual(['placed', 'placed', 'skipped'])
      expect(done.jobs[2].note).toMatch(/daily cap/)

      // idempotency: re-running the same slips places nothing
      const run2 = startRun({ bookId: 'betway_nigeria', slips: [slip(1), slip(2)], dryRun: false, config: tight, placeLive, sleep: noSleep })
      const done2 = await finished(run2.runId)
      expect(placed).toEqual([1, 2])
      expect(done2.jobs.every(j => j.status === 'skipped' && /already placed/.test(j.note ?? ''))).toBe(true)
    } finally {
      delete process.env.PLACEMENT_LIVE
    }
  })

  it('kill switch stops the run; remaining jobs are skipped, no retry', async () => {
    process.env.PLACEMENT_LIVE = '1'
    try {
      let count = 0
      const placeLive = async (job: { jobId: string }) => {
        count++
        // jobId = `${runId}:${n}` — stop the run right after the first placement
        if (count === 1) stopRun(job.jobId.slice(0, job.jobId.lastIndexOf(':')))
        return okReceipt()
      }
      const run = startRun({ bookId: 'betway_nigeria', slips: [slip(1), slip(2), slip(3)], dryRun: false, config: cfg, placeLive, sleep: noSleep })
      const done = await finished(run.runId)
      expect(done.status).toBe('stopped')
      expect(done.jobs[0].status).toBe('placed')
      expect(done.jobs.slice(1).every(j => j.status === 'skipped')).toBe(true)
    } finally {
      delete process.env.PLACEMENT_LIVE
    }
  })

  it('a failed placement is recorded and NOT retried', async () => {
    process.env.PLACEMENT_LIVE = '1'
    try {
      let attempts = 0
      const placeLive = async (): Promise<PlacementReceipt> => { attempts++; throw new Error('site changed') }
      const run = startRun({ bookId: 'betway_nigeria', slips: [slip(1)], dryRun: false, config: cfg, placeLive, sleep: noSleep })
      const done = await finished(run.runId)
      expect(attempts).toBe(1)
      expect(done.jobs[0].status).toBe('failed')
      expect(done.jobs[0].note).toMatch(/site changed/)
    } finally {
      delete process.env.PLACEMENT_LIVE
    }
  })

  // REGRESSION (2026-07-13): a live run reported "placed" while SportyBet's own history said
  // "No Bets Available" and the balance never moved — the placer had matched page copy with a
  // loose regex. An unconfirmed receipt must FAIL the job, never silently succeed.
  it('an UNCONFIRMED receipt fails the job — a resolved promise is not a placed bet', async () => {
    process.env.PLACEMENT_LIVE = '1'
    try {
      const unconfirmed: PlacementReceipt = {
        confirmed: false, confirmedBy: 'none', bookingCode: 'KU428S',
        balanceBefore: 100, balanceAfter: 100,   // balance never moved ⇒ no bet
        detail: 'balance unchanged and bet absent from Bet History',
      }
      const run = startRun({
        bookId: 'sportybet', slips: [slip(1)], dryRun: false, config: cfg,
        placeLive: async () => unconfirmed, sleep: noSleep,
      })
      const done = await finished(run.runId)
      expect(done.jobs[0].status).toBe('failed')          // NOT 'placed'
      expect(done.jobs[0].note).toMatch(/balance unchanged/)
      expect(done.jobs[0].receipt?.bookingCode).toBe('KU428S') // code kept so a human can recover
      expect(done.log.join(' ')).not.toMatch(/PLACED/)

      // and the idempotency key must NOT be burned — the slip was never actually placed
      const retry = startRun({
        bookId: 'sportybet', slips: [slip(1)], dryRun: false, config: cfg,
        placeLive: async () => okReceipt(), sleep: noSleep,
      })
      const retried = await finished(retry.runId)
      expect(retried.jobs[0].status).toBe('placed')
    } finally {
      delete process.env.PLACEMENT_LIVE
    }
  })

  it('a confirmed placement records the booking code and bet id on the job', async () => {
    process.env.PLACEMENT_LIVE = '1'
    try {
      const run = startRun({
        bookId: 'sportybet', slips: [slip(1)], dryRun: false, config: cfg,
        placeLive: async () => okReceipt(), sleep: noSleep,
      })
      const done = await finished(run.runId)
      expect(done.jobs[0].status).toBe('placed')
      expect(done.jobs[0].receipt?.confirmedBy).toBe('balance+history')
      expect(done.jobs[0].note).toMatch(/code ABC123/)
      expect(done.jobs[0].note).toMatch(/bet BET-1/)
    } finally {
      delete process.env.PLACEMENT_LIVE
    }
  })

  it('onJobDone fires for every terminal job so the ledger records failures too', async () => {
    const seen: string[] = []
    const run = startRun({
      bookId: 'sportybet', slips: [slip(1), slip(2)], dryRun: true, config: cfg, sleep: noSleep,
      onJobDone: (job) => { seen.push(`${job.slipId}:${job.status}`) },
    })
    await finished(run.runId)
    expect(seen).toEqual(['1:simulated', '2:simulated'])
  })
})

describe('placement receipt (the anti-false-positive contract)', () => {
  it('parses the book\'s balance text', () => {
    expect(parseMoney('NGN 100.00')).toBe(100)
    expect(parseMoney('Balance ₦1,912.98 today')).toBe(1912.98)
    expect(parseMoney('no money here')).toBeUndefined()
  })

  it('only a real balance DROP of ~the stake counts as confirmation', () => {
    expect(balanceConfirms(500, 400, 100)).toBe(true)
    expect(balanceConfirms(100, 100, 100)).toBe(false)   // the exact false-positive case
    expect(balanceConfirms(500, 450, 100)).toBe(false)   // wrong amount
    expect(balanceConfirms(500, 600, 100)).toBe(false)   // went UP
    expect(balanceConfirms(undefined, 400, 100)).toBe(false)
  })
})
