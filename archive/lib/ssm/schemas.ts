// lib/ssm/schemas.ts
// Zod validation schemas for all SSM route handler inputs

import { z } from 'zod'

// OddsValueSchema
export const OddsValueSchema = z.object({
  bookmaker: z.string().min(1),
  market: z.enum(['1X2', 'BTTS', 'OVER_UNDER_0.5', 'OVER_UNDER_1.5', 'OVER_UNDER_2.5', 'OVER_UNDER_3.5', 'OVER_UNDER_4.5', 'OVER_UNDER_5.5', 'OVER_UNDER_6.5', 'ASIAN_HANDICAP']),
  label: z.string().min(1),
  value: z.number().positive(),
})

// SlipLegSchema
export const SlipLegSchema = z.object({
  matchIndex: z.number().int().min(0).max(7),
  fixtureId: z.number().int().positive(),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  market: z.enum(['1X2', 'BTTS', 'OVER_UNDER_0.5', 'OVER_UNDER_1.5', 'OVER_UNDER_2.5', 'OVER_UNDER_3.5', 'OVER_UNDER_4.5', 'OVER_UNDER_5.5', 'OVER_UNDER_6.5', 'ASIAN_HANDICAP']),
  outcome: z.string().min(1),
  odds: z.number().positive(),
  state: z.union([z.literal(0), z.literal(1)]),
})

// MatchSelectionSchema
export const MatchSelectionSchema = z.object({
  fixture: z.object({
    id: z.number().int().positive(),
    homeTeam: z.string().min(1),
    awayTeam: z.string().min(1),
    league: z.string().min(1),
    leagueId: z.number().int().positive(),
    kickoff: z.string().datetime({ offset: true }).or(z.string().min(1)),
    venue: z.string().optional(),
    odds: z.array(OddsValueSchema),
  }),
  state0: OddsValueSchema,
  state1: OddsValueSchema,
  volatility: z.number().min(0).max(1),
})

// SessionConfigSchema
export const SessionConfigSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stakePerSlip: z.number().positive().min(0.01).max(999999.99),
  numAccounts: z.union([z.literal(6), z.literal(7)]),
  sessionPrefix: z.string().min(1),
})

// GenerateRequestSchema — the POST /api/generate request body
export const GenerateRequestSchema = z.object({
  matches: z.array(MatchSelectionSchema).length(8),
  config: SessionConfigSchema.omit({ sessionPrefix: true }).extend({
    sessionPrefix: z.string().optional(),
  }),
})

// Inferred TypeScript types
export type OddsValueInput = z.infer<typeof OddsValueSchema>
export type SlipLegInput = z.infer<typeof SlipLegSchema>
export type MatchSelectionInput = z.infer<typeof MatchSelectionSchema>
export type SessionConfigInput = z.infer<typeof SessionConfigSchema>
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>

// ── v2 schemas ───────────────────────────────────────────────────────────────

// FixtureSchema — used in GenerateRequestSchema_v2
export const FixtureSchema = z.object({
  id:       z.number().int().positive(),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  league:   z.string().min(1),
  leagueId: z.number().int().positive(),
  kickoff:  z.string().min(1),
  venue:    z.string().optional(),
  odds:     z.array(OddsValueSchema),
})

// BookmakerPlatformSchema
export const BookmakerPlatformSchema = z.enum([
  'betway_nigeria',
  'sportybet',
  'stake',
  '1xbet',
  'other',
])

// ScreenRequestSchema — POST /api/screen request body
export const ScreenRequestSchema = z.object({
  bookmaker: BookmakerPlatformSchema,
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD'),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD'),
  group_id:  z.string().uuid().optional(),
})

// GenerateRequestSchema_v2 — POST /api/generate v2 request body
export const GenerateRequestSchema_v2 = z.object({
  groupId:     z.string().uuid(),
  fixtures:    z.array(FixtureSchema).length(8),
  bankroll:    z.number().int().positive().min(1),
  numAccounts: z.union([z.literal(6), z.literal(7)]),
})

// Inferred v2 types
export type FixtureInput          = z.infer<typeof FixtureSchema>
export type BookmakerPlatformInput = z.infer<typeof BookmakerPlatformSchema>
export type ScreenRequest         = z.infer<typeof ScreenRequestSchema>
export type GenerateRequestV2     = z.infer<typeof GenerateRequestSchema_v2>
