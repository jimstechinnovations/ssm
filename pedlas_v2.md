# PEDLAS v2 — Match-History / Edge Layer (the only path to +EV)

> **Goal.** Add the "Football History" component from `PEDLAS.txt`: estimate each fixture's
> expected goals from team history, turn that into an independent probability `p̂(Under/Over)`, and
> compare it to Betway's de-vigged price. A calibrated `p̂ > p_book` is the **only** thing that can
> move PEDLAS above −vig (everything else — structure, Coverage, Win Boost — is variance-shaping).
>
> **Data source (decided):** apifootball.com (`https://apiv3.apifootball.com`). Key in `.env`
> (`APIFOOTBALL_KEY`). Confirmed working for in-season leagues (CSL, Eliteserien, …).

## 1. The blunt finding that frames everything

Run the *naive* standings-Poisson model below on the real 2026-06-27 CSL slate:

| fixture | model λ_total | p̂(Over 4.5) | model says | actual | verdict |
|---|---:|---:|---|---|---|
| Liaoning v Shandong | 2.85 | 16.1% | fade Over | 6 (Over hit) | model **wrong** |
| Shenzhen v Chengdu | 3.43 | 26.1% | fade Over | 5 (Over hit) | model **wrong** |
| Beijing v Wuhan | 5.10 | **57.6% → "EDGE"** | back Over hard | 1 (Over lost) | model **backed the killer** |

3/3 wrong directionally; it manufactured a fake +EV on the leg that sank the slip.

## 1a. MEASURED backtest verdict — the model does NOT work at the lines PEDLAS uses

I then built a *proper* recency-weighted form model ([predict.ts](lib/pedlas/predict.ts)) and backtested
it walk-forward on **215 real finished matches** (apifootball: CSL 126 + Norway Eliteserien 89).
`skill = 1 − Brier(model)/Brier(base-rate)`; positive = adds information:

| line | CSL skill | Norway skill | reads as |
|---|---:|---:|---|
| Over 2.5 | **−13.2%** | −0.6% | no better than the base rate |
| **Over 4.5** | **−12.9%** | **−12.4%** | **worse than base rate** |
| Over 5.5 | +1.2% | −30.9% | noise (rare events) |

And it is **anti-calibrated exactly where it's confident**: CSL "predicted 50–70% Over 4.5" → **observed
0%** (n=4); Norway "predicted 30–40%" → **observed 0%** (n=10). The model's strong Over calls
systematically *lose*.

**Verdict: no goals-history model (naive or recency-weighted) predicts Over 4.5+ — it backtests
*negative* on real data.** Over 4.5 is a rare variance-dominated tail; team form predicts the *mean*
(~3 goals), not the ≥5 tail. The bookmaker's de-vigged price is already a better estimate than any such
model. **So we must NOT wire `p̂` into PEDLAS as an edge signal — it would lose money faster** (as it did
3/3 on the real slate). `predict.ts` stays as measurement/research tooling, clearly NOT an edge input.

**Definitive follow-up (with REAL historical odds).** Built a learnable logistic model
([model.ts](lib/pedlas/model.ts), gradient-trained) on real apifootball O/U odds + history, walk-forward
([edge.live.test.ts](__tests__/lib/pedlas/edge.live.test.ts)). Out-of-sample vs the book's de-vigged price:
model(book+history) only **matched** the book (+1.1% / +0.1% / +1.1% / −2.1% on O1.5/2.5/3.5/4.5 —
noise-level, far below the ~6% margin needed to profit); model(history-only) was **worse** than the book
on every market; learned history weights were tiny. So even a tuned model with real odds can't beat an
efficient market — history is already in the price. "Which leg to anchor on" is optimally given by the
book's de-vigged dominant probability (what the reliable-dominant-per-line Coverage already uses).

The deterministic synthetic test ([predict.test.ts](__tests__/lib/pedlas/predict.test.ts)) confirms the
code is correct (it shows positive skill when signal genuinely exists) — the negative real-data result
is about football, not a bug. The only honest edge source remaining is a **sharp-book reference**
(Pinnacle/Betfair de-vig — a data feed, not a model; `spm_v2.md §3`), or accepting PEDLAS as a −vig
structure played for Coverage's floor.

## 2. Data — apifootball.com (probed, real fields)

| action | gives | use | call cost |
|---|---|---|---|
| `get_leagues` | all leagues + `league_id` | map Betway league name → id | 1, cache forever-ish |
| `get_standings&league_id=` | per-team **home/away** `*_GF/_GA/_payed`, position | λ estimation | 1 per league, cache daily |
| `get_H2H&firstTeam=&secondTeam=` | last-10 H2H + each team's last-10 results | recent-form refinement | 1 per fixture (names) |
| `get_events&from=&to=&league_id=` | finished matches w/ scores | backtest / calibration | range, cache |

Confirmed: CSL=118, Norway Eliteserien=253, EPL=152. `get_events` on an out-of-season league returns
`"check your plan"` — that's off-season, not a hard block; in-season leagues return full data.

## 3. λ model (standings-based, then optional form refine)

```
lgH = Σ home_GF / Σ home_played      lgA = Σ away_GF / Σ away_played     (league home/away scoring)
λ_home = lgH · (homeTeam home_GF/game ÷ lgH) · (awayTeam away_GA/game ÷ lgH)
λ_away = lgA · (awayTeam away_GF/game ÷ lgA) · (homeTeam home_GA/game ÷ lgA)
```

Then **reuse the already-built [scoreline-model.ts](lib/ssm/scoreline-model.ts)**:
`poissonDist(λ_home, λ_away)` → `pMarket(dist, 'OVER_4_5')` = `p̂(Over 4.5)`. (Independent Poisson is
crude; Dixon-Coles / form / H2H weighting are refinements — but calibration matters more than the
model sophistication.)

## 4. Edge + how it plugs into PEDLAS

Per axis: `e = p̂ / p_book` (p_book already de-vigged in [market-select.ts](lib/pedlas/market-select.ts)).
- **Ranking signal (gated):** prefer Over flips where `e > 1`; fade where `e < 1`.
- **Honest +EV verdict:** reuse [`slipEVWithEdge`](lib/spm/leg-stacker.ts) — slip is +EV iff
  `Π eᵢ × (1+boost) > Π(1+mᵢ)`. **Only shown once calibration passes.**

## 5. The name-mapping challenge (the real integration cost)

apifootball names ≠ Betway names: "Shenzhen **Xinpengcheng**" vs Betway "Shenzhen **Peng City**";
"Wuhan Three Towns" vs "Wuhan Three Towns **FC**". Approach: Betway league name → `league_id`, then
**fuzzy-match** the two team names against that league's standings team list (token overlap /
Levenshtein, threshold). Unmatched fixture → **no p̂** (leg keeps book prob; no edge claimed) rather
than a wrong match.

## 6. Honest EV + the calibration gate (non-negotiable)

- Until `p̂` is validated, it is an **advisory "model lean" only** — it never flips `verdict.positiveEV`
  and never auto-removes a leg.
- **Calibration harness:** feed settled results from [settle.ts](lib/pedlas/settle.ts) →
  reliability/Brier of `p̂` vs actual over **≥ N matches** (decision: N). Enable `+EV` display only
  when `p̂` is calibrated (predicted ≈ observed) out-of-sample. §1 is the standing reminder of why.
- The boost/Coverage remain −vig; v2 changes the sign **only** with a real, calibrated edge.

## 7. Build plan

```
lib/football-history/apifootball.ts  get_leagues/standings/H2H client (cached; APIFOOTBALL_KEY)
lib/pedlas/lambda.ts                 standings + name-match → λ_home, λ_away per fixture
lib/pedlas/predict.ts                λ → p̂ (scoreline-model) → edge e = p̂/p_book per axis
  → attach {pHat, edge} to BinaryAxis; gated ranking; slipEVWithEdge verdict (display-gated)
calibration/                          backtest p̂ vs get_events results (Brier) before enabling +EV
env: APIFOOTBALL_KEY, APIFOOTBALL_URL
```

## 8. Open decisions

1. **Calibration threshold N** before `p̂` may influence picks / show +EV (e.g. 200 graded legs).
2. **Free-plan call budget** — cache standings per league/day; H2H optional (per-fixture cost).
3. **Model tier** — ship standings-Poisson first (gated, advisory), add form/H2H/Dixon-Coles later.

**Definition of done:** per fixture, PEDLAS shows an *advisory* model lean (`p̂` vs book) sourced from
apifootball history; it influences ranking and the +EV verdict **only after** out-of-sample
calibration passes. Until then it informs, never decides — because §1.
