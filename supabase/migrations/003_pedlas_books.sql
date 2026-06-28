-- ============================================================
-- PEDLAS Odds Builder — saved books (cloud history + learning loop)
-- Migration: 003_pedlas_books.sql
-- Run this in the Supabase SQL editor (or via the CLI) once.
-- ============================================================

CREATE TABLE IF NOT EXISTS pedlas_books (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  objective        TEXT        NOT NULL DEFAULT 'moonshot'
                   CHECK (objective IN ('moonshot', 'coverage')),
  leg_count        INTEGER     NOT NULL,
  budget           INTEGER     NOT NULL,
  k                INTEGER     NOT NULL,
  slip_count       INTEGER     NOT NULL DEFAULT 0,
  total_stake      INTEGER     NOT NULL DEFAULT 0,
  guaranteed_floor BOOLEAN     NOT NULL DEFAULT false,
  p_any_hit        DOUBLE PRECISION NOT NULL DEFAULT 0,
  ev_multiple      DOUBLE PRECISION NOT NULL DEFAULT 0,
  date_from        DATE,
  date_to          DATE,
  book             JSONB       NOT NULL,   -- full PedlasBook
  request_meta     JSONB,                  -- scan meta + request params
  results          JSONB,                  -- optional: settled results (learning loop)
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Newest-first history queries.
CREATE INDEX IF NOT EXISTS idx_pedlas_books_created
  ON pedlas_books (created_at DESC);

-- ── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE pedlas_books ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on pedlas_books"
  ON pedlas_books FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Anon read-only on pedlas_books"
  ON pedlas_books FOR SELECT TO anon
  USING (true);

-- ── updated_at trigger (set_updated_at() was created in 002) ────────────────
CREATE TRIGGER trg_pedlas_books_updated_at
  BEFORE UPDATE ON pedlas_books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
