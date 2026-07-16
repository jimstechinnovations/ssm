// lib/placement/queue.ts
// The placement bot: takes a book's slips and places them ONE AT A TIME with human-like,
// jittered pacing — never machine-gun (pedla_v1.md §4). Dry-run is the default and the only
// mode unless the PLACEMENT_LIVE=1 env gate is set AND the caller passes dryRun:false.
//
// Safety rails (all enforced here, not in the UI):
//   - idempotency: a slip (book + legs + stake) is never placed twice per process
//   - kickoff cutoff: skip a slip if any leg kicks off sooner than the configured cutoff
//   - daily budget cap per book
//   - kill switch: stopRun() marks the run stopped; pending jobs are skipped
//
// State is in-memory (globalThis, survives Next dev HMR). Runs are ephemeral by design —
// the source of truth for WHAT was built stays in the saved PEDLA books.

import 'server-only'
import { randomUUID, createHash } from 'node:crypto'
import type { PedlasSlip } from '../pedlas/types'
import type { BookPlacementConfig } from './config'
import type { PlacementReceipt } from './receipt'

export type JobStatus = 'queued' | 'waiting' | 'placing' | 'placed' | 'simulated' | 'skipped' | 'failed'

export interface PlacementJob {
  jobId: string
  idempotencyKey: string
  slipId: number
  legCount: number
  stake: number
  combinedOdds: number
  firstKickoff: string      // earliest leg kickoff (ISO)
  plannedDelaySec: number   // human-like jittered delay BEFORE this job
  status: JobStatus
  note?: string
  startedAt?: string
  finishedAt?: string
  /** Proof from the bookmaker (booking code, bet id, balance move). Only set on a real placement. */
  receipt?: PlacementReceipt
}

export interface PlacementRun {
  runId: string
  bookId: string
  dryRun: boolean
  status: 'running' | 'done' | 'stopped'
  createdAt: string
  totalStake: number
  jobs: PlacementJob[]
  log: string[]
}

export interface StartRunInput {
  bookId: string
  slips: PedlasSlip[]
  dryRun: boolean
  config: BookPlacementConfig
  /**
   * Live placement implementation (adapter-specific). Required when dryRun=false.
   * MUST return a receipt the bookmaker itself confirms (balance drop / bet history) — a
   * resolved promise alone is not treated as success (see receipt.ts).
   */
  placeLive?: (job: PlacementJob, slip: PedlasSlip) => Promise<PlacementReceipt>
  /** Called after each terminal job so records can be persisted. */
  onJobDone?: (job: PlacementJob, slip: PedlasSlip) => void | Promise<void>
  /** Test hook: sleep override. */
  sleep?: (ms: number) => Promise<void>
}

interface BotState {
  runs: Map<string, PlacementRun>
  stopped: Set<string>
  placedKeys: Set<string>
  dailyStake: Map<string, number>   // `${bookId}:${YYYY-MM-DD}` → total placed stake
}

const g = globalThis as typeof globalThis & { __pedlaBot?: BotState }
function state(): BotState {
  if (!g.__pedlaBot) g.__pedlaBot = { runs: new Map(), stopped: new Set(), placedKeys: new Set(), dailyStake: new Map() }
  return g.__pedlaBot
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function slipIdempotencyKey(bookId: string, slip: PedlasSlip): string {
  const legSig = slip.legs.map(l => `${l.fixtureId}:${l.outcome}`).sort().join('|')
  return createHash('sha256').update(`${bookId}|${slip.stake}|${legSig}`).digest('hex').slice(0, 24)
}

/** Uniform-random integer delay in [min, max] seconds — the human-like jitter. */
export function jitteredDelaySec(cfg: BookPlacementConfig, rng: () => number = Math.random): number {
  return Math.round(cfg.delayMinSec + (cfg.delayMaxSec - cfg.delayMinSec) * rng())
}

export function isLivePlacementAllowed(): boolean {
  return process.env.PLACEMENT_LIVE === '1'
}

export function getRun(runId: string): PlacementRun | undefined { return state().runs.get(runId) }
export function listRuns(): PlacementRun[] {
  return [...state().runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export function stopRun(runId: string): boolean {
  const run = state().runs.get(runId)
  if (!run) return false
  state().stopped.add(runId)
  if (run.status === 'running') run.status = 'stopped'
  return true
}

function dayKey(bookId: string): string { return `${bookId}:${new Date().toISOString().slice(0, 10)}` }

/**
 * Create a run and start executing it in the background. Returns the run (snapshot) immediately.
 * Throws (before creating anything) if a live run is requested without the env gate.
 */
export function startRun(input: StartRunInput): PlacementRun {
  if (!input.dryRun && !isLivePlacementAllowed()) {
    throw new Error('Live placement is locked: set PLACEMENT_LIVE=1 in the environment to enable it (pedla_v1.md §4).')
  }
  if (!input.dryRun && !input.placeLive) {
    throw new Error(`No live placement implementation for book "${input.bookId}" — dry-run only.`)
  }
  if (input.slips.length === 0) throw new Error('startRun: no slips to place')

  const s = state()
  const cfg = input.config
  const runId = randomUUID()
  const jobs: PlacementJob[] = input.slips.map((slip, i) => ({
    jobId: `${runId}:${i + 1}`,
    idempotencyKey: slipIdempotencyKey(input.bookId, slip),
    slipId: slip.slipId,
    legCount: slip.legCount,
    stake: slip.stake,
    combinedOdds: slip.combinedOdds,
    firstKickoff: slip.legs.reduce((min, l) => (l.kickoff < min ? l.kickoff : min), slip.legs[0]?.kickoff ?? ''),
    plannedDelaySec: i === 0 ? 0 : jitteredDelaySec(cfg), // first slip immediate, then paced
    status: 'queued',
  }))

  const run: PlacementRun = {
    runId,
    bookId: input.bookId,
    dryRun: input.dryRun,
    status: 'running',
    createdAt: new Date().toISOString(),
    totalStake: input.slips.reduce((t, sl) => t + sl.stake, 0),
    jobs,
    log: [`run created: ${jobs.length} slip(s), ${input.dryRun ? 'DRY-RUN' : 'LIVE'}, book=${input.bookId}`],
  }
  s.runs.set(runId, run)

  void executeRun(run, input) // fire-and-forget; status is polled via getRun()
  return run
}

async function executeRun(run: PlacementRun, input: StartRunInput): Promise<void> {
  const s = state()
  const cfg = input.config
  const sleep = input.sleep ?? defaultSleep
  const slipBySlipId = new Map(input.slips.map(sl => [sl.slipId, sl]))

  for (const job of run.jobs) {
    if (s.stopped.has(run.runId)) {
      job.status = 'skipped'
      job.note = 'run stopped (kill switch)'
      continue
    }

    // Human pacing: real wait when live; dry-run compresses waits so a simulation finishes fast
    // but still logs the delay it WOULD have used.
    job.status = 'waiting'
    const waitMs = run.dryRun ? Math.min(job.plannedDelaySec, 1) * 200 : job.plannedDelaySec * 1_000
    if (job.plannedDelaySec > 0) {
      run.log.push(`slip ${job.slipId}: waiting ${job.plannedDelaySec}s${run.dryRun ? ' (dry-run: compressed)' : ''}`)
      await sleep(waitMs)
    }

    if (s.stopped.has(run.runId)) {
      job.status = 'skipped'
      job.note = 'run stopped (kill switch)'
      continue
    }

    job.startedAt = new Date().toISOString()

    // Idempotency — never place the same slip twice.
    if (s.placedKeys.has(job.idempotencyKey)) {
      job.status = 'skipped'
      job.note = 'already placed (idempotency key)'
      job.finishedAt = new Date().toISOString()
      run.log.push(`slip ${job.slipId}: SKIPPED — already placed`)
      continue
    }

    // Kickoff cutoff — every leg must still be comfortably in the future.
    const cutoffMs = Date.now() + cfg.kickoffCutoffMinutes * 60_000
    if (!job.firstKickoff || Date.parse(job.firstKickoff) < cutoffMs) {
      job.status = 'skipped'
      job.note = `first kickoff within ${cfg.kickoffCutoffMinutes} min cutoff`
      job.finishedAt = new Date().toISOString()
      run.log.push(`slip ${job.slipId}: SKIPPED — too close to kickoff`)
      continue
    }

    // Daily budget cap per book.
    const dk = dayKey(run.bookId)
    const spent = s.dailyStake.get(dk) ?? 0
    if (spent + job.stake > cfg.dailyBudgetCap) {
      job.status = 'skipped'
      job.note = `daily cap ₦${cfg.dailyBudgetCap} would be exceeded (spent ₦${spent})`
      job.finishedAt = new Date().toISOString()
      run.log.push(`slip ${job.slipId}: SKIPPED — daily budget cap`)
      continue
    }

    job.status = 'placing'
    const slip = slipBySlipId.get(job.slipId)
    try {
      if (run.dryRun) {
        job.status = 'simulated'
        job.note = `would place ₦${job.stake} @ ${job.combinedOdds.toFixed(2)} (${job.legCount} legs)`
        run.log.push(`slip ${job.slipId}: SIMULATED — ${job.note}`)
      } else {
        if (!slip) throw new Error('slip vanished from run input')
        const receipt = await input.placeLive!(job, slip)
        job.receipt = receipt
        // The BOOKMAKER must confirm it — a resolved promise is not a placed bet (receipt.ts).
        if (!receipt.confirmed) {
          throw Object.assign(new Error(receipt.detail ?? 'placement not confirmed by the bookmaker'), { receipt })
        }
        job.status = 'placed'
        job.note = `confirmed by ${receipt.confirmedBy}` +
          (receipt.betId ? ` · bet ${receipt.betId}` : '') +
          (receipt.bookingCode ? ` · code ${receipt.bookingCode}` : '')
        s.placedKeys.add(job.idempotencyKey)
        s.dailyStake.set(dk, spent + job.stake)
        run.log.push(`slip ${job.slipId}: PLACED ₦${job.stake} — ${job.note}`)
      }
    } catch (err) {
      job.status = 'failed'
      job.note = err instanceof Error ? err.message : String(err)
      const r = (err as { receipt?: PlacementReceipt }).receipt
      if (r) job.receipt = r
      run.log.push(`slip ${job.slipId}: FAILED — ${job.note}`)
      // No blind retry — a failed placement needs a human look (pedla_v1.md §4).
    }
    job.finishedAt = new Date().toISOString()
    if (slip && input.onJobDone) {
      try { await input.onJobDone(job, slip) } catch { /* persistence is best-effort */ }
    }
  }

  if (run.status === 'running') run.status = s.stopped.has(run.runId) ? 'stopped' : 'done'
  run.log.push(`run ${run.status}: ${run.jobs.filter(j => j.status === 'placed' || j.status === 'simulated').length}/${run.jobs.length} ok`)
}
