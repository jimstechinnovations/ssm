# PEDLAS Engine — How It Works (start to finish)

This is the working guide to the PEDLAS odds builder as actually implemented in this repo. It covers
the full pipeline, both modes, every parameter, the history + AI + selection logic, and a worked
sample with real numbers.

> **Honest stance (non-negotiable, baked into the code & UI).** PEDLAS is a *structural coverage*
> system. It does **not** beat the bookmaker margin and does **not** create edge. The Win Boost is a
> subsidy, not edge. The AI (NVIDIA NIM) and the history model are **advisors/rankers**, never
> predictors of profit — we backtested an own model on real odds + history and it has **no edge**
> (`pedlas_v2.md §1a`). Every slip is all-or-nothing; over time the book is −vig. PEDLAS maximises
> *coverage and realistic hit-chance within a budget*, with full transparency — nothing more.

---

## 1. The big picture

```
Betway public feed        apifootball history          NVIDIA NIM
  (total-goals O/U)         (form / H2H, stored)        (ranking/explain)
        │                          │                         │
        ▼                          ▼                         │
  1 Market select  →  2 Binary axes  →  3 History enrich  →  4 Quality select  ┐
  (Under≥1.20)        (dominant/break)   (advisory lean)      (best L legs)     │
                                                                                ▼
                                          5 Build: enumerate 2^L → A/E/D filters
                                            → rank (prob | payout+NIM) → diverseFill to K
                                            → boost + winnings-payout + honest EV
                                                                                │
                                          6 Persist (Supabase) · 7 UI (decisions, edit, print)
                                                                                │
                                          8 Settle vs results (learning loop)
```

Each numbered stage maps to a file:

| Stage | File |
|---|---|
| Scrape Betway (binary O/U, lines 1.5–6.5) | [lib/betway/playwright.ts](lib/betway/playwright.ts) |
| 1 Market select (dominant side ≥1.20) | [lib/pedlas/market-select.ts](lib/pedlas/market-select.ts) |
| 2 Binary axis types | [lib/pedlas/types.ts](lib/pedlas/types.ts) |
| 3 History enrich (advisory) | [lib/pedlas/enrich.ts](lib/pedlas/enrich.ts), [lib/football-history/apifootball.ts](lib/football-history/apifootball.ts), [lib/pedlas/history-store.ts](lib/pedlas/history-store.ts), [lib/pedlas/predict.ts](lib/pedlas/predict.ts) |
| 4 Quality select (+ decision reasons) | [lib/pedlas/quality.ts](lib/pedlas/quality.ts) |
| 5 Build (enumerate → rank → scatter) | [lib/pedlas/build.ts](lib/pedlas/build.ts), [vectors.ts](lib/pedlas/vectors.ts), [constraints.ts](lib/pedlas/constraints.ts), [rank.ts](lib/pedlas/rank.ts), [separation.ts](lib/pedlas/separation.ts), [boost.ts](lib/pedlas/boost.ts), [budget.ts](lib/pedlas/budget.ts) |
| AI ranker | [lib/llm/nim.ts](lib/llm/nim.ts) |
| 6 Persist / history | [lib/pedlas/store.ts](lib/pedlas/store.ts), `supabase/migrations/003_pedlas_books.sql` |
| 7 UI / API | [app/pedlas/page.tsx](app/pedlas/page.tsx), [app/api/pedlas/route.ts](app/api/pedlas/route.ts) |
| 8 Settle / learning loop | [lib/pedlas/settle.ts](lib/pedlas/settle.ts) |
| History ETL (rate-limit-proof) | [app/api/pedlas/history/sync/route.ts](app/api/pedlas/history/sync/route.ts), `supabase/migrations/004_match_history.sql` |

---

## 2. Markets & the binary axis

PEDLAS only uses **total-goals Over/Under** markets (lines **1.5, 2.5, 3.5, 4.5, 5.5, 6.5**) where the
**dominant side's odds ≥ 1.20** (so every leg qualifies for Betway Win Boost).

For each fixture, [market-select](lib/pedlas/market-select.ts) scans the lines and picks the **most
reliable dominant side that still clears 1.20**:
- High-scoring fixtures → **Over 1.5** is dominant (~78%, odds ~1.25).
- Low-scoring fixtures → **Under 4.5** is dominant (~75%, odds ~1.28).

That becomes a **binary axis**: `state 0 = dominant` (likely, low odds), `state 1 = breakout` (unlikely,
high odds). Both sides are de-vigged to true probabilities + the two-way margin. A slip is a binary
string over the L axes; there are `2^L` possible outcomes.

---

## 3. Parameters

| Param | UI label | Meaning | Default |
|---|---|---|---|
| **L** | Legs (L) | number of fixtures (legs) in the pool | 7 |
| **A** | Min Over-flips | minimum **breakouts** per slip (distance from the all-dominant anchor) | 3 moonshot / 1 coverage |
| **D** | Max legs / league | max legs from one competition (decorrelation) | 3 |
| **E** | — | max run of identical picks (structural plausibility) | off (99) |
| **budget** | Budget (₦) | total stake; **K = floor(budget / ₦100)** slips | 1000 → K=10 |
| **pinTopFrac** | — | fraction of most-confident legs to *pin* at the anchor (opt-in scatter knob) | 0 |
| **maxPayout** | — | Betway max-win cap | ₦50,000,000 |
| **objective** | Coverage / Moonshot | which book to build | — |
| **rank** | — | `auto` (NIM if key set) / `nim` / `deterministic` | auto |
| **kickoff gap** | Kickoff gap (min) | only fixtures kicking off ≥ now + gap | 60 |

Note: there is **no rigid "S" (slip separation)** parameter anymore. Per the PEDLAS spec, separation
means *"maximise diversity, then fill K within budget"* — implemented as `diverseFill` (§6), which
scatters **and** always uses the full budget.

---

## 4. The two modes

Both modes use the **same reliable axes and the same scatter engine**; they differ only in how
candidate slips are ranked.

| | **Coverage** | **Moonshot** |
|---|---|---|
| Goal | frequent small win | rare big win |
| Ranks by | **probability** (most-likely vectors) | **payout** (highest odds), NIM-assisted |
| Anchor distance A | 1 (≥1 breakout) | 3 (≥3 breakouts) |
| Typical hit chance (₦1k) | ~10–15% | ~0.9% |
| Typical payout when it hits | ₦3–6k | ₦40k–₦300k+ |
| Floor | every hit ≥ total stake | every hit ≫ total stake |
| EV | −vig | −vig (identical) |

**Both are −vig.** Coverage trades the jackpot for a realistic chance; Moonshot trades the chance for
a jackpot. Neither beats the book.

---

## 5. History + AI + logic (what each layer does, and its honest limit)

**History (advisory).** [enrich.ts](lib/pedlas/enrich.ts) pulls each team's recent form — **store-first**
from Supabase `match_history` (populated by the daily ETL, zero live calls), falling back to live
apifootball H2H/last-N. From recency-weighted goals it estimates expected goals `λ_home, λ_away`, then
[predict.ts](lib/pedlas/predict.ts) `pHatOver` gives a Poisson `p̂(Over/Under)`. Compared to the book's
de-vigged price → an **edge ratio** and a **lean**: `back` / `fade` / `neutral`.
*Honest limit:* backtested on 695 matches and on real odds — **no edge on any market** (negative skill);
so the lean **never changes odds, probability, or EV**. It only informs ranking + the UI, and nudges
selection confidence.

**AI — NVIDIA NIM** ([nim.ts](lib/llm/nim.ts), [rank.ts](lib/pedlas/rank.ts)). In **Moonshot** mode NIM
ranks the high-payout candidate slips by hidden risk, fed **only** PEDLAS-computed features + the
history leans (it never invents stats or does arithmetic; odds/EV are computed deterministically). If
no `NVIDIA_API_KEY`, it falls back to deterministic payout ranking. Coverage is pure probability math
(deterministic, reproducible).

**Logic — quality selection** ([quality.ts](lib/pedlas/quality.ts)). Each fixture is scored:

```
quality = book P(dominant)  − 0.6·margin  − 0.10·volatility
        + 0.06 if recent form AGREES (edge ≥ 1.05)
        − 0.10 if recent form DISAGREES (edge ≤ 0.95)
confidence = round(quality · 100)        # shown 0–100 in the UI
```

The best **L** fixtures (capped at **D** per league) form the pool; each carries a **decision**
(`pick`, `confidence`, human `reasons`) — this is the UI "Decision summary." It is the **most-likely
side that drove selection**; Coverage mostly bets it, Moonshot flips some for payout (the slip's
**Pick** column is the truth of what's staked).

---

## 6. Build: enumerate → filter → rank → scatter → stake

In [build.ts](lib/pedlas/build.ts):

1. **D**: cap the pool per league; order by kickoff.
2. **Enumerate** all `2^L` binary vectors ([vectors.ts](lib/pedlas/vectors.ts)).
3. **A** (min breakouts) and **E** (max identical run) filter the candidates ([constraints.ts](lib/pedlas/constraints.ts)).
4. *(optional)* **pin** the most-confident legs at the anchor (`pinTopFrac`).
5. **Rank**: Coverage → by true probability; Moonshot → by payout (NIM-assisted).
6. **`diverseFill(ranked, K)`** ([separation.ts](lib/pedlas/separation.ts)) — the genuine scatter:
   walk the ranked list, **prefer variants ≥2 legs apart** (distinct scenarios), then **backfill** to
   `K` so the **full budget is always used**. This is the spec's *"maximise diversity, then select K
   within budget."*
7. **Stake & payout** ([budget.ts](lib/pedlas/budget.ts), [boost.ts](lib/pedlas/boost.ts)): each slip is
   ₦100; combined odds `O = ∏ legOdds`; Win Boost `b` from the real Betway schedule (leg-count based,
   3 legs +3% … 50 legs +1000%); **winnings-boosted payout**:

   ```
   payout = stake · [ 1 + (O − 1)·(1 + b) ]     capped at maxPayout (₦50M)
   ```
8. **Honest verdict**: `EV/₦1 ≈ (1+b)/∏(1+mᵢ) < 1` (always −vig); `+EV = false`; `P(any hit) = Σ trueProb`
   over the placed slips; `compression = 2^L / K`.

---

## 7. Worked sample (real build)

**Input:** Moonshot · budget ₦1,000 · L=7 · A=3 · D=3 · kickoff gap 30 · 26 Jun slate.

**Pipeline:**
- Scraped 10 qualifying total-goals fixtures; selected the best **7** by quality (≤3 per league).
- Decision summary (most-likely side, best-confidence first):

  | Fixture | Most likely | conf | why |
  |---|---|---:|---|
  | South Africa vs Canada | Under 3.5 @1.27 | 72 | book 74%; **form agrees** (λ 0.8–1.5 → 81%) |
  | Ferencvaros vs Sabah | Under 4.5 @1.20 | 65 | book 76%; lopsided; no form |
  | Sandvikens vs Helsingborgs | Under 4.5 @1.20 | 65 | book 76%; lopsided |
  | Odra Opole vs CSKA Sofia | Under 4.5 @1.20 | 65 | book 76%; lopsided |
  | Dynamo Kyiv vs Wieczysta | Under 4.5 @1.26 | 61 | book 72% |
  | Germany U19 vs Denmark U19 | Under 4.5 @1.28 | 59 | book 71%; form neutral |
  | Wales U19 vs Spain U19 | Over 2.5 @1.29 | 49 | book 71%; **form disagrees** (model 64%) → penalised, last |

- Enumerate 2⁷ = 128 outcomes → keep ≥3-breakout candidates → NIM-rank by payout → `diverseFill` to
  **K = 10**.

**Output (book):**
- **10 / 10 slips placed**, total stake **₦1,000** (budget fully used).
- 10 distinct scattered variants (flip counts 7,5,5,4,4,4,5,5,5,5; min Hamming 2).
- **Compression 13×** (128 outcomes → 10 slips).
- **P(any hit) 0.88%**; top slip 7-Over @ odds 2,686 → **₦300,907**; worst hit **₦38,613** (≥ ₦1,000 floor).
- **Book EV/₦1 = 0.605 (−39.5%)**, +EV false, avg margin 9.2%.

**Read:** the engine did its job — full budget, genuine scatter, confident clean picks, honest EV. The
−39.5% is driven by the **slate** (lopsided friendlies priced at the 1.20 floor = high vig), not the
logic. Switching to **Coverage** on the same slate gives ~10–15% hit chance for ₦3–6k payouts.

---

## 8. Persistence, editing, learning loop

- **Auto-save** every build to Supabase `pedlas_books`; the page **restores the latest on refresh** and
  lists **History** ([store.ts](lib/pedlas/store.ts)).
- **Edit before placing** ([edit.ts](lib/pedlas/edit.ts)): flip a leg ⇄, remove a leg, remove/duplicate a
  slip — odds/boost/payout/floor recompute live; **Save edits**; **Print** a clean sheet at
  `/pedlas/print/[id]`.
- **History ETL** ([sync route](app/api/pedlas/history/sync/route.ts)): `POST /api/pedlas/history/sync`
  pulls finished matches per league into `match_history` (run daily) so form is served locally with no
  rate-limit risk.
- **Learning loop** ([settle.ts](lib/pedlas/settle.ts)): grade a saved book against actual scores →
  which slips hit, the killer legs, and per-(league, side) hit-rates — the empirical record that, over
  time, is the only honest path toward a real edge signal (sharp-book reference).

---

## 9. Running it

```
POST /api/pedlas
{ "date_from":"YYYY-MM-DD", "date_to":"YYYY-MM-DD", "budget":1000, "legCount":7,
  "objective":"coverage" | "moonshot",
  "params": { "minAnchorDistance":1, "maxPerLeague":3, "pinTopFrac":0 } }
→ { book, meta, bookId, saved }
```

UI at `/pedlas` (and `/builder/pedlas`): pick mode, set budget/L/A/D, **Build slips**, review the
**Decision summary** and slips, edit, save, print. **Refresh odds** / auto-refresh re-pull the Betway
feed. Required env: `APIFOOTBALL_KEY` (history), `NVIDIA_API_KEY` (NIM ranking — optional), Supabase keys.

---

## 10. The one-line truth

PEDLAS is the best *honest* structured-coverage builder it can be: it scrapes real Betway binary
markets, anchors on confident clean-priced sides, corroborates with team history, scatters distinct
variants across the full budget for maximum realistic hit-chance, and explains every pick — while
never pretending to beat the bookmaker, because the data proves nothing can.
