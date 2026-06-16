-- ============================================================
-- SSM Builder v2 Schema Additions
-- Migration: 002_v2_schema.sql
-- Requirements: 6.1, 6.2, 6.3, 10.1, 10.4, 12.3
-- ============================================================

-- ── New table: session_groups ──────────────────────────────────────────────

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

-- GIN index for fast claimed fixture exclusion queries
CREATE INDEX idx_session_groups_claimed
  ON session_groups USING GIN (claimed_fixture_ids);

-- B-tree index for status-filtered dashboard queries
CREATE INDEX idx_session_groups_status
  ON session_groups (status, created_at DESC);

-- ── Alter sessions — add v2 columns ───────────────────────────────────────

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS group_id        UUID    REFERENCES session_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dominant_market JSONB,
  ADD COLUMN IF NOT EXISTS breakout_market TEXT,
  ADD COLUMN IF NOT EXISTS bankroll        INTEGER NOT NULL DEFAULT 10000;

-- ── Alter draft_sessions — add v2 columns ─────────────────────────────────

ALTER TABLE draft_sessions
  ADD COLUMN IF NOT EXISTS group_id           UUID    REFERENCES session_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bookmaker          TEXT,
  ADD COLUMN IF NOT EXISTS screening_results  JSONB,
  ADD COLUMN IF NOT EXISTS dominant_market    JSONB,
  ADD COLUMN IF NOT EXISTS bankroll           INTEGER NOT NULL DEFAULT 10000;

-- ── Row Level Security for session_groups ─────────────────────────────────

ALTER TABLE session_groups ENABLE ROW LEVEL SECURITY;

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

-- ── Trigger: keep updated_at current on session_groups ────────────────────

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
