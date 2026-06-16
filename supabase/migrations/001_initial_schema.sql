-- ============================================================
-- SSM Builder — Initial Schema
-- Migration: 001_initial_schema.sql
-- ============================================================

-- Draft sessions table: persists in-progress match selections before matrix generation
CREATE TABLE draft_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selections   JSONB NOT NULL DEFAULT '[]',
  config       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Sessions table: one row per completed SSM session (after matrix generation)
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_prefix TEXT NOT NULL,
  date         DATE NOT NULL,
  config       JSONB NOT NULL,
  selections   JSONB NOT NULL,
  slips        JSONB NOT NULL,
  distribution JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- UNIQUE constraint on session_prefix
ALTER TABLE sessions ADD CONSTRAINT sessions_session_prefix_key UNIQUE (session_prefix);

-- Odds cache table
CREATE TABLE odds_cache (
  fixture_id   INTEGER PRIMARY KEY,
  odds_data    JSONB NOT NULL,
  fetched_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- Row Level Security
-- ============================================================

-- Enable RLS on all three tables
ALTER TABLE draft_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_cache     ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- draft_sessions: service role only (anon has NO access)
-- -------------------------------------------------------
CREATE POLICY "Service role full access on draft_sessions"
  ON draft_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -------------------------------------------------------
-- sessions: service role can do all; anon can only SELECT
-- -------------------------------------------------------
CREATE POLICY "Service role full access on sessions"
  ON sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon read-only on sessions"
  ON sessions
  FOR SELECT
  TO anon
  USING (true);

-- -------------------------------------------------------
-- odds_cache: service role can do all; anon can only SELECT
-- -------------------------------------------------------
CREATE POLICY "Service role full access on odds_cache"
  ON odds_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon read-only on odds_cache"
  ON odds_cache
  FOR SELECT
  TO anon
  USING (true);
