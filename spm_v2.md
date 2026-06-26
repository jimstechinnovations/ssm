# STRUCTURED PREDICTIVE MODEL
Version 2.0 — Prediction Layer (the optional +EV lever)

> Sits on top of `spm_v1.md`. SPM v1 is a **structured lottery** — clean leg selection, subsidy
> capture, all-or-nothing — that sits at −vig unless the legs clear the margin gate (≈4.9% at 50
> legs). v2 adds the **only** thing that can make it genuinely +EV: a per-leg probability estimate
> `p̂` that beats the book's de-vigged price. It is a **bonus, not a requirement** — the shot is
> structured and worth taking either way; prediction just flips the sign when you have it.

## 1. The edge identity

For a leg with book odds `o`, de-vigged book prob `p_book`, two-way margin `m` (so `p_book·o = 1/(1+m)`),
and your own estimate `p̂`, define the **edge ratio**:

```
e = p̂ / p_book                 (e > 1 ⇒ you think it's likelier than the book's price implies)
per-leg EV multiple = p̂·o = e / (1+m)
slip EV multiple    = Π(p̂ᵢ·oᵢ) × (1+boost) = ( Π eᵢ / Π(1+mᵢ) ) × (1+boost)
```

You do **not** need every leg to have edge — you need the **product** `Π eᵢ × (1+boost) > Π(1+mᵢ)`.
A few strongly-underpriced legs can carry legs that have none.

## 2. The key result — the boost makes the required edge tiny

Break-even per-leg edge (uniform case): `e* = (1+m) / (1+boost)^(1/N)`. At N = 50, `1000%` boost,
`(1+boost)^(1/50) = 11^(1/50) = 1.0491`:

| book margin/leg | required edge e* | as % over book | verdict |
|---|---|---|---|
| 3% | 0.981 | −1.9% | **+EV with no edge** (already below the margin gate) |
| 4% | 0.991 | −0.9% | **+EV with no edge** |
| 5% | 1.001 | +0.1% | ~nil |
| 6% | 1.010 | **+1.0%** | needs ~1% edge/leg |
| 7% | 1.020 | +2.0% | ~2% |
| 8% | 1.029 | +2.9% | ~3% |
| 10% | 1.049 | +4.9% | ~5% |

So at typical Betway margins (6–9%) you need only a **~1–3% relative edge per leg** to tip the whole
50-leg slip +EV — because the 1000% boost carries the rest. That is a *small* bar (the reason the
boost exists is that small edges shouldn't be enough — but combined with low-margin market selection
from `spm_v1 §5`, it's reachable).

**Measured** (`prediction.test.ts`, 50 legs @ 6% margin, need `e* = 1.010`):

```
per-leg edge e   slip EV multiple
  1.00              0.597   ❌ −EV   (no edge → structured lottery at −40%)
  1.01              0.982   ❌ −EV   (just under the gate)
  1.02              1.607   ✅ +EV   (+61%)
  1.03              2.618   ✅ +EV
```

A ~2% per-leg edge swings the whole 50-fold from −40% to +61%. That is the entire payoff of the
prediction layer — and the entire risk: the edge must be *real and calibrated*, not assumed.

## 3. Where `p̂` comes from — honestly

- **Sharp-book reference (recommended).** Pinnacle / Betfair Exchange de-vigged probability ≈ the
  efficient market estimate. Bet at Betway on legs where **Betway's de-vigged price is lower than the
  sharp's** (`e > 1`). You don't bet at the sharp because **only Betway has the 1000% boost** — that
  is the entire play: *sharp pricing + soft-book boost*. This is the most defensible edge source.
- **Own statistical model** (xG, Poisson team-strength, Elo, form). Viable only if **calibrated and
  validated out-of-sample** — an overconfident `p̂` fabricates an edge that isn't there.
- **Market-specific softness** — lower leagues where Betway prices weakly are where `e > 1` is most
  findable (also where margins are highest, so the edge must be larger).

## 4. Selection & validation

1. For every ≥1.20 candidate, compute `eᵢ = p̂ᵢ / p_book,ᵢ`.
2. Rank by `eᵢ` (most underpriced first); take the 50 highest, **one per match** (`spm_v1` rule).
3. **Validate the slip:** `Π eᵢ × (1+boost) > Π(1+mᵢ)` → +EV. Report the **margin of safety**
   (how far above 1.0 the EV multiple sits) — don't bet a slip that only clears on optimistic `p̂`.

## 5. Honest caveats (the traps that turn "+EV" into self-deception)

- **Calibration is everything.** If `p̂` says `e > 1` when really `e ≤ 1`, you *feel* +EV and aren't.
  Backtest calibration before trusting it.
- **+EV ≠ low risk.** It's still ~1-in-145k all-or-nothing (`spm_v1 §5`). A positive sign means you
  win *over many shots* — you need bankroll to survive the drought. Prediction changes the sign, not
  the variance.
- **Book limits.** Consistently +EV accounts get limited or closed — the real operational ceiling
  (and why multi-accounting is itself fragile).
- **Line movement / stale lines.** The `e > 1` you measured can evaporate by kickoff.
- **Don't confuse rebate with edge.** The boost is *structure* (subsidy); only `e > 1` is *edge*.
  SPM v1 captures the rebate; only v2 adds edge.

## 6. Implementation

**Built (deterministic edge math, `lib/spm/leg-stacker.ts` + `__tests__/lib/spm/prediction.test.ts`):**
- `legEdge(leg, pHat)` → `e = p̂ / p_book`.
- `slipEVWithEdge(legs, pHat)` → `{ evMultiple, productEdge, positiveEV }`.
- `breakEvenEdge(N, margin)` → `e* = (1+margin)/(1+boost)^(1/N)`.

**Pluggable (the research part — the only thing that creates edge):**
- `predictLegProb(signal)` → `p̂`. Start with a **sharp-book adapter** (read Pinnacle/Betfair, de-vig,
  return `p̂`); optionally a calibrated statistical model later. This is where real work and real risk live.

## 7. Honest position

The 1000% boost lowers the +EV bar to a **~1–3% per-leg edge**, so SPM v2 **can be genuinely +EV**
with a modest, real, *calibrated* signal — the sharp-book reference being the most credible. Without
such a signal it stays a structured −vig lottery (still a fine *shot*, by design). With it, the sign
flips but the variance does not: it's a **+EV high-variance lottery**, which rewards bankroll and
discipline, not hope. Structured shot first; +EV lever when earned.
