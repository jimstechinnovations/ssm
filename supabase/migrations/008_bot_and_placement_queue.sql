-- ============================================================
-- PEDLA — Decision Bot decisions + a multi-PC placement queue
-- Migration: 008_bot_and_placement_queue.sql
--
-- 1. pedla_placements.decision — the bot's slip-level decision (rule, reason, win chance, keep).
--
-- 2. A placement queue that lives in the DATABASE, so any PC can place a session, a run can move from
--    one PC to another mid-way, and several PCs can place in parallel — with NO double placing:
--
--      pending ──claim_slips──▶ placing ──begin_submit──▶ submitting ──▶ placed | failed | skipped
--                  (lease)          │  lease expires              │ lease expires (worker died mid-submit)
--                                   └──────▶ pending (re-claimable)└──────▶ verify (NEVER auto-retried:
--                                                                             checked against bet history)
--
--    • claim_slips hands out slips atomically (FOR UPDATE SKIP LOCKED) — two PCs can't get the same slip.
--    • A claim is a LEASE: the worker renews it while alive; if the PC dies the slip returns to the pool.
--    • begin_submit is the point of no return: only the current lease holder can move a slip to
--      'submitting' (checked atomically) right before clicking Confirm. A 'submitting' slip whose worker
--      vanished may or may not have been placed, so it goes to 'verify' — it is re-placed only after
--      bet history proves it was not.
--    • placement_locks serialises Place→Confirm per SportyBet ACCOUNT across PCs (the site rejects two
--      simultaneous submits from one account); placement_workers is the live roster for the UI.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS decision          JSONB;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS claimed_by        TEXT;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS claim_expires_at  TIMESTAMPTZ;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS submit_started_at TIMESTAMPTZ;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS last_error        TEXT;

ALTER TABLE pedla_placements DROP CONSTRAINT IF EXISTS pedla_placements_status_check;
ALTER TABLE pedla_placements ADD CONSTRAINT pedla_placements_status_check
  CHECK (status IN ('pending','placing','submitting','verify','placed','failed','simulated','skipped','won','lost','void'));

CREATE INDEX IF NOT EXISTS idx_pedla_placements_queue ON pedla_placements (session_id, status, slip_id);

CREATE TABLE IF NOT EXISTS placement_workers (
  worker_id    TEXT PRIMARY KEY,               -- host:pid:random
  session_id   UUID REFERENCES pedla_sessions(id) ON DELETE CASCADE,
  host         TEXT,
  account      TEXT,                           -- masked SportyBet account (last 4 digits)
  live         BOOLEAN NOT NULL DEFAULT false,
  state        TEXT NOT NULL DEFAULT 'running', -- running | stopping | done | crashed
  current_slip INT,
  placed       INT NOT NULL DEFAULT 0,
  failed       INT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_placement_workers_session ON placement_workers (session_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS placement_locks (
  account    TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE placement_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_locks   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access workers" ON placement_workers;
CREATE POLICY "service role full access workers" ON placement_workers FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role full access locks" ON placement_locks;
CREATE POLICY "service role full access locks" ON placement_locks FOR ALL USING (true) WITH CHECK (true);

-- Hand out up to p_n slips to p_worker. First sweeps the session: a 'placing' slip whose lease expired
-- goes back to 'pending' (its worker never started submitting), a 'submitting' slip whose lease expired
-- goes to 'verify' (it may have been placed — never re-placed blindly).
CREATE OR REPLACE FUNCTION claim_slips(p_session UUID, p_worker TEXT, p_n INT, p_lease_sec INT, p_max_attempts INT DEFAULT 3)
RETURNS SETOF pedla_placements LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pedla_placements SET status = 'pending', claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
   WHERE session_id = p_session AND status = 'placing' AND claim_expires_at < now();
  UPDATE pedla_placements SET status = 'verify', updated_at = now(),
         last_error = 'worker vanished during submit — check bet history before re-placing'
   WHERE session_id = p_session AND status = 'submitting' AND claim_expires_at < now();
  RETURN QUERY
  UPDATE pedla_placements p
     SET status = 'placing', claimed_by = p_worker, claim_expires_at = now() + make_interval(secs => p_lease_sec),
         attempts = p.attempts + 1, updated_at = now()
   WHERE p.id IN (
     SELECT q.id FROM pedla_placements q
      WHERE q.session_id = p_session AND q.status = 'pending' AND q.attempts < p_max_attempts
      ORDER BY q.slip_id
      LIMIT p_n
      FOR UPDATE SKIP LOCKED)
  RETURNING p.*;
END $$;

-- Keep this worker's leases alive (called with its heartbeat). Returns how many it still holds.
CREATE OR REPLACE FUNCTION renew_claims(p_worker TEXT, p_lease_sec INT)
RETURNS INT LANGUAGE sql AS $$
  WITH r AS (
    UPDATE pedla_placements SET claim_expires_at = now() + make_interval(secs => p_lease_sec)
     WHERE claimed_by = p_worker AND status IN ('placing', 'submitting') RETURNING 1)
  SELECT count(*)::int FROM r;
$$;

-- The point of no return. TRUE only if this worker still holds a live lease on the slip; the slip is then
-- 'submitting' and nobody else can ever claim it. Call right before clicking Confirm.
CREATE OR REPLACE FUNCTION begin_submit(p_id UUID, p_worker TEXT)
RETURNS BOOLEAN LANGUAGE sql AS $$
  WITH r AS (
    UPDATE pedla_placements SET status = 'submitting', submit_started_at = now(), updated_at = now()
     WHERE id = p_id AND claimed_by = p_worker AND status = 'placing' AND claim_expires_at > now() RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r);
$$;

-- Graceful stop / crash-free handover: give back everything this worker claimed but never submitted.
CREATE OR REPLACE FUNCTION release_claims(p_worker TEXT)
RETURNS INT LANGUAGE sql AS $$
  WITH r AS (
    UPDATE pedla_placements SET status = 'pending', claimed_by = NULL, claim_expires_at = NULL,
           attempts = GREATEST(attempts - 1, 0), updated_at = now()
     WHERE claimed_by = p_worker AND status = 'placing' RETURNING 1)
  SELECT count(*)::int FROM r;
$$;

-- Per-account submit lock with a short TTL (a dead holder can't block others for long).
CREATE OR REPLACE FUNCTION acquire_account_lock(p_account TEXT, p_holder TEXT, p_ttl_sec INT)
RETURNS BOOLEAN LANGUAGE sql AS $$
  WITH r AS (
    INSERT INTO placement_locks (account, holder, expires_at) VALUES (p_account, p_holder, now() + make_interval(secs => p_ttl_sec))
    ON CONFLICT (account) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE placement_locks.expires_at < now() OR placement_locks.holder = excluded.holder
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r);
$$;

CREATE OR REPLACE FUNCTION release_account_lock(p_account TEXT, p_holder TEXT)
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM placement_locks WHERE account = p_account AND holder = p_holder;
$$;
