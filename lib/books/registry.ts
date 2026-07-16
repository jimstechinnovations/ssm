// lib/books/registry.ts
// Central bookmaker registry. Add a book = implement BookAdapter + register here.

import 'server-only'
import type { BookAdapter, BookInfo } from './types'
import { betwayNigeria } from './betway-nigeria'
import { sportybet } from './sportybet'
import { stake } from './stake'

const ADAPTERS: Record<string, BookAdapter> = {
  [betwayNigeria.id]: betwayNigeria,
  [sportybet.id]:     sportybet,
  [stake.id]:         stake,
}

export const BOOK_IDS = Object.keys(ADAPTERS) as [string, ...string[]]

export function getBook(id: string): BookAdapter {
  const a = ADAPTERS[id]
  if (!a) throw new Error(`Unknown bookmaker id "${id}" (known: ${BOOK_IDS.join(', ')})`)
  return a
}

/** Client-safe metadata for every registered book (no functions, no secret values). */
export function listBooks(): BookInfo[] {
  return Object.values(ADAPTERS).map(a => ({
    id: a.id,
    label: a.label,
    currency: a.currency,
    minStake: a.minStake,
    maxPayout: a.maxPayout,
    boostVerified: a.boostVerified,
    feedVerified: a.feedVerified,
    credentialsConfigured:
      Boolean(process.env[a.credentialEnv.username]) && Boolean(process.env[a.credentialEnv.password]),
  }))
}
