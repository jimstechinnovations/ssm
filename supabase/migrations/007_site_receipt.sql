-- ============================================================
-- PEDLA — record what the SITE actually accepted, not just what we built
-- Migration: 007_site_receipt.sql
--
-- Odds move between build and placement ("Accept Changes"), games get suspended and dropped, and the
-- bonus is odds-dependent — so the built combined_odds / potential_payout can differ from the real
-- bet. The placer now reads the betslip right before Confirm and stores the site's own numbers here.
-- Settlement credits site_payout when present. site_odds already exists (005).
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS site_stake   NUMERIC(12,2);   -- Total Stake shown on the betslip
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS site_payout  NUMERIC(14,2);   -- Potential Win (incl. bonus) shown on the betslip
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS placed_fixtures JSONB;        -- fixture ids actually on the betslip at Confirm
