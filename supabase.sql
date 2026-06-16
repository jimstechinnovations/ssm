-- ============================================================
-- SSM Builder — Complete Schema (migrations 001 + 002 combined)
--
-- IDEMPOTENT: safe to run repeatedly against any database state.
-- The teardown block at the top drops all objects in dependency
-- order before recreating everything from scratch.
--
-- Usage: paste into Supabase SQL editor → Run
-- Requirements: 6.1, 10.4
-- ============================================================

-- ============================================================
-- 0. TEARDOWN — drop everything in reverse dependency order
--    so this script is safe to re-run at any time
-- ============================================================

-- Triggers — guarded in a DO block because DROP TRIGGER requires
-- the table to exist even with IF EXISTS (Postgres limitation)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'session_groups'
  ) THEN
    DROP TRIGGER IF EXISTS trg_session_groups_updated_at ON session_groups;
  END IF;
END $$;

-- Trigger function
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

-- Indexes drop automatically with their tables via CASCADE below,
-- but explicit drops handle the rare case of orphaned indexes.
DROP INDEX IF EXISTS idx_session_groups_claimed;
DROP INDEX IF EXISTS idx_session_groups_status;

-- Policies — guarded in DO blocks for the same reason as triggers
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'draft_sessions') THEN
    DROP POLICY IF EXISTS "Service role full access on draft_sessions" ON draft_sessions;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sessions') THEN
    DROP POLICY IF EXISTS "Service role full access on sessions" ON sessions;
    DROP POLICY IF EXISTS "Anon read-only on sessions"           ON sessions;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'odds_cache') THEN
    DROP POLICY IF EXISTS "Service role full access on odds_cache" ON odds_cache;
    DROP POLICY IF EXISTS "Anon read-only on odds_cache"           ON odds_cache;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'session_groups') THEN
    DROP POLICY IF EXISTS "Service role full access on session_groups" ON session_groups;
    DROP POLICY IF EXISTS "Anon read-only on session_groups"           ON session_groups;
  END IF;
END $$;

-- Tables — in reverse FK dependency order
--   draft_sessions and sessions reference session_groups → drop them first
DROP TABLE IF EXISTS draft_sessions CASCADE;
DROP TABLE IF EXISTS sessions       CASCADE;
DROP TABLE IF EXISTS odds_cache     CASCADE;
DROP TABLE IF EXISTS session_groups CASCADE;

-- ============================================================
-- 1. Base tables (with all v2 columns included)
-- ============================================================

-- draft_sessions: persists in-progress match selections before matrix generation
CREATE TABLE draft_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  selections          JSONB       NOT NULL DEFAULT '[]',
  config              JSONB       NOT NULL DEFAULT '{}',
  -- v2 additions
  group_id            UUID,
  bookmaker           TEXT,
  screening_results   JSONB,
  dominant_market     JSONB,
  bankroll            INTEGER     NOT NULL DEFAULT 10000,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- sessions: one row per completed SSM session (after matrix generation)
CREATE TABLE sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_prefix   TEXT        NOT NULL,
  date             DATE        NOT NULL,
  config           JSONB       NOT NULL,
  selections       JSONB       NOT NULL,
  slips            JSONB       NOT NULL,
  distribution     JSONB       NOT NULL,
  -- v2 additions
  group_id         UUID,
  dominant_market  JSONB,
  breakout_market  TEXT,
  bankroll         INTEGER     NOT NULL DEFAULT 10000,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint on session_prefix
ALTER TABLE sessions ADD CONSTRAINT sessions_session_prefix_key UNIQUE (session_prefix);

-- odds_cache: cached fixture odds with expiry
CREATE TABLE odds_cache (
  fixture_id   INTEGER     PRIMARY KEY,
  odds_data    JSONB       NOT NULL,
  fetched_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- 2. session_groups table
-- ============================================================

CREATE TABLE session_groups (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status              TEXT        NOT NULL DEFAULT 'screening'
                      CHECK (status IN ('screening', 'generated', 'printed')),
  bookmaker           TEXT        NOT NULL,
  date_from           DATE        NOT NULL,
  date_to             DATE        NOT NULL,
  claimed_fixture_ids INTEGER[]   NOT NULL DEFAULT '{}',
  screening_results   JSONB,
  dominant_market     JSONB,
  bankroll            INTEGER     NOT NULL DEFAULT 10000,
  num_accounts        INTEGER     NOT NULL DEFAULT 7
                      CHECK (num_accounts IN (6, 7)),
  session_id          UUID        REFERENCES sessions(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Add foreign-key references now that session_groups exists
ALTER TABLE draft_sessions
  ADD CONSTRAINT draft_sessions_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES session_groups(id) ON DELETE SET NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES session_groups(id) ON DELETE SET NULL;

-- ============================================================
-- 3. Indexes
-- ============================================================

-- GIN index for fast claimed fixture exclusion queries
CREATE INDEX idx_session_groups_claimed
  ON session_groups USING GIN (claimed_fixture_ids);

-- B-tree index for status-filtered dashboard queries
CREATE INDEX idx_session_groups_status
  ON session_groups (status, created_at DESC);

-- ============================================================
-- 4. Row Level Security
-- ============================================================

ALTER TABLE draft_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_groups ENABLE ROW LEVEL SECURITY;

-- draft_sessions: service role only (anon has NO access)
CREATE POLICY "Service role full access on draft_sessions"
  ON draft_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- sessions: service role can do all; anon can only SELECT
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

-- odds_cache: service role can do all; anon can only SELECT
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

-- session_groups: service role can do all; anon can only SELECT
CREATE POLICY "Service role full access on session_groups"
  ON session_groups
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon read-only on session_groups"
  ON session_groups
  FOR SELECT
  TO anon
  USING (true);

-- ============================================================
-- 5. Trigger function and trigger
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_groups_updated_at
  BEFORE UPDATE ON session_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
