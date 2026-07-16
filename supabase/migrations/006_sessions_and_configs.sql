-- ============================================================
-- PEDLA v3 — server-side book configs + build/place sessions
-- Migration: 006_sessions_and_configs.sql   (see pedlas_v3.md §3)
--
-- Adds:
--   book_configs    per-book settings, CRUD from the UI (replaces placement.config.json)
--   pedla_sessions  one row per Bet-Manager session (the XXXXXXX record)
--   pedla_placements.session_id / .attempts, and a widened status set
-- All idempotent (IF NOT EXISTS / drop-then-add) so it is safe to re-run.
-- ============================================================

-- ── per-book config (server-side, CRUD) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_configs (
  book_id             TEXT PRIMARY KEY,                 -- registry id; a row may exist for a config-only book
  label               TEXT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'NGN',
  min_stake           NUMERIC(12,2) NOT NULL DEFAULT 10,
  max_payout          NUMERIC(14,2) NOT NULL DEFAULT 50000000,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  boost_json          JSONB,                            -- verified Win-Boost table, or null (= no boost)
  delay_min_sec       INT NOT NULL DEFAULT 45,
  delay_max_sec       INT NOT NULL DEFAULT 180,
  kickoff_cutoff_min  INT NOT NULL DEFAULT 20,
  daily_budget_cap    NUMERIC(14,2) NOT NULL DEFAULT 5000,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  CHECK (delay_max_sec >= delay_min_sec)
);

-- ── build+place session (the XXXXXXX record) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedla_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT UNIQUE NOT NULL,                  -- short human id, e.g. S-7F3K2Q
  book_ids       TEXT[] NOT NULL,
  date_from      DATE NOT NULL,
  date_to        DATE NOT NULL,
  budget         NUMERIC(14,2) NOT NULL,
  target_win     NUMERIC(14,2) NOT NULL,
  min_stake      NUMERIC(12,2) NOT NULL,
  leg_count      INT,                                   -- L
  slip_count     INT,                                   -- K
  pool_size      INT,                                   -- N
  coverage_depth INT,                                   -- C (guaranteed cutters)
  status         TEXT NOT NULL DEFAULT 'building'
                 CHECK (status IN ('building','placing','done','failed','stopped')),
  meta           JSONB,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedla_sessions_created ON pedla_sessions (created_at DESC);

-- ── link placements to a session + track retry attempts ─────────────────────────
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS session_id UUID
  REFERENCES pedla_sessions(id) ON DELETE CASCADE;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pedla_placements_session ON pedla_placements (session_id);

-- widen the status set: add pending | placing | won | lost | void
ALTER TABLE pedla_placements DROP CONSTRAINT IF EXISTS pedla_placements_status_check;
ALTER TABLE pedla_placements ADD CONSTRAINT pedla_placements_status_check
  CHECK (status IN ('pending','placing','placed','failed','simulated','skipped','won','lost','void'));

-- ── RLS (service role only, same as 005) ────────────────────────────────────────
ALTER TABLE book_configs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedla_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access book_configs" ON book_configs;
CREATE POLICY "service role full access book_configs" ON book_configs
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access sessions" ON pedla_sessions;
CREATE POLICY "service role full access sessions" ON pedla_sessions
  FOR ALL USING (true) WITH CHECK (true);
