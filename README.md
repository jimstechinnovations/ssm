# PEDLA — Multi-Book Under-4.5 Structure Builder

PEDLA is a *structural coverage* betting-slip builder for total-goals markets across multiple
Nigerian bookmakers (Betway Nigeria, SportyBet; Stake registered but unverified). It anchors every
axis on **Under 4.5 at odds ≥ 1.20**, enumerates outcome vectors, ranks by probability, and fills
the budget with the top slips — with **honest EV** displayed on every book. A paced, dry-run-first
placement bot can queue the slips (live placement is env-gated). See [pedla_v1.md](pedla_v1.md).

> **Honest stance (non-negotiable).** PEDLAS does not beat the bookmaker margin and does not create
> edge. The Win Boost is a subsidy, not edge. History models were backtested on real data and have
> **no edge** (`pedlas_v2.md §1a`) — they are advisory only. The only credible future edge source is
> a sharp-book reference (see `archive/docs/spm_v2.md §3`).

## Docs

- [pedla_v1.md](pedla_v1.md) — CURRENT spec: PEDLA rules (S/E removed), multi-book, placement bot
- [pedlas_engine.md](pedlas_engine.md) — how the original pipeline works, start to finish
- [pedlas_v1.md](pedlas_v1.md) / [pedlas_v2.md](pedlas_v2.md) — spec, worked maths, backtest findings
- `PEDLAS.txt`, `PEDLAS_Algorithm_Overview.pdf` — original algorithm notes
- `archive/` — superseded SSM/SPM flows and docs (kept for reference, excluded from build/tests)

## Layout

- `app/pedlas/` — the UI (root `/` redirects here)
- `app/api/pedlas/` — build + persisted-books + history-sync routes
- `lib/pedlas/` — the engine (market select, enrich, quality, build, rank, budget, boost, …)
- `lib/betway/` — Betway feed scraper (Playwright)
- `lib/football-history/` — apifootball.com history client
- `lib/llm/` — NVIDIA NIM ranking (advisory only)
- `supabase/` — migrations (books + match history)

## Getting started

```bash
npm run dev        # http://localhost:3000 → /pedlas
npx vitest run     # unit tests (live tests need API keys in .env)
```
