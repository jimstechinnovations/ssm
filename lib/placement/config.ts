// lib/placement/config.ts
// Per-book placement/bot configuration, persisted to placement.config.json (git-ignored).
// Credentials are NEVER stored here — env vars only (see BookAdapter.credentialEnv).

import 'server-only'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const BookPlacementConfigSchema = z.object({
  enabled:              z.boolean().default(false),
  minStake:             z.number().int().positive().default(100),
  dailyBudgetCap:       z.number().int().positive().default(5_000),
  delayMinSec:          z.number().int().min(5).max(3_600).default(45),
  delayMaxSec:          z.number().int().min(5).max(7_200).default(180),
  kickoffCutoffMinutes: z.number().int().min(0).max(1_440).default(20),
}).refine(c => c.delayMaxSec >= c.delayMinSec, { message: 'delayMaxSec must be ≥ delayMinSec' })

export const PlacementConfigSchema = z.object({
  books: z.record(z.string(), BookPlacementConfigSchema).default({}),
})

export type BookPlacementConfig = z.infer<typeof BookPlacementConfigSchema>
export type PlacementConfig = z.infer<typeof PlacementConfigSchema>

export const DEFAULT_BOOK_CONFIG: BookPlacementConfig = BookPlacementConfigSchema.parse({})

const CONFIG_PATH = path.join(process.cwd(), 'placement.config.json')

export async function readPlacementConfig(): Promise<PlacementConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    return PlacementConfigSchema.parse(JSON.parse(raw))
  } catch {
    return { books: {} } // missing/corrupt file → defaults (soft-fail, like the DB store)
  }
}

export async function writePlacementConfig(cfg: PlacementConfig): Promise<void> {
  const valid = PlacementConfigSchema.parse(cfg)
  await fs.writeFile(CONFIG_PATH, JSON.stringify(valid, null, 2), 'utf8')
}

export function bookConfig(cfg: PlacementConfig, bookId: string): BookPlacementConfig {
  return cfg.books[bookId] ?? DEFAULT_BOOK_CONFIG
}
