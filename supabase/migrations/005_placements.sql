-- ============================================================
-- PEDLA — placed slips (the money ledger + learning loop)
-- Migration: 005_placements.sql
--
-- One row per slip we TRIED to place. `status` records what the BOOKMAKER confirmed
-- (never what our bot hoped): only 'placed' means the site showed the balance move
-- and/or the bet in its history. Booking code + bet id keep engine and book in sync,
-- so any slip can be reopened by hand at the bookmaker.
-- ============================================================

CREATE TABLE IF NOT EXISTS pedla_placements (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT        NOT NULL,
  book_id           TEXT        NOT NULL,          -- lib/books adapter id (betway_nigeria | sportybet | …)
  pedlas_book_id    UUID        REFERENCES pedlas_books(id) ON DELETE SET NULL,
  slip_id           INTEGER     NOT NULL,
  idempotency_key   TEXT        NOT NULL,          -- never place the same slip twice
  dry_run           BOOLEAN     NOT NULL DEFAULT true,

  -- what we intended
  stake             NUMERIC(12,2) NOT NULL,
  combined_odds     DOUBLE PRECISION NOT NULL,
  potential_payout  NUMERIC(14,2),
  leg_count         INTEGER     NOT NULL,
  legs              JSONB       NOT NULL,          -- PedlasLeg[] as placed
  true_prob         DOUBLE PRECISION,

  -- what the bookmaker said (the receipt)
  status            TEXT        NOT NULL           -- placed | failed | simulated | skipped
                    CHECK (status IN ('placed', 'failed', 'simulated', 'skipped')),
  confirmed_by      TEXT,                          -- balance+history | balance | history | none
  booking_code      TEXT,                          -- reopen the exact slip at the book
  bet_id            TEXT,                          -- the book's own ticket id
  site_odds         DOUBLE PRECISION,              -- odds as the SITE displayed them
  balance_before    NUMERIC(14,2),
  balance_after     NUMERIC(14,2),
  failure_reason    TEXT,

  -- settlement (auto from results, or entered by hand)
  settled           BOOLEAN     NOT NULL DEFAULT false,
  settled_at        TIMESTAMPTZ,
  settled_by        TEXT,                          -- auto | manual
  won               BOOLEAN,                       -- true = every leg landed
  returned          NUMERIC(14,2),                 -- actual payout received
  leg_results       JSONB,                         -- [{fixtureId, goals, side, hit}]
  notes             TEXT,

  placed_at         TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedla_placements_created ON pedla_placements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pedla_placements_run     ON pedla_placements (run_id);
CREATE INDEX IF NOT EXISTS idx_pedla_placements_open    ON pedla_placements (settled) WHERE status = 'placed';

-- A real (non-dry-run) slip may only be placed once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedla_placements_idem
  ON pedla_placements (idempotency_key) WHERE dry_run = false AND status = 'placed';

ALTER TABLE pedla_placements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access placements" ON pedla_placements;
CREATE POLICY "service role full access placements" ON pedla_placements
  FOR ALL USING (true) WITH CHECK (true);
