# PEDLAS v3 — Sessions, Coverage-Guaranteed Slips, and a Team Product

This supersedes the ad-hoc build+place flow with a **session-based product**: pick book(s) →
budget + target → the engine sizes the slate and **guarantees at least one winning slip against
up to C cutters** → persist everything server-side → place, retry until done, and settle on load.

Everything here stays honest: **every slip is still a −vig multibet.** The structure does not beat
the book's margin — it converts budget into *coverage depth* so that the empirical "Under-4.5 @≥1.20
cuts on only 1–3 games per slate" regularity, **if it holds**, is captured. Whether it holds is an
empirical question we answer with a backtest (§7), not an assumption.

---

## 1. The user story (the product)

1. **Dashboard (landing)** — recent sessions, running totals (staked / returned / open), and a big
   **Bet Manager** button. Info panels explain what each part does.
2. **Bet Manager** — a wizard:
   - **Book(s)**: SportyBet (default), Betway, Stake, … — **multi-select**.
   - **Date range** (near-term; 1–2 days).
   - **Budget** (₦) and **Target potential win** (₦).
3. The engine reads each book's **config** (min stake, caps, boost, pacing — all server-side, CRUD in
   the Config page), then:
   - Selects every game matching the rule (Under 4.5 @ odds ≥ minDominantOdds).
   - Sizes **L** (legs per slip) so `minStake × combinedOdds × (1+boost) ≥ target`.
   - Sizes **K** (slip count) = `⌊budget / minStake⌋`.
   - Sizes **N** (pool) so K slips form a **covering design** of depth **C** (§4).
4. Creates a **session record** (`XXXXXXX`), stores all K slips (each with a booking code for
   idempotency), then **places each**, watching status (placed / failed), **retrying until done** or
   abandoning with a reason.
5. On every visit / page load, the app **re-settles**: pull results, update each slip
   (won / lost / void / open), and show the session's real P&L.

### Worked example (the user's)
SportyBet · 16–17 Jul 2026 · budget ₦5,000 · target ₦500,000 · minStake ₦10.
- `R = target/stake = 50,000×`. With the day's Under-4.5 odds this is ≈ **33–49 legs** (`L`).
- `K = 5000 / 10 = 500 slips`.
- Pool `N ≈ L + cushion` (e.g. 40). 500 slips ≥ the depth-3 covering bound (§4) → **guaranteed a
  winning slip if ≤3 games cut** — which is the observed worst case.

---

## 2. Architecture (all server-side, nothing local)

```
Dashboard ──▶ Bet Manager (wizard) ──▶ POST /api/sessions
                                          │  build: select → size L,K,N,C → covering design
                                          ▼
                                   pedla_sessions (row XXXXXXX)
                                   pedla_placements (K slips, status=pending, booking_code)
                                          │  place loop (CDP), retry-until-done, idempotent
                                          ▼
                                   receipts → status placed/failed
On load: GET /api/sessions/:id ──▶ settle (results) ──▶ won/lost/void + P&L
```

- **Config** moves from `placement.config.json` → **`book_configs`** table (CRUD API + UI).
- **Sessions** are new (`pedla_sessions`); slips reuse **`pedla_placements`** + a `session_id`.
- No local files in the request path. Scripts (`auto.mjs`) stay as an operator convenience only.

---

## 3. Data model (migration `006_sessions_and_configs.sql`)

```sql
-- Per-book config, server-side + CRUD (replaces placement.config.json)
CREATE TABLE book_configs (
  book_id      TEXT PRIMARY KEY,      -- registry id; row may exist for feed-less "manual" books
  label        TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'NGN',
  min_stake    NUMERIC(12,2) NOT NULL DEFAULT 10,
  max_payout   NUMERIC(14,2) NOT NULL DEFAULT 50000000,
  enabled      BOOLEAN NOT NULL DEFAULT false,
  boost_json   JSONB,                 -- verified Win-Boost table or null
  delay_min_sec INT NOT NULL DEFAULT 45,
  delay_max_sec INT NOT NULL DEFAULT 180,
  kickoff_cutoff_min INT NOT NULL DEFAULT 20,
  daily_budget_cap NUMERIC(14,2) NOT NULL DEFAULT 5000,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- A build+place session (the XXXXXXX record)
CREATE TABLE pedla_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT UNIQUE NOT NULL,         -- short human id, e.g. S-7F3K2Q
  book_ids     TEXT[] NOT NULL,
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  budget       NUMERIC(14,2) NOT NULL,
  target_win   NUMERIC(14,2) NOT NULL,
  min_stake    NUMERIC(12,2) NOT NULL,
  leg_count    INT,                          -- L
  slip_count   INT,                          -- K
  pool_size    INT,                          -- N
  coverage_depth INT,                        -- C (guaranteed cutters)
  status       TEXT NOT NULL DEFAULT 'building'
               CHECK (status IN ('building','placing','done','failed','stopped')),
  meta         JSONB,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS session_id UUID
  REFERENCES pedla_sessions(id) ON DELETE CASCADE;
ALTER TABLE pedla_placements ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
-- widen status: pending | placing | placed | failed | simulated | skipped | won | lost | void
```

`pedla_placements` already carries booking_code, bet_id, idempotency_key, settlement (won/returned/
leg_results) — we extend it with `session_id` + `attempts` and reuse the rest.

---

## 4. The engine maths (the heart)

**Binary market.** Over/Under X is exhaustive: exactly one side occurs. At **X = 4.5**, "Under"
(0–4 goals) covers the overwhelming majority of football scorelines. A book pricing Under 4.5 at
**odds ≥ 1.20** is marking a high-probability-but-non-trivial pocket. Call a game a **cutter** on a
slate if it finishes **Over 4.5** (≥5 goals). Empirically the user observes **1–3 cutters** per slate.

**Slip = an L-subset of the N pool games, all legs Under.** A slip **wins** iff none of its L legs is
a cutter — equivalently, **all cutters sit in its omitted set** (the N−L games it left out).

**Coverage design.** Treat each slip's *omitted set* as a block of size `k = N − L`. If the family of
K blocks is a **covering design** `C(N, N−L, C)` — every C-subset of the N games lies inside at least
one block — then **whatever ≤C games actually cut, some slip omitted all of them → that slip wins.**

**Budget buys depth.** The counting lower bound on slips to cover depth C:

```
K_min(C)  ≥  C(N, C) / C(N−L, C)
```

Worked, for **N = 40, L = 33** (omit k = 7):

| Depth C (cutters guaranteed) | slips needed K_min | budget @ ₦10 |
|---|---|---|
| 1 | 6   | ₦60 |
| 2 | 38  | ₦380 |
| 3 | **283** | **₦2,830** |
| 4 | 2,611 | ₦26,110 |

The empirical worst case (3 cutters) → **~283 slips → ₦2,830**. The user's **₦5,000 (500 slips)**
clears depth‑3 with margin (greedy covering designs run ~10–30% over the counting bound, so budget the
real construction at ~350–400 slips for depth 3 — still inside 500). **Raising the budget raises the
guaranteed depth** — exactly the intuition "even better when we increase the amount."

**Per-slip payout.** Odds vary slightly per leg, so the greedy builder tops up each slip to `L` (or
`L+1`) legs until `stake × Πodds × (1+boost) ≥ target`; every stored slip clears the target by
construction.

**Sizing rule.** Given target `W`, stake `s`, pool odds, and budget `B`:
1. `L` = greedy legs to reach `R = W/s`.
2. `K = ⌊B/s⌋`.
3. Choose `N` so `K ≥ K_min(C_target)` with `C_target` from config (default 3). If the live slate has
   fewer than `N` qualifying games, **lower `C_target`** (and say so) rather than fake the pool.

---

## 5. Honest EV & risk (read this to the team)

- **No edge.** Each slip pays `−vig`; over infinitely many independent slates the average return is
  below stake. The design does **not** change that. It reshapes *variance*, not *expectation*.
- **Guarantee is conditional.** "≥1 winning slip" holds **iff** (a) the real cutter count `c ≤ C`,
  (b) all cutters are inside the N pool (covering design ensures they're omittable), and (c) no leg we
  treated as safe cuts beyond the budgeted depth. If `c > C`, the likely outcome is **zero hits —
  total loss of that session's budget.**
- **Payoff shape.** When `c ≤ C`: at least one slip wins (pays ≥ `W`); when `c` is *small*, **many**
  slips win (huge upside). When `c > C`: lose the budget. So it is a **"small stake, big skew,
  occasional total loss"** instrument — never money you can't lose.
- **Correlation is the real enemy.** Cutters are **not** independent — a high-scoring matchday lifts
  `c` across the board. The covering design is robust to *which* games cut, not to *how many*. The
  only thing that matters for ruin is `P(c > C)`.
- **Therefore:** profitability = `P(c ≤ C)` must be **measured**, per book and slate size, before any
  real money scales. That is §7.

---

## 6. Placement lifecycle (fail-safe, idempotent)

- Build persists K slips as `status='pending'` with a **booking_code** (SportyBet `/orders/share`,
  public) and an `idempotency_key` = hash(book|stake|legs). The code makes each slip reproducible and
  the key makes double-placement impossible.
- Place loop (CDP, existing `place-all-cdp`): per slip → `placing` → confirm by **balance drop +
  "Submission Successful" + bet history** → `placed`; else `failed(reason)`.
- **Retry until done:** a bounded worker re-attempts `failed` slips (not `won/lost`), exponential
  backoff, `attempts` capped (e.g. 3). Beyond the cap → stays `failed` for a human (no blind loop).
- **Guards:** kickoff cutoff (skip if a leg is too close), daily budget cap per book, kill switch,
  human-paced jitter — all already in `queue.ts`, moved behind the session.
- **Settle on load:** `GET /api/sessions/:id` pulls results (SportyBet bet-history / results), sets
  `won/lost/void`, `returned`, `leg_results`, and recomputes session P&L.

---

## 7. Validation before scaling (the one thing that decides if this is real)

Backtest the **cutter distribution**: for each historical day, take all games a book priced
Under 4.5 @ ≥1.20, count `c` = how many finished Over 4.5. Report:
- distribution of `c` (and `c` as a fraction of pool size N),
- `P(c ≤ 3)`, `P(c ≤ 2)`, `P(c ≤ 1)`,
- worst matchdays (the correlation tail),
- implied return: for depth `C` at budget `B`, `E[return] = P(c≤C)·(payout when hit) − B`, using the
  real per-slate `c`.

We already store `match_history`; extend the ETL to tag Over/Under-4.5 outcomes and run this. **If
`P(c ≤ 3)` is high and stable, PEDLA v3 is worth deploying to the team. If not, we learned it cheaply.**

---

## 8. Config CRUD — the honest scope

- **Fully CRUD from the UI (server-side):** every field in `book_configs` — min stake, caps, boost
  table, pacing, daily cap, enabled. Add a **row** for any book id.
- **Caveat:** a book that actually *pulls odds* and *places* needs a code **adapter** (`lib/books/*`,
  `lib/placement/place-*`). You can create a config row from the UI, but a brand-new book only goes
  *live* once its adapter is added (small, well-scoped code change). The UI will show a book as
  "config only" vs "feed-verified / placement-verified" so this is never a surprise.

---

## 9. Phased build

1. **Config → server** (`book_configs` table, CRUD API, Config page). Low risk, unblocks the rest.
2. **Sessions** (`pedla_sessions` + `session_id`), `POST /api/sessions` = build+persist, `GET` = settle.
3. **Coverage engine v3** — leg-count-from-target, `N` sizing, covering-design slip construction
   (greedy block-cover), per-slip top-up. Unit-tested against the §4 bounds.
4. **Placement lifecycle** — session-driven place loop, retry-until-done, settle-on-load.
5. **Dashboard + Bet Manager** — the visual flow, multi-book, live session view.
6. **Backtest (§7)** — cutter distribution; decide scale.
7. **Harden & deploy private** — RLS/auth for the team, edge cases, rate-limit safety, monitoring.

> Recommendation: do **§7 (backtest) early**, in parallel with Phase 1–2. It is the cheapest thing
> that can tell us the whole idea is or isn't worth the full build.
