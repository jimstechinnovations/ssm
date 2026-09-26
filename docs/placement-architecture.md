# Placement architecture: multi-PC, no double placing

Status: **built (2026-09-25).** Live placement runs through a shared database queue (migration
`008_bot_and_placement_queue.sql`), so any PC can place a session, a run can move from one PC to another
mid-way, and several PCs can place the same session at once, without any slip being placed twice.
Verified by `node scripts/test-queue.mjs` (11/11 guarantees against the real database) and by concurrent
placer runs.

## How a slip moves

```text
pending ──claim (lease 3 min)──▶ placing ──begin_submit──▶ submitting ──▶ placed | failed | skipped
   ▲                               │                           │
   └── lease expired / released ───┘                           └── lease expired ──▶ verify
       (never submitted: safe to hand to any PC)                   (may be on SportyBet: checked
                                                                     against bet history, never guessed)
```

| Step | Guarantee |
|---|---|
| **claim** (`claim_slips`, `FOR UPDATE SKIP LOCKED`) | Two workers can never be handed the same slip, even at the same instant. |
| **lease** (renewed every 10s by the worker's heartbeat) | If a PC dies, its unsubmitted slips return to the pool within 3 minutes. |
| **begin_submit**, right before Confirm | Only the current lease holder can move a slip to `submitting`. After that no one else can take it. |
| **account lock** (`placement_locks`, 30s TTL) | Place→Confirm is serialised per SportyBet account across PCs (the site rejects simultaneous submits). A dead holder can't block others for long. |
| **ownership on results** | A worker can only record the result of a slip it still holds; a worker that lost its lease can't overwrite another PC's result. |
| **verify** | A slip that died mid-submit is checked against the account's bet history automatically when a placer next starts. Found → recorded as placed. Absent (history covering the submit time) → returned to the queue. Unclear → left for you on the session page. |

## Checks on every slip (in the placer, `scripts/place-all-cdp.mjs`)

1. The booking code is built from the slip's exact selections (any market).
2. After loading, the betslip's own storage must contain **only** this slip's games (no foreign games).
3. Games suspended at placement drop out: the shorter slip is placed and recorded as such.
4. The site's Odds, Stake and Potential Win (bonus included) are read off the betslip; if the payout is
   **below the session target**, the slip is skipped.
5. Inside the submit lock, right before Confirm, the betslip is checked **again** for exactly this slip's
   games (so nothing can swap it at the last moment).
6. Success is confirmed by the site's "Submission Successful". An explicit rejection returns the slip to the
   queue (safe to retry); anything uncertain after Confirm goes to **verify**.
7. The site's numbers are stored with the slip (`site_odds`, `site_stake`, `site_payout`), and settlement
   pays out `site_payout`.

## Constraints (tested)

- **One placer per Chrome.** All tabs of a Chrome profile share one betslip, so a second tab (or a second
  placer on the same Chrome) could load another slip while one is confirming. The placer enforces this
  with a lock file and refuses to start a second one. The old "browser tabs 2–4" option is removed.
- **One submit at a time per account** (SportyBet's rule). More PCs on one account speed up loading and
  checking, but submits take turns. For a true N× speed-up, use N accounts (one per PC/Chrome).
- The order API body is encrypted, so each submit is real clicks (~2s).

## Running it

- **One PC:** Session page → **Prepare browser** → **Place**. A log is written to
  `logs/placer-<session>-<pc>-<time>.log`.
- **Move to another PC:** press **Stop** (or just close the first PC). On the other PC, open the app
  (same `.env`, so the same database), then **Prepare browser** → **Resume**. Unsubmitted slips come back
  immediately after Stop, or within 3 minutes after a crash.
- **Several PCs at once:** while a run is active, press **Add this PC** on another PC. The session page lists
  every PC placing it (placed / returned / current slip).
- **CLI:** `node scripts/place-session.mjs S-CODE --live --base http://localhost:3000` does the same.

## Still true

- Anti-bot risk grows with more accounts, server IPs and faster placing. Ramp carefully.
- Never auto-toggle REAL/SIM (see memory). Confirm REAL mode in the Chrome window before a live run.
