# PEDLAS v1 — Total-Goals Odds Builder (small stake → big hit)

> **Goal (set by you).** Use the PEDLAS framework as an **odds builder**: from a small stake
> (e.g. ₦1,000 = 10 × ₦100), produce a *diversified set of high-payout slips* over total-goals
> Under/Over markets, so that one realistic scoreline pattern can pay big — while being **honest**
> that this is a structured −vig lottery, not a +EV machine.
>
> **Decisions locked (this session):**
> 1. **Shape** — PEDLAS as an odds builder optimised for *payout-per-naira*, not for coverage win-rate.
> 2. **Markets** — total-goals **Over/Under (4.5 / 5.5 / 6.5), Under ≥ 1.20** (Win-Boost qualifying) only.
> 3. **LLM** — NVIDIA NIM `meta/llama-3.3-70b-instruct` as the **central reasoning/ranking engine**
>    (caveats in §7), fed only by PEDLAS-computed features. Arithmetic stays deterministic.

This supersedes nothing; it adds a `pedlas` engine beside the existing SSM/SPM modes
(see `plan_to_spm_final.md`). It reuses the built primitives (`coverage-optimizer`, `fingerprint`,
`scoreline-model`, `market-overlap`) and adds the missing E/D/A/S diversity layer + the NIM layer.

---

## 1. Why this is mostly already built

The repo already implements PEDLAS's rigorous core (binary outcome space, 2^L enumeration,
probability ranking, Dutch coverage, EV-invariance). PEDLAS v1 adds only the parts the papers
have that the code doesn't yet:

| Need | Status | Action |
|---|---|---|
| Binary U/O space, 2^L, per-game prob | ✅ `coverage-optimizer`, `scoreline-model` | reuse |
| Total-goals **Under ≥ 1.20** selection policy | ❌ policy not enforced (data path exists) | **build** `market-select` |
| **A** anchor distance / **S** slip separation | ❌ | **build** (the "hit big" levers) |
| **E** max identical run / **D** max legs per league | ❌ | **build** (plausibility + decorrelation) |
| Win-Boost payout model | ❌ not modelled anywhere | **build** `boost.ts` (schedule TBD, §8) |
| NIM central ranker | ❌ no LLM client | **build** `lib/llm/nim.ts` |
| Compression-ratio (CR = 2^L / N) reporting | ❌ | **build** (audit metric) |
| Learning loop / knowledge base | ❌ | later (PEDLAS "Future Work") |

---

## 2. Market model — where the "big" comes from

Each game is one **binary axis** on total goals at a chosen line (4.5/5.5/6.5):

```
state 0 = Under (dominant, odds ~1.20–1.45)   ← cheap, likely
state 1 = Over  (breakout, odds ~3–5)         ← dear, unlikely, BIG
```

A slip is a binary string of length **L**. Its combined odds:

```
O(v) = ∏ ( vᵢ = 0 ? oUnder,ᵢ : oOver,ᵢ )
```

- The **all-Under anchor** (`000…0`) has the *lowest* odds and *highest* probability — small payout.
- Every **Over flip** multiplies odds by ~3–5× and divides probability by ~3×.
- So **payout scales exponentially with the number of Over flips (`f`)**. "Hit big" = buy slips
  with several Over flips — but spread across *different* games so they're not redundant.

This is why **A** (min distance from the anchor) and **S** (min pairwise distance between slips)
are the primary dials here, not `costTarget`. We are explicitly *not* buying the high-probability
low-payout region.

---

## 3. PEDLAS parameters, tuned for "hit big"

| Param | Meaning | Role here | Default |
|---|---|---|---|
| **L** | leg count | bigger L → bigger odds & boost tier, lower hit prob | 10–14 |
| **P** | prob bias | per-game `p(Under)` from de-vigged odds (not a scalar) | from odds |
| **A** | anchor distance | **min Over-flips per slip** — forces payout up | ≥ 2 |
| **S** | slip separation | **min Hamming distance between any two slips** — no near-dupes | ≥ 3 |
| **E** | elimination | max run of identical picks after ordering — kills implausible "all-Over" strings | ≤ 4 |
| **D** | diversity | max legs from one competition per slip — decorrelates | ≤ 3 |
| **K** | budget slips | `K = floor(budget / minStake)` | 10 |

Pipeline (deterministic core → NIM → budget):

```
total-goals pool (Under ≥ 1.20)
        │  market-select
        ▼
build axes (Under/Over per game)  ──► per-game p, odds
        │  enumerate / sample 2^L vectors
        ▼
apply E, D, A  (structural plausibility + min payout)
        │
        ▼
candidate vectors  +  features per vector
        │  ► NIM central ranker (score 0–100, hidden-risk, reasoning)
        ▼
apply S (greedy: keep highest-ranked, drop anything within S of a kept slip)
        │
        ▼
K = floor(budget/minStake) top slips
        │  deterministic: odds, Win-Boost, stake, payout, EV
        ▼
GeneratedBook  (same shape as other modes)
```

NIM only **ranks/selects**; it never computes odds, probabilities, or payouts, and never invents
stats (§7).

---

## 4. Worked example (illustrative — replace with live odds + real boost)

**Inputs:** budget ₦1,000 → K = 10 slips @ ₦100. L = 11 games, line Under 4.5.
Per game: **Under 4.5 @ 1.28**, **Over 4.5 @ 3.55** (two-way overround 1.063 → **margin m ≈ 6.3%**).
De-vigged true probs: **p(Under) = 0.735, p(Over) = 0.265**.

Odds & true probability by number of Over flips `f` (one specific vector):

| `f` | combined odds | ₦100 payout (no boost) | true prob (this exact vector) | # vectors C(11,f) |
|---:|---:|---:|---:|---:|
| 0 (anchor) | 15.1× | ₦1,511 | 3.38% | 1 |
| 1 | 41.9× | ₦4,190 | 1.22% | 11 |
| 3 | 322× | ₦32,230 | 0.158% | 165 |
| 5 | 2,479× | ₦247,900 | 0.021% | 462 |

A small **A = 3** floor (≥3 Over flips) means every slip we place sits in the ₦30k+ payout band;
**S ≥ 4** ensures the 10 slips cover 10 *genuinely different* high-odds outcome regions instead of
near-duplicates. With an (illustrative) Win Boost of ×2 at 11 legs, an `f = 5` slip pays ~**₦495,800
from ₦100**. That is the "hit big."

---

## 5. Honest EV — with the REAL Betway Win Boost (the part that cannot be sugar-coated)

Betway Nigeria's Win Boost (confirmed, encoded in `lib/spm/leg-stacker.ts` `boostFor`):
**boosts winnings** (profit), only legs with **odds ≥ 1.20** count toward the leg tier, scaling
3 legs → +3% up to **50 legs → +1000%**. Accurate payout:

```
payout = stake · [ 1 + (O − 1)·(1 + b) ]        b = boostPct/100   (winnings-boost)
       ≈ stake · O · (1 + b)   when O ≫ 1
```

EV multiple (no edge) ≈ **`(1 + b(L)) / (1 + m)^L`**. With de-vig, each leg gives `pᵢ·oᵢ = 1/(1+mᵢ)`,
so absent the boost **every vector — anchor or moonshot — has the same EV**; the boost only nudges
higher-odds slips up by a hair (the `b/O` term). Plugging the **real** schedule at margin m = 6.3%:

| L | real boost b(L) | (1+m)^L | EV multiple ≈ (1+b)/(1+m)^L | verdict |
|---:|---:|---:|---:|---|
| 3 | +3% | 1.20 | **0.858** (−14%) | least-bad, tiny payout |
| 11 | +20% | 1.96 | **0.613** (−39%) | our example |
| 14 | +30% | 2.35 | **0.552** (−45%) | |
| 30 | +160% | 6.27 | **0.415** (−59%) | |
| **50** | **+1000%** | 21.3 | **0.516** (−48%) | even at MAX boost |

**The decisive honest facts, now backed by real data:**
- **The book tuned the boost to never beat the margin.** Even the headline **+1000% at 50 legs is
  ≈ −48% EV** at 6.3% margin. Break-even at L = 11 would need ~**+96%** boost; Betway gives **+20%**.
- **More legs / more Over-flips = bigger payout but WORSE EV.** The "hit big" region is the worst-EV
  region. Diversification (A/S/E/D) changes the *payout shape and which outcomes you cover* — never EV.
- **+EV requires a calibrated `p̂ > p_book`** (the sharp-book lever, `spm_v2.md`). PEDLAS structure and
  the NIM ranker **do not create edge.**

Consistent with PEDLAS's own papers ("does not… eliminate bookmaker margin, or guarantee
profitability") and `coverage-optimizer.ts`'s EV-invariance note. Honest pitch the UI must show:
*a small stake buys a diversified, boost-subsidised shot at a large payout — not an edge.*

---

## 5b. Coverage mode — the floor (added after the 2026-06-26 near-miss)

The original build is **Moonshot**: rank by payout, push slips apart with Slip Separation (S), flat
₦100 — rare huge win, ~1% hit. Real play (slip #4, betslip 556632591) went **6/7**: it lost only on
`Cambrian Over 4.5` (1-0). Reality was the *single-flip neighbor* of the placed slip — which S had
deliberately excluded. That motivates the opposite end of the dial.

**Coverage mode** targets *"one hit covers the total stake"*:

- Rank candidate vectors by **probability** (most-likely first), not payout.
- **Keep neighbors** (skip S / S=1) so a near-miss is caught by an adjacent slip.
- **A ≥ 1** (default for coverage) excludes only the all-Under anchor, so every placed slip's boosted
  payout clears the total stake — the floor guarantee.
- Flat ₦100 (Nigerian min); place the top **K** by probability.

**Worked maths (L=7, p(Under)≈0.74, oU≈1.30, oO≈3.50, boost(7)=+12%, K=10, total stake ₦1,000):**

| band | P(reality lands here) | covered? | hit payout (₦100) |
|---|---:|---|---:|
| all-Under (0 Over) | 0.74⁷ = **12.1%** | excluded by A≥1 (pays ₦694 < ₦1,000) | — |
| exactly 1 Over (7 vectors) | 7·0.74⁶·0.26 = **29.9%** | ✅ all 7 covered | ~₦1,900 (+90%) |
| exactly 2 Over (covered subset) | part of 31% | ✅ top few | ~₦5,000 |

So coverage converts "≈1% chance of a moonshot" into **≈30%+ chance of a profitable hit** that always
clears the ₦1,000 total stake. **EV is unchanged (still −vig ≈ 0.63)** — the `coverage-optimizer`
invariant holds; this only reshapes variance from "rare big" to "often small". Blind spot: a
high-scoring night (≥3 Overs, like 26 Jun) falls outside the covered band and loses — there is no
setting that catches every slate at fixed −vig. Moonshot vs Coverage is the user's variance choice.

NIM ranking applies to **Moonshot only** (ranking high-payout candidates by hidden risk). Coverage is
pure probability math — deterministic and reproducible.

---

## 6. Architecture (new `lib/pedlas/`, reuses primitives)

```
lib/pedlas/
  types.ts          BinaryAxis, PedlasParams, PedlasSlip, PedlasBook
  market-select.ts  filter pool → total-goals Under ≥ 1.20; build BinaryAxis[] (Under/Over)
  vectors.ts        enumerate (L ≤ ~18) or sample 2^L; per-vector odds + true prob + features
  constraints.ts    applyE, applyD, applyA  (structural filters)
  separation.ts     applyS  (greedy min-Hamming pruning over ranked vectors)
  boost.ts          winBoostFactor(L)  ← schedule TBD (§8); pure
  rank.ts           orchestrates NIM ranking; deterministic fallback = rank by odds (payout)
  budget.ts         K = floor(budget/minStake); deterministic stake/payout/EV
  build.ts          buildPedlasBook(cfg) → PedlasBook (the one entry point)

lib/llm/
  nim.ts            NVIDIA NIM client (OpenAI-compatible /chat/completions), temp 0, cached

env additions:      NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_BASE_URL
type widening:      MarketType += 'OVER_UNDER_4.5' | '_5.5' | '_6.5'  (data path already maps them)
tests:              __tests__/lib/pedlas/* (constraints, separation, boost, EV identity)
```

`buildPedlasBook` returns the shared `GeneratedBook` contract so the existing API/UI/persistence
stay mode-agnostic. NIM lives behind one client; if `NVIDIA_API_KEY` is unset, `rank.ts` falls back
to deterministic odds-ranking so the builder still works.

---

## 7. NIM as central engine — how we keep it sane

You chose NIM **central**. To honour that without breaking the build, it is the decision layer for
*ranking and final selection*, fed only PEDLAS numbers:

```
Input per vector (PEDLAS-computed ONLY):
  league mix, # Over flips, combined odds, true prob, EV multiple,
  per-game volatility, line height, kickoff spread
Prompt rules: do NOT predict football; do NOT invent stats; only use supplied values;
  return {score 0-100, hiddenRisk, leagueStability, reasoning}
```

Honest caveats I'm flagging once (not re-litigating the decision):
- **Reproducibility:** LLM ranking makes "same inputs → same slips" only approximate. Mitigation:
  `temperature 0`, fixed prompt, and **cache responses keyed by the feature hash**.
- **Cost/latency:** one batched call per build (rank all candidates together), not per-leg.
- **No arithmetic by LLM:** odds, stakes, payouts, EV are computed in `budget.ts`. The LLM cannot
  change a number, only the *ordering/selection*.
- **It does not create edge** (§5).

---

## 8. Open data gaps to resolve before/while building

1. ~~**Win-Boost schedule.**~~ **RESOLVED** — Betway Nigeria's real schedule (3 legs +3% … 50 legs
   +1000%, winnings-boost, legs ≥1.20 only) is confirmed and already encoded in
   `lib/spm/leg-stacker.ts` `boostFor(n)`. PEDLAS reuses it as the single source of truth.
2. **Odds source for total-goals high lines.** API-Football `bet.id 5` already maps any O/U line;
   default bookmaker is Bet365 (id 8). Betway is id 45 — confirm it carries 4.5/5.5/6.5 lines, else
   price off Bet365 and treat Betway as the *placement* venue.
3. **Min stake / budget mapping.** Confirm ₦100 min, K = floor(budget/100).

---

## 9. Build order (proposed)

1. `types.ts` + `market-select.ts` + `MarketType` widening + tests.
2. `vectors.ts` (odds/prob/features) + `constraints.ts` (E/D/A) + `separation.ts` (S) + tests
   (incl. the **EV-identity test**: EV multiple equal across all vectors).
3. `boost.ts` (placeholder schedule) + `budget.ts` (K, stake, payout, EV) + tests.
4. `lib/llm/nim.ts` + `rank.ts` (with deterministic fallback) + a cached integration test.
5. `build.ts` → `GeneratedBook`; wire one API route + a minimal results view with the §5 disclosure.

**Definition of done:** from a date range, the app pulls total-goals Under≥1.20 fixtures, builds K
diversified high-payout slips (A/S/E/D enforced), NIM-ranked, with deterministic odds/boost/payout
and the **honest EV verdict** rendered — defaulting to "structured −vig lottery; +EV only with a
calibrated edge."
```
