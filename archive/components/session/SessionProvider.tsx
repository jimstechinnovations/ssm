'use client'

/**
 * components/session/SessionProvider.tsx
 *
 * Central client-side state container for the SSM Builder session.
 * v2: adds groupId, dominantMarket, tierAllocation, screeningResult fields.
 *
 * All state is derived exclusively from Supabase via API calls — no
 * localStorage, sessionStorage, or IndexedDB is ever read or written.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.3, 15.1, 15.2, 15.3, 15.4
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
} from 'react'

import type {
  AccountAllocation,
  DominantMarketResult,
  MatchSelection,
  ScreeningResult,
  Session,
  SessionConfig,
  Slip,
  TierAllocation,
} from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** In-progress session held in the `draft_sessions` table. */
type DraftSession = {
  id: string
  selections: MatchSelection[]
  config: Partial<SessionConfig>
  group_id?: string | null
  dominant_market?: DominantMarketResult | null
  bankroll?: number
}

type SessionStatus = 'loading' | 'idle' | 'selecting' | 'screening' | 'generated' | 'flushing'

interface SessionState {
  // ── v1 fields (preserved) ────────────────────────────────────────────────
  selections: MatchSelection[]
  config: Partial<SessionConfig>
  slips: Slip[] | null
  distribution: AccountAllocation[] | null
  sessionId: string | null
  status: SessionStatus
  // ── v2 additions ─────────────────────────────────────────────────────────
  groupId: string | null
  dominantMarket: DominantMarketResult | null
  tierAllocation: TierAllocation | null
  screeningResult: ScreeningResult | null
}

type SessionAction =
  | { type: 'HYDRATE'; payload: { session: Session | DraftSession | null } }
  | { type: 'ADD_SELECTION'; payload: MatchSelection }
  | { type: 'REMOVE_SELECTION'; payload: { fixtureId: number } }
  | { type: 'SET_CONFIG'; payload: Partial<SessionConfig> }
  | { type: 'SET_GENERATED'; payload: { slips: Slip[]; distribution: AccountAllocation[]; sessionId: string; dominantMarket?: DominantMarketResult; tierAllocation?: TierAllocation } }
  | { type: 'FLUSH' }
  // v2 new actions
  | { type: 'SET_SCREENING_RESULT'; payload: ScreeningResult }
  | { type: 'SET_GROUP'; payload: { groupId: string } }

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState: SessionState = {
  selections: [],
  config: {},
  slips: null,
  distribution: null,
  sessionId: null,
  status: 'loading',
  groupId: null,
  dominantMarket: null,
  tierAllocation: null,
  screeningResult: null,
}

// ---------------------------------------------------------------------------
// Type guard — distinguishes a full Session (has slips) from a DraftSession
// ---------------------------------------------------------------------------

function isFullSession(session: Session | DraftSession): session is Session {
  return 'slips' in session && Array.isArray((session as Session).slips)
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'HYDRATE': {
      const { session } = action.payload

      if (session === null) {
        return { ...initialState, status: 'idle' }
      }

      if (isFullSession(session)) {
        return {
          ...state,
          selections:     session.selections,
          config:         session.config,
          slips:          session.slips,
          distribution:   session.accountDistribution,
          sessionId:      session.id,
          status:         'generated',
          // v2
          groupId:        session.groupId ?? null,
          dominantMarket: session.dominantMarket ?? null,
          tierAllocation: null,
          screeningResult: null,
        }
      }

      const draft = session as DraftSession
      return {
        ...state,
        selections:     draft.selections ?? [],
        config:         draft.config ?? {},
        slips:          null,
        distribution:   null,
        sessionId:      draft.id,
        status:         (draft.selections?.length ?? 0) > 0 ? 'selecting' : 'idle',
        // v2
        groupId:        draft.group_id ?? null,
        dominantMarket: draft.dominant_market ?? null,
        tierAllocation: null,
        screeningResult: null,
      }
    }

    case 'ADD_SELECTION': {
      const incoming = action.payload
      const existing = state.selections
      const idx = existing.findIndex((s) => s.fixture.id === incoming.fixture.id)
      const next =
        idx !== -1
          ? [...existing.slice(0, idx), incoming, ...existing.slice(idx + 1)]
          : [...existing, incoming]
      return { ...state, selections: next, status: 'selecting' }
    }

    case 'REMOVE_SELECTION': {
      const next = state.selections.filter((s) => s.fixture.id !== action.payload.fixtureId)
      return { ...state, selections: next, status: next.length > 0 ? 'selecting' : 'idle' }
    }

    case 'SET_CONFIG': {
      return { ...state, config: { ...state.config, ...action.payload } }
    }

    case 'SET_GENERATED': {
      return {
        ...state,
        slips:          action.payload.slips,
        distribution:   action.payload.distribution,
        sessionId:      action.payload.sessionId,
        status:         'generated',
        // v2
        dominantMarket: action.payload.dominantMarket ?? state.dominantMarket,
        tierAllocation: action.payload.tierAllocation ?? state.tierAllocation,
      }
    }

    case 'FLUSH': {
      return { ...state, status: 'flushing' }
    }

    // ── v2 new actions ────────────────────────────────────────────────────
    case 'SET_SCREENING_RESULT': {
      return {
        ...state,
        screeningResult: action.payload,
        groupId:         action.payload.groupId,
        status:          'screening',
      }
    }

    case 'SET_GROUP': {
      return { ...state, groupId: action.payload.groupId }
    }

    default: {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// Context value shape
// ---------------------------------------------------------------------------

interface SessionContextValue {
  state: SessionState
  // v1 actions (preserved)
  addSelection: (selection: MatchSelection) => Promise<void>
  removeSelection: (fixtureId: number) => Promise<void>
  setConfig: (config: Partial<SessionConfig>) => Promise<void>
  flush: () => Promise<void>
  dispatch: React.Dispatch<SessionAction>
  // v2 action helpers
  setScreeningResult: (result: ScreeningResult) => void
  setGroup: (groupId: string) => void
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const SessionContext = createContext<SessionContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState)

  // Hydrate from Supabase on mount — never from localStorage (Requirement 5.1, 5.2)
  useEffect(() => {
    fetch('/api/session')
      .then((r) => r.json())
      .then((data: { session: Session | DraftSession | null }) =>
        dispatch({ type: 'HYDRATE', payload: { session: data.session } }),
      )
      .catch(() =>
        dispatch({ type: 'HYDRATE', payload: { session: null } }),
      )
  }, [])

  // Optimistically update local state then persist to route handler
  const addSelection = useCallback(async (selection: MatchSelection) => {
    dispatch({ type: 'ADD_SELECTION', payload: selection })

    // Ensure a draft session exists before posting the selection
    await fetch('/api/session', { method: 'POST' })

    await fetch('/api/session/selections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    })
  }, [])

  const removeSelection = useCallback(async (fixtureId: number) => {
    dispatch({ type: 'REMOVE_SELECTION', payload: { fixtureId } })

    await fetch(`/api/session/selections?fixtureId=${fixtureId}`, {
      method: 'DELETE',
    })
  }, [])

  // SET_CONFIG: optimistic update + background retry on failure (Requirement 7.3)
  const setConfig = useCallback(async (config: Partial<SessionConfig>) => {
    dispatch({ type: 'SET_CONFIG', payload: config })

    const attempt = async (): Promise<void> => {
      const res = await fetch('/api/session/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!res.ok) {
        // Retry once in the background after a short delay
        await new Promise<void>((resolve) => setTimeout(resolve, 2000))
        await fetch('/api/session/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        })
      }
    }

    // Fire-and-forget with background retry; do not block the caller
    attempt().catch(() => {
      // Silently swallow — the UI has already applied the optimistic update.
      // A future page reload will re-hydrate from Supabase.
    })
  }, [])

  const flush = useCallback(async () => {
    dispatch({ type: 'FLUSH' })
    await fetch('/api/session', { method: 'DELETE' })
    dispatch({ type: 'HYDRATE', payload: { session: null } })
  }, [])

  // ── v2 helpers ─────────────────────────────────────────────────────────
  const setScreeningResult = useCallback((result: ScreeningResult) => {
    dispatch({ type: 'SET_SCREENING_RESULT', payload: result })
  }, [])

  const setGroup = useCallback((groupId: string) => {
    dispatch({ type: 'SET_GROUP', payload: { groupId } })
  }, [])

  const value: SessionContextValue = {
    state,
    addSelection,
    removeSelection,
    setConfig,
    flush,
    dispatch,
    setScreeningResult,
    setGroup,
  }

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// useSession hook
// ---------------------------------------------------------------------------

/**
 * Consume the SessionContext.
 * Throws if used outside of a <SessionProvider> tree.
 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (ctx === null) {
    throw new Error(
      'useSession must be used within a <SessionProvider>. ' +
        'Wrap your component tree with <SessionProvider>.',
    )
  }
  return ctx
}
