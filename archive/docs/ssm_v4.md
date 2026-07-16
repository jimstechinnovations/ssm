# SCORE STRUCTURE MODEL
Version 4.0 — Fingerprint Co-Resolution Slip Builder

## What is new in Version 4.0

v2/v3 reduced every game to a binary (dominant/breakout) and built 56 eight-leg slips
as a **covering code** — "if one slip hits, you cash." v4 changes three pillars at once:

1. **Cross-game accumulators, variable game count.** No longer 8 fixed matches. A pool of
   N games (N ≥ 2). Each slip uses **one market per game**; combined odds = product.
2. **Fingerprint-driven leg selection.** Every scoreline `h-a` resolves a known set of
   markets. Scorelines group into **clusters** that share a block of co-resolving markets.
   We predict each game's likely cluster from its odds and pick legs from that cluster's
   **robust** (always-co-resolving) markets.
3. **Hedge both states.** Across the slip set, every game's predicted side (State 0) **and**
   its opposite side (State 1) are each carried by at least one slip — so the set returns
   something in both the all-as-predicted and the all-flipped worlds.

## Honest mathematical position

Prediction here is **derived from the bookmaker's own odds**. After removing margin, a
de-vigged implied probability *is* the bookmaker's view. Therefore an odds-derived predicted
cluster probability **equals the market price minus vig** — by construction it cannot beat the
line. v4 is a **variance-shaping** tool, not an edge. Two things in v4 are genuinely better
than v3, and one limit is hard:

- **Real gain — fewer legs.** Vig compounds per leg. 8 legs ≈ `0.95⁸ = 0.66` (≈ −34% EV);
  4 legs ≈ `0.95⁴ = 0.81` (≈ −19% EV). Cutting leg count is the single biggest structural
  improvement, and v4 makes short pools first-class.
- **Real gain — deliberate risk shaping.** The fingerprint lets you trade coverage % against
  payout on purpose (broad robust markets → high hit rate, tiny odds; narrow clusters →
  big odds, low hit rate).
- **Hard limit — no edge without an independent signal.** Expected value stays at roughly
  `−margin` per session no matter how the slips are arranged. Positive EV requires a
  prediction source **better than the odds** (xG/stats/your own read), or promos/bonuses.

---

## 1. Core concepts

**Resolution fingerprint.** For a scoreline `h-a`, total `T = h+a`:
`Over k.5 ⇔ T ≥ k+1`, `Under k.5 ⇔ T ≤ k`, `BTTS_YES ⇔ h>0 ∧ a>0`, `ODD ⇔ T odd`,
`DC1X ⇔ h ≥ a`, `HOME ⇔ h > a`, etc. The full 0-0..6-6 table is generated from these rules.

**Cluster.** A family of scorelines. `robustMarkets(cluster)` = the markets that resolve for
**every** scoreline in the family (intersection). For a total-goals band `{T ≥ 3}` the robust
markets are exactly `{Over 0.5, Over 1.5, Over 2.5}`; for `{T ≤ 2}` they are
`{Under 2.5, Under 3.5, Under 4.5, Under 5.5}`. Narrower clusters that also fix the result or
BTTS unlock higher-odds robust markets (the "exploit" legs used in STACK slips).

**Prediction (odds → cluster).** From the Over/Under ladder we de-vig each pair to get
`P(T ≥ n)`, difference into `P(T = n)`, and choose the modal band as **State 0**; the
complementary band is **State 1** (the hedge).

**Slip roles.** `ANCHOR_S0` (every leg = game's State-0 robust market), `ANCHOR_S1` (every
leg = State-1 robust market), `STACK ×K` (mixed/higher-odds combinations covering specific
mixed sessions the anchors miss).

---

## 2. Worked sample — 4-game pool, ₦10,000 bankroll

### Input odds (Over/Under 2.5 line shown; full ladder used for prediction)

| Game | Profile | Over 2.5 | Under 2.5 | De-vigged P(T≥3) | P(T≤2) | Predicted (S0) |
|------|---------|----------|-----------|------------------|--------|----------------|
| G1 | Goal-heavy   | 1.80 | 2.00 | 0.526 | 0.474 | **Over** |
| G2 | Defensive    | 2.40 | 1.55 | 0.392 | 0.608 | **Under** |
| G3 | Goal-heavy + | 1.62 | 2.25 | 0.581 | 0.419 | **Over** |
| G4 | Mild over    | 1.85 | 1.95 | 0.513 | 0.487 | **Over** |

### The slips

| Slip | Legs (one market / game) | Combined odds | Hit prob | EV / ₦1 |
|------|--------------------------|---------------|----------|---------|
| **ANCHOR_S0** (predicted) | G1 O · G2 U · G3 O · G4 O | 1.80·1.55·1.62·1.85 = **8.36×** | 0.526·0.608·0.581·0.513 = **9.5%** | 0.797 |
| **ANCHOR_S1** (hedge)     | G1 U · G2 O · G3 U · G4 U | 2.00·2.40·2.25·1.95 = **21.06×** | **3.8%** | 0.799 |
| **STACK all-over**        | G1 O · G2 O · G3 O · G4 O | **12.95×** | **6.1%** | 0.796 |
| **STACK all-under**       | G1 U · G2 U · G3 U · G4 U | **13.60×** | **5.9%** | 0.800 |

Every slip's EV ≈ **0.80** (≈ −20%). That is the 4-leg vig (`0.95⁴`). No arrangement of slips
moves it — the blended EV of the set is the stake-weighted average of the leg EVs.

### Stakes and per-outcome P/L

| Outcome | Prob | Stake | Return | Net |
|---------|------|-------|--------|-----|
| ANCHOR_S0 hits | 9.5% | ₦3,500 | ₦29,260 | **+₦19,260** |
| ANCHOR_S1 hits | 3.8% | ₦2,500 | ₦52,650 | **+₦42,650** |
| STACK over hits | 6.1% | ₦2,000 | ₦25,900 | **+₦15,900** |
| STACK under hits | 5.9% | ₦2,000 | ₦27,200 | **+₦17,200** |
| **None hits** | **74.6%** | — | ₦0 | **−₦10,000** |

(The four winning vectors are mutually exclusive — a game can't be both Over and Under — so
at most one slip cashes.)

---

## 3. Coverage → profit / loss

- **Coverage:** ~**25.4%** of sessions cash at least one slip; **74.6%** lose the full ₦10,000.
- **Expected net:** `0.095·19,260 + 0.038·42,650 + 0.061·15,900 + 0.059·17,200 − 0.746·10,000`
  ≈ **−₦2,019 per session (≈ −20%)**.
- **Shape:** a ~1-in-4 lottery paying **+1.6× to +4.3×** the bankroll, against a ~3-in-4 total loss.
- **10 sessions (₦100k turned over):** central expectation **≈ −₦20,000**, high variance —
  catching one ANCHOR_S1-type hit early can swing a stretch positive, but the mean is −20%/session.

### The coverage lever (and why it doesn't fix EV)

To raise coverage above 25%, widen the legs. An all-**Over 0.5** anchor (`~0.88` per leg) hits
`0.88⁴ ≈ 60%` of sessions — but its odds collapse to `1.06⁴ ≈ 1.26×`, so a ₦1 stake wins
₦0.26. EV = `0.60 × 1.26 ≈ 0.76` — still ≈ −24%. Broad = frequent tiny wins; narrow = rare big
wins. **Every point on that curve sits at ≈ −vig.** Coverage is a style choice, not a profit lever.

---

## 4. The two truths to design around

1. **Keep N small.** 3–5 legs, not 8. This is the only structural EV improvement available and
   it's large (−19% vs −34%). v4 should default to short pools and warn as N grows.
2. **Odds-derived prediction = market view.** With prediction taken from the odds, predicted
   probability ≡ de-vigged price, so EV is pinned at −margin. To pursue actual profit, the
   predictor must consume a signal **independent of and sharper than** the bookmaker's odds.

---

## 5. Parameters & operating notes

- `poolSize` N (≥2, recommend 3–5), `stackCount` K (recommend 2–4), `bankroll`.
- Stake weighting: anchors heavier (variance floor), stacks lighter (upside). ₦100 min/slip.
- Re-predict every session from live odds. Track ≥ 10 sessions before judging variance.
- This is structure and risk-shaping. Not prediction edge. Not guaranteed profit.

---

## 6. Implementation plan (when we build)

New pure, property-tested modules in `lib/ssm/`:

- `fingerprint.ts` — `resolveMarket(market, scoreline)`, `fingerprint(scoreline)`, generated grid.
- `cluster.ts` — `robustMarkets()`, `exploitMarkets()`, `canonicalClusters()` (total-goals bands).
- `predictor.ts` — `predictGame(fixture)` (de-vig O/U ladder → totals dist → S0/S1 clusters);
  reuses `findOddsByLabel`/`mean`/`populationVariance` from `market-detector.ts`.
- `slip-builder.ts` — `buildSlips(predictions, {stackCount})` (replaces `generator.ts`).

Wiring (full replacement of the 8-game matrix path): widen `types.ts` (variable legs,
`SlipRole` replaces `TierLabel`), relax `schemas.ts` (`.length(8)` → `.min(2).max(12)`),
count-agnostic `stake-calculator.ts` + `distributor.ts`, rewrite `/api/generate`, generalize
the screen page + components (variable pool, role/cluster display).

Invariants to property-test: fingerprint partitions (`ODD`⊕`EVEN`, `Over_x`/`Under_(x+1)`),
cluster intersection soundness, and the **hedge-coverage** invariant (every game's S0 and S1
each carried by some slip).
