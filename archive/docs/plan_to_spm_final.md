# Plan — Turn the current codebase into the final SPM model

## Context

**Where we are.** The repo is a Next.js app implementing **SSM v3.1**: an 8-game / 56-slip
covering-code matrix (`screen → generate → matrix`), Supabase-persisted, fed by API-Football.
On top of it we have built and property-tested a set of **pure prototype libraries** and written
the **design specs** that supersede v3.1:

- Specs: `ssm_v3.2.md` (optimised coverage), `ssm_v3.3.md` (boost/saver mechanics), `spm_v1.md`
  (leg-stacking max-win), `spm_v2.md` (the +EV prediction lever).
- Prototype libs (pure, tested): `lib/ssm/fingerprint.ts`, `scoreline-model.ts`, `market-overlap.ts`,
  `slip-analysis.ts`, `coverage-optimizer.ts`; `lib/spm/leg-stacker.ts`.

**Goal.** A single **mode-based slip generator** — you pick an engine, it produces ready-to-place
slips. SSM and SPM are **modes** over one shared substrate (data layer, leg selection, EV verdict,
betslip UI, persistence). The optional **+EV lever** (`predictLegProb`) is shared across all modes.

## The slip generator — three modes, one substrate

| Mode | Engine (built) | Output | Win rate | Role |
|---|---|---|---|---|
| **SSM Coverage** | `coverage-optimizer.ts` | ~9–17 short slips (4–5 legs), Dutch-staked | **~80%** at break-even | the **floor** (frequent, low-variance) |
| **SPM Max-Win** | `leg-stacker.ts` Mode M | ticket book of 50-leg slips, cap-clamped to ₦50M | ~1 / 200k | the **moonshot** (₦100 → ₦50M) |
| **SPM Survival** | `leg-stacker.ts` Mode S | ~31-leg banker slip, Bet Saver | 1.9% jackpot · ~82% insured | the **insured lottery** |

All three plug into one interface so the API, UI, and persistence are mode-agnostic:

```ts
type SlipMode = 'ssm-coverage' | 'spm-maxwin' | 'spm-survival'
interface EngineConfig { pool: MarketPair[]; bankroll: number; minStake: number; cap: number;
                         costTarget?: number; predict?: (l: Leg) => number }
interface GeneratedBook { mode: SlipMode; slips: Slip[];      // legs, combinedOdds, boost, stake, payout(capped), pHit
                          verdict: { evMultiple: number; positiveEV: boolean; avgMargin: number };
                          meta: { winRate?: number; pAnyHit?: number } }
function generateSlips(mode: SlipMode, cfg: EngineConfig): GeneratedBook
```

The user (or a future policy) just **decides the mode**; everything downstream is identical. The
default is **SSM Coverage** (the survivable floor); SPM modes are the deliberate lottery shots.

**`predict?` is optional — the generator ships without it.** With no `predictLegProb`, every mode
uses the book's de-vigged probability (`pBook`) and is **fully working today** — it just generates
honest, structured −vig slips. The +EV lever only *adds* a shot at positive expectation when a real
signal exists; it is **never required** for the models to produce slips.

---

## Already built — keep as the engine core

| File | Role in final SPM | Status |
|---|---|---|
| `lib/ssm/fingerprint.ts` | scoreline → resolved markets, label↔market map | ✅ keep (shared primitive) |
| `lib/ssm/scoreline-model.ts` | per-game distribution → `pMarket` | ✅ keep (shared primitive) |
| `lib/ssm/market-overlap.ts` | redundancy/overlap pruning | ✅ keep |
| `lib/spm/leg-stacker.ts` | `legFrom`, `selectLegs`, `planSlip`, `buildTicketBook`, `binomialBand`, edge math (`legEdge`, `slipEVWithEdge`, `breakEvenEdge`) | ✅ keep — the heart |
| `lib/ssm/coverage-optimizer.ts`, `slip-analysis.ts` | SSM Engine-A (floor) + audit tooling | keep if Engine A retained |

These need **no rewrite** — the work below is data, orchestration, API, UI, and the `predictLegProb`
adapter.

---

## Phase 1 — Data layer (the biggest real gap)

The model needs **both sides** of each binary market per fixture (to de-vig → margin + `pBook`).

1. Extend `lib/football-api/client.ts` (or new `lib/odds/`) to fetch, per fixture, paired odds for:
   O/U 1.5 / 2.5 / 3.5, BTTS Yes/No, Odd/Even, DC 12 / 1X / X2.
2. New normaliser → `MarketPair[]` (the `leg-stacker` input). One adapter, well-typed.
3. **+EV lever — OPTIONAL, deferred, NOT core.** `predictLegProb` produces a better `p̂` than the
   book; the generator works without it (defaults to `pBook`). If ever wanted, the **only non-research
   form** is a **sharp-book adapter** (Pinnacle / Betfair de-vig) — a *data feed*, not a model. **Do
   not** build an own statistical/ML model (that is the research path we are avoiding). Ship the core
   first; treat this as a separate, later, opt-in integration.
4. **Decisions:** which odds provider for the candidate pool (**required**); the sharp reference is
   optional and out of the core build.

---

## Phase 2 — SPM engine consolidation (`lib/spm/`)

1. **Cap-clamp** — `clampToCap(legs, {stake, cap, boost})`: trim/swap so `stake·O·(1+boost) ≈ cap`,
   never overshoot (we saw Slip B forfeit ~₦12.8M). New function + property test.
2. **Mode-dispatch orchestrator** — `generateSlips(mode, cfg): GeneratedBook` (the shared interface):
   - `spm-maxwin` → select 50 ≥1.20 lowest-margin → `buildTicketBook` (shots = `bankroll/minStake`,
     one-match rule) → `clampToCap` → EV via `planSlip` / `slipEVWithEdge`.
   - `spm-survival` → `chooseLegCount`/`binomialBand` (~31) → banker slip + Bet Saver band report.
   - `ssm-coverage` → `coverage-optimizer.optimizeCoverage` (short pool, Dutch stakes) → normalise to
     the same `GeneratedBook` shape.
   One function, three branches, identical output contract.
3. **Selection ranking** — rank by **edge `e`** when `predict` is present, else by **margin**
   (`spm_v2 §4`). Reuse `market-overlap` to drop redundant alternatives. Shared by all modes.
4. **Shared primitives** — keep `fingerprint`/`scoreline-model` where they are (or move to `lib/shared`);
   leave one clear owner.

---

## Phase 3 — Retire / relate the legacy SSM matrix

- **Resolved:** SSM v3.3 coverage ships as the **`ssm-coverage` mode** (the break-even floor) —
  `coverage-optimizer.ts` is already built; it just needs a `GeneratedBook` adapter. SPM modes sit
  beside it; the generator is mode-selectable (default `ssm-coverage`).
- **Retire the v3.1 8-game / 56-slip path:** `generator.ts`, `distributor.ts`, `stake-calculator.ts`,
  `gate-screener.ts`, `market-detector.ts`, and the v1 `/api/generate` branch — superseded. Delete or
  hide behind a feature flag; remove their 8-game/56-slip assumptions from `types.ts`/`schemas.ts`.

---

## Phase 4 — API

- **`/api/screen`** → fetch a broad pool (≥50 unclaimed fixtures), normalise (Phase 1), compute per-leg
  margin (+ `p̂` if available), return the candidate pool **plus the scanner verdict** (avg margin,
  +EV/−EV vs the gate).
- **`/api/generate`** (reworked) → takes a `mode` (`ssm-coverage` | `spm-maxwin` | `spm-survival`) and
  `EngineConfig` → `generateSlips(mode, cfg)` → `GeneratedBook`. New zod schemas (drop `.length(8)` and
  the 56-slip shape) in `lib/ssm/schemas.ts`.
- **Persistence** — Supabase: store the book (pool snapshot, slips, predictions, verdict). Add a
  migration; reuse `lib/supabase/server.ts`.

---

## Phase 5 — UI

- **Screen page** (`app/(builder)/screen/page.tsx`): a **mode selector** (SSM Coverage · SPM Max-Win ·
  SPM Survival) driving the inputs — pool size, bankroll, min stake, cap, cost target. Drop the hard
  "8 fixtures" logic. The mode is the one real decision; the rest auto-derives.
- **Results / betslip view:** render each slip like the sample — legs (match · outcome · odds),
  combined odds, **capped payout**, **P(all hit)**; book totals (`P(any)`, total stake); the
  **scanner verdict** (avg margin, EV multiple, margin of safety, cap warnings).
- **Honest disclosures (non-negotiable UI copy):** the all-or-nothing nature, P(hit), and that it is
  a **structured −vig lottery unless a calibrated edge clears the gate**; surface book-limit risk.
- Rework the matrix page + components (`components/matrix/TierBadge.tsx` → leg/role badge;
  `components/screen/*`, `components/ui/Badge.tsx`).

---

## Phase 6 — Types, schemas, cleanup

- Consolidate SPM types into `lib/spm/types.ts` (`MarketPair`, `Leg`, `SlipPlan`, `TicketBook`,
  `EdgePlan`) — currently inline in `leg-stacker.ts`.
- Remove dead SSM-v3.1 types (`TierLabel`/56-slip, 8-game `MatchSelection`) or isolate behind the flag.
- Trim/repoint tests; keep all property suites (`__tests__/lib/spm/*`, shared `__tests__/lib/ssm/*`).

---

## Phase 7 — Verification

1. `npm test` — all property suites green (selection, ticket book, binomial band, edge identity,
   cap-clamp, one-match rule).
2. **E2E:** `npm run dev` → screen → build → betslip render on **live odds**; confirm the scanner
   verdict and capped payouts match `planSlip`.
3. **Default honesty:** with no `predictLegProb`, the UI labels every book "structured −vig lottery /
   floor" and never shows "+EV". *If* the optional sharp-book lever is ever added, it must pass an
   out-of-sample calibration check before the UI may show "+EV".

---

## Decisions to resolve early

1. **Odds provider** for the candidate pool (**required**). The sharp reference / `predictLegProb`
   (the +EV lever) is **optional and out of the core build** — ship without it; add later only if you
   want a +EV shot, and only as a sharp-book *data feed* (never an own model).
2. ~~Engine A retained?~~ **Resolved:** all three ship as selectable modes; default `ssm-coverage`.
3. **Persist** books in Supabase (migration) or run stateless?
4. **Multi-account distribution** (legacy `distributor.ts`) — still required, or dropped?

## Definition of done

From a date range, the app fetches the candidate pool and — for a **chosen mode**
(`ssm-coverage` | `spm-maxwin` | `spm-survival`) — produces a `GeneratedBook` of ready-to-place slips:
clean ≥1.20 low-margin legs (one per match), cap-clamped where relevant, rendered as real betslips with
**P(hit)** and an **honest EV verdict** (+EV shown only when a calibrated `p̂` clears the gate), and
persisted. All three modes share one interface; the legacy 8-game/56-slip path is removed or flagged.

## Honest guardrails (carry through every phase)

- The boost/saver are **subsidies**, not edge; only a calibrated `p̂ > p_book` is edge — never blur them.
- Always show **P(hit)** and the all-or-nothing reality; +EV ≠ low risk.
- Surface the real operational ceiling: **winning accounts get limited/closed; multi-accounting is fragile.**
