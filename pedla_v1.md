# PEDLA v1 — Multi-Book Under-4.5 Structure Builder + Placement Bot

> **PEDLA** = PEDLAS minus **S** (slip separation) and **E** (identical-run elimination).
> Both were variance-shaping constraints that fought the most probable region of the outcome
> space; measured reasoning below. What remains: **P**ool, **E**→(dropped), **D**iversity,
> **L**egs, **A**nchor — a probability-ranked, budget-filled coverage structure.

## 0. Honest stance (unchanged, non-negotiable)

We are **not** claiming +EV. The goal, in the user's words: *turn a min bet (₦100) toward the
highest potential win within a limited budget with a good structure — not randomly throwing money
away*. Every book stays −vig; the boost is a subsidy; the structure shapes variance, not edge.
All prior measurements stand ([pedlas_v2.md](pedlas_v2.md) §1a): no goals model beats the book,
so no model output may change odds/EV maths. Models rank and explain; the book's de-vigged price
remains the probability source.

## 1. Why Under 4.5, and only Under 4.5

Under 4.5 = total goals ≤ 4. On a 0–4 grid that is 15 scoreline cells
(0-0 … 4-0, 1-1, 2-2, 3-1, …) and, at a typical match λ_total ≈ 2.7, Poisson mass
P(N ≤ 4) ≈ **86%**. It is the widest "normal football" net that still pays.

The pricing pocket PEDLA hunts: the book posts **Under 4.5 ≥ 1.20** only when it believes the
match has real Over-4.5 risk (implied ≤ 83% before vig). Those legs simultaneously
(a) stay probable, (b) clear the 1.20 boost-qualification floor, and (c) compound into
meaningful combined odds at 7–15 legs. Lower lines (U1.5–U3.5) at ≥ 1.20 are far more fragile
(mass ~35–75%); higher lines (U5.5+) rarely price ≥ 1.20. So the market policy is:

> **One axis per fixture: the Under 4.5 / Over 4.5 pair, kept iff Under is the dominant side
> and Under odds ≥ 1.20.** (Engine stays generalised; PEDLA passes `lines=[4.5]`,
> `requireDominantSide='Under'`.)

## 2. Why S and E are removed (worked reasoning)

- **S (min pairwise Hamming distance)** forced placed slips apart in outcome space. Since
  vectors are ranked by probability, forcing distance means *replacing likelier vectors with
  unlikelier ones* — it lowered P(any hit) for the same budget. It shaped payout correlation,
  never EV. Removed: fill = top-K by rank.
- **E (max identical run)** pruned vectors with long same-side runs. But legs are independent
  matches at p(Under) ≈ 0.83 each; the probability that 10 kickoff-ordered legs are all Under
  is 0.83¹⁰ ≈ 15% — long runs are what independence *looks like*, and the single most probable
  vector is all-Under. E pruned exactly the highest-probability region. Removed.
- **Kept:** D (max legs per league — real correlation guard: same-league games share weather,
  refereeing, derby dynamics), A (min Over-flips — the deliberate lever between "floor" and
  "payout"), L (leg count), budget fill K = ⌊budget / minStake⌋.

The "runs" observation is real but not exploitable: streaks of Under across a kickoff-ordered
slate arise from independence itself. Any "compression" of the space is exactly *rank vectors by
true probability, place the top K* — which is what the engine now does with S/E gone.

## 3. Multi-bookmaker architecture

```text
lib/books/
  types.ts            BookAdapter interface + registry types
  registry.ts         id → adapter map; listBooks()
  betway-nigeria.ts   Playwright public-feed scraper (existing, verified) + Win Boost table
  sportybet.ts        Public JSON API (probed 2026-07-13, works unauthenticated) — fetch-based
  stake.ts            Cloudflare-gated; registered `verified:false` until a live session exists
```

`BookAdapter` = `{ id, label, currency, minStake, maxPayout, boostFor(n), fetchFixtures(opts),
placeSlip?(slip, creds, page) }`. The engine is book-agnostic: `buildPedlasBook` now takes the
boost function from the adapter (Betway's table is Betway's, not the engine's). **A slip lives at
exactly one book** — multi-select builds one PEDLA book per selected bookmaker, splitting the
budget equally unless per-book budgets are given.

Boost tables: Betway Nigeria's is measured and kept. SportyBet/Stake default to **0 boost until
their real tables are verified against a live betslip** — payouts must never be overstated.

Future (spec'd, not built): cross-book price comparison on fuzzy-matched fixtures — the closest
thing to a value signal soft books can give. Requires team-name matching; phase 2.

## 4. Placement bot (user accepts ToS/account risk — recorded)

Goal: place K slips at min stake **the way a careful human would**, never machine-gun.

- **Dry-run is the default and the only mode unless `PLACEMENT_LIVE=1` env is set AND the run
  is started with `dryRun:false`.** Dry-run executes the full pipeline and logs every action
  it would take.
- **Pacing:** jobs are scheduled sequentially with uniform-random delays in
  [delayMinSec, delayMaxSec] (config, default 45–180 s), a hard rule that all legs' kickoffs are
  ≥ cutoffMinutes (default 20) in the future at placement time, and a daily budget cap per book.
- **Safety:** idempotency key per slip (never double-place), kill switch (stop endpoint),
  every job's outcome persisted in the run log, failures never retried blindly.
- **Credentials:** env vars only (`BETWAY_NG_USERNAME` / `BETWAY_NG_PASSWORD`, etc.), never in
  DB, never in config files. The config page shows only whether the env var is set.
- **SportyBet live placement (2026-07-13, supervised):** the public `/api/ng/orders/share`
  endpoint turns a slip's selections into a **booking code** (no auth) — that code is our audit
  trail: pasted into any SportyBet session it reproduces the identical slip. The bot then logs in
  (`input[name=phone]` / `input[name=psd]` / `button.m-btn-login`), clears the betslip, loads the
  code, verifies leg count + the site's own total odds (>10% drift aborts) and stake, then places.
  Implementation: `lib/placement/place-sportybet.ts`. Verified against the live site: booking code,
  login, betslip load (8/8 legs, site odds 14.72 = engine odds exactly), stake, enabled Place Bet.
- Betway live placement remains a locked skeleton; its selectors must be verified the same way.

### 4a. A placement is only real when the BOOKMAKER says so

**Incident (2026-07-13).** The first live run reported `PLACED`. It had not placed anything:
SportyBet's own history said *"No Bets Available"* and the balance was untouched at ₦100. The
placer had "confirmed" success by regex-matching page text (`/success|ticket|your bet/i`), which
matched incidental site copy. **Page text is not evidence.**

The rule now (`lib/placement/receipt.ts`, enforced in `queue.ts`): a job may only reach `placed`
when a `PlacementReceipt` comes back `confirmed`, which requires the SITE to agree —

- the account **balance dropped by ~the stake**, and/or
- the bet is **visible in the book's own Bet History**.

Anything else fails the job, keeps the booking code (so a human can finish by hand), and — crucially
— does **not** burn the idempotency key, because nothing was actually placed. A regression test
covers exactly this case. A resolved promise is not a placed bet.

## 4b. The loop: place → observe → settle → learn

- Every finished job (placed, failed, simulated, skipped) is written to `pedla_placements`
  (migration `005_placements.sql`) with its receipt: booking code, bet id, site odds, balance
  before/after, failure reason.
- **Auto-settlement** (`lib/placement/results.ts`) reads real final scores keyed by the *same*
  fixture ids we bet with (`/factsCenter/event?eventId=sr:match:<id>` → `setScore`), grades each
  leg with the engine's own `legWon()`, and marks a slip dead the instant any leg misses. Unplayed
  matches never settle.
- **Manual override** exists for when the book disagrees with us (voids, cashouts, odd settlements).
- `/placements` is the ledger UI: staked vs returned, net, hit rate, per-leg goals, booking codes.

## 5. Config page

`/config`: per book — enabled, min stake, daily budget cap, pacing (min/max delay), kickoff
cutoff; global — dry-run lock indicator, credential-env status. Stored in
`placement.config.json` (git-ignored), validated with zod on read/write.

## 6. History & the neural network (gated future work)

The learning loop keeps accumulating: scraped odds, our placed selections (including bad ones),
and real outcomes (settle.ts + match history store). A future ranker (NN or otherwise) trains on
that dataset but is **hard-gated**: it may influence staking only after a walk-forward backtest
(existing harness: `predict.ts`, `edge.live.test.ts`) shows positive skill above the vig margin.
Until then it is advisory-only, like NIM. We do not rebuild a goals-prediction model — measured
negative ([pedlas_v2.md](pedlas_v2.md) §1a).

## 7. Build phases

1. Engine → PEDLA: drop S/E, Under-4.5-only market policy, adapter-supplied boost. ✅ this build
2. Book adapters: Betway (refactor), SportyBet (new, real), Stake (registered, unverified). ✅
3. Multi-book build API + UI book picker. ✅
4. Config page + placement bot (dry-run). ✅
5. Live placement verification against real Betway session — manual step, gated.
6. Cross-book comparison; gated ranker — later phases.
