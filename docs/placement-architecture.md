# Placement architecture — scaling off the laptop (design, not yet built)

Goal: make live placement **reliable, unsupervised, and fast enough to place near match-time**, instead
of a laptop running one debug Chrome. This is a design doc to agree the approach before building.

## The current setup (works, but laptop-bound)
- One debug Chrome (:9222) on the laptop, driven over CDP by `scripts/place-all-cdp.mjs`.
- N "workers" = N **tabs in one context**. A **submit mutex** serializes Place→Confirm.
- Places 50%+ of 600 slips unsupervised, but: laptop sleep / network drops / occasional worker stalls
  make it unreliable, and it's not fast.

## The REAL bottleneck — TESTED 2026-07-19 (scripts/test-parallel-place.mjs)
Two layers, both real:
1. **Shared betslip per context.** A browser context has ONE betslip, shared by every tab
   (`betslips` / `betslipsSelections` in localStorage — verified). So tabs can't even *load* two codes at
   once. Fix: separate contexts (each its own betslip; `newContext({storageState})` clones the login).
2. **A per-account submit lock (server-side).** Even with two *independent* sessions (separate betslips,
   same account), a live 4-slip / 3-session test collided: w1 and w2 submitted ~0.8s apart, w2 SUCCEEDED
   and w1 got **"Submission Failed"** at the same instant. Balance-confirmed 2 of 4 placed (₦20 drop).
   So concurrent Place→Confirm within ~2–4s **is** rejected per account — the operator's cross-device
   "no block" was human-staggered timing, not truly simultaneous.

The order API body is also **encrypted** (memory `sportybet-placement-api`), so each submit is ~2s of
browser clicks. Net: **submit is serial per account** (~2s/slip); only PREP (load/stake) parallelizes.

## The levers

### Lever 1 — Multi-ACCOUNT (the real speed win)
The submit lock is **per account**. True parallel submit ⇒ **M accounts**, each its own session + lock:
```
600 slips ÷ 1 account  × ~2s  ≈  20–30 min
600 slips ÷ 5 accounts × ~2s  ≈  4–6 min   →  near match-time feasible
```
Multi-SESSION on ONE account only parallelizes prep (still-serial submit) — a *modest* gain, and it needs
a **cross-session submit mutex + retry** (the failed slip just needs a re-submit; it wasn't bad). Cloning
the login into extra contexts works (`newContext({storageState})`, grounded), so a one-account rig can
prep-ahead while submitting serially — but for near-match-time speed you need real accounts.

### Lever 2 — Off the laptop (reliability)
Move the placer to an **always-on machine** (dedicated box, or a cloud/VPS). Headless Chrome + CDP works
identically to the laptop. Solves sleep / network / unsupervised reliability.
- **Caveat (must validate):** SportyBet is Nigeria-only and anti-bot. A datacenter IP may be geo-blocked
  or flagged. Likely needs a **Nigerian residential proxy** per account. The laptop works today *because*
  it's a real residential connection — a server must reproduce that.

### Lever 3 — Mother controller (orchestration + self-healing)
A persistent controller service that owns the run:
- **Job queue** (DB/Redis) of slips; assigns to workers; idempotent placed-log **per account**.
- **Workers** = independent browser sessions, one per account. Pull a slip → place → report. Heartbeat.
- **Per-account submit mutex** (serialize *within* an account, parallel *across* accounts).
- **Auto-requeue** failed slips (already in place-all-cdp; centralize it).
- **Health + self-healing:** cold heartbeat or N failures → kill + **respawn** the worker (fresh tab /
  re-login); check balance / logged-in / REAL per account before assigning.
- This is an evolution of what `place-all-cdp.mjs` already does (round-robin queues, retry, slip-status
  heartbeat) — centralized, multi-account, server-hosted.

## Honest risks / constraints
- **Anti-bot is the big one.** More accounts + server IPs + rapid placement = higher chance of limits or
  bans. This is the real cost of scaling, not the code. Ramp carefully; keep human-like pacing.
- **Encrypted order API** ⇒ no fast path per account; horizontal (more accounts) is the *only* scaling
  axis. ~2s/slip/account is a floor.
- **Capital + proxies:** M accounts need M balances; server placement likely needs Nigerian residential
  proxies (cost + setup).
- **Near-match-time is a trade-off:** placing closer to kickoff means fresher games but a higher chance a
  game **suspends mid-run** (we've seen it). place-shorter + reconcile handle it, but faster ≠ free.
- **REAL/SIM per account:** never auto-toggle (memory `never-auto-toggle-real-sim`); confirm REAL via
  balance-drop per account.

## Recommended phased plan
1. **Phase 0 — reliability on the laptop (small, do first).** Finish worker self-healing: drop + respawn
   a stuck worker, full blocking-dialog handling (logout / Accept Changes / OK / ×). Same speed, far
   fewer stalls. Lowest risk, immediate benefit.
2. **Phase 1 — off-laptop, single account.** Run the existing placer on an always-on machine (validate no
   geo-block; add a Nigerian residential proxy if needed). Reliable + unsupervised, same ~20-min speed.
3. **Phase 2 — mother controller + multi-account.** The M× speed win for near-match-time. Biggest build,
   biggest risk (anti-bot, capital, proxies). Only after Phases 0–1 are solid.

## Open questions to decide before building
- How many accounts are realistically available/fundable? (sets the speed ceiling)
- Dedicated home machine vs cloud+residential-proxy? (reliability vs geo-block risk)
- Acceptable anti-bot risk appetite / pacing? (aggressive = faster but riskier)
