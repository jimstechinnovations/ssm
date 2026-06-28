-- ============================================================
-- PEDLAS match-history store — rate-limit-proof results corpus for form features.
-- Migration: 004_match_history.sql  (run once in the Supabase SQL editor)
-- Populated by the ETL: POST /api/pedlas/history/sync (apifootball get_events per league).
-- ============================================================

CREATE TABLE IF NOT EXISTS match_history (
  match_id    TEXT        PRIMARY KEY,
  league_id   INTEGER,
  match_date  DATE        NOT NULL,
  home_name   TEXT        NOT NULL,
  away_name   TEXT        NOT NULL,
  home_goals  INTEGER     NOT NULL,
  away_goals  INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_history_home   ON match_history (home_name, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_match_history_away   ON match_history (away_name, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_match_history_league ON match_history (league_id, match_date DESC);

ALTER TABLE match_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on match_history"
  ON match_history FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Anon read-only on match_history"
  ON match_history FOR SELECT TO anon USING (true);
