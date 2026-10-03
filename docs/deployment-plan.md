# Deployment plan: hosted website + a placer agent on any PC

Status: **planned, not started** (written 2026-10-03). Decisions in §2 are pending; each has a
recommended default, so work can start on the defaults if nothing else is decided. Each phase in §5 is
sized to fit one working session. Tick the boxes and update **Status** as phases land.

## 1. Goal

- **The website runs online**, behind a login, from any browser or phone.
- **Any Windows PC can place bets** by running one small program (the *agent*) and signing in. It needs
  no `.env` file and no copy of the project's secrets.
- **Several PCs can work at once.** The existing database queue already guarantees that no slip is placed
  twice (`docs/placement-architecture.md`).

## 2. Decisions (pending — defaults recommended)

| # | Decision | Default | Why |
|---|---|---|---|
| D1 | Hosting | **Vercel** (free tier) | Next.js-native and the simplest to run. A small VPS (~$5/month) is the alternative if we want always-on scheduled jobs on the server; with agents doing the scheduled work (§4), Vercel is enough. |
| D2 | SportyBet passwords | **Encrypted vault** | The operator wants any PC to work without a local `.env`. The safer alternative is to store nothing and log in by hand once in each PC's agent Chrome (it stays logged in). |
| D3 | Who uses it | **Operator only**, built so more users can be added later | Each SportyBet account belongs to one user; agents only ever receive their own user's accounts. |

## 3. What ties the app to one PC today

| Dependency | Where | Why it can't run in the cloud as-is |
|---|---|---|
| Starting local scripts | `app/api/sessions/[id]/place`, `…/fetch-history`, `lib/placement/browser.ts`, `lib/placement/capture-boost.ts` | They spawn `node scripts/…` on the server's own machine. |
| Chrome on `localhost:9222` | `app/api/browser`, `…/place`, `lib/placement/browser.ts`, `cdp-fetch.ts`, `capture-boost.ts` | A hosted server has no browser and can't reach the PC's. |
| SportyBet reads through the browser | `lib/placement/cdp-fetch.ts`, used by the odds feed (`lib/books/sportybet.ts`), bonus plan, results (`lib/pedlas/results.ts`) and open bets (`lib/books/sportybet-bets.ts`) | SportyBet drops plain server requests by fingerprint (seen 2026-10-01). Building, settling and survival all need these reads. |
| Secrets in `.env` | `SUPABASE_*`, `SPORTY_NUMBER/PASSWORD`, `BETWAY_*`, `NVIDIA_*`, `APIFOOTBALL_*`, `FOOTBAL_API_KEY`, `ODD_API_KEY` | Every PC needs a copy, and the Supabase **service** key gives full database access. |
| No login | every page and API route | Anyone with the URL could build or place on the account. **Blocker for going online.** |

## 4. Target architecture

```text
 browser / phone ──HTTPS──▶  WEBSITE (Vercel)                      SUPABASE (Postgres)
                             • login (Supabase Auth)  ──────────▶  sessions, slips, placement queue
                             • pages + read-only APIs              agent_jobs, agents, vault (encrypted)
                             • buttons ENQUEUE jobs                ▲
                             • vault decrypt (VAULT_KEY            │ agent API (agent token only)
                               lives ONLY here)                    │
                                                                   │
   PC 1 ── AGENT ─────────────────────────────────────────────────┤
   PC 2 ── AGENT   • signs in once (device code) → agent token    │
                   • launches its own Chrome, logs into SportyBet  │
                     with credentials fetched from the vault        │
                   • claims jobs: build · place · settle · history  │
                   • runs ALL SportyBet-touching code locally ──────┘
```

Rules:
- **The website never talks to SportyBet.** Every SportyBet read or click runs on an agent, in a real
  Chrome. The site only reads and writes the database.
- **Buttons become jobs.** Build, Place, Settle, Sync history, Prepare browser and Capture boost each
  insert a row in `agent_jobs`. Any online agent claims it with the same lease pattern as the slip queue,
  runs it, and writes progress and results back. The UI shows which PC is doing what.
- **Scheduled work runs on agents too.** Any online agent settles open sessions every ~10 minutes
  (leader = the agent holding a `settle` lease), so results keep updating without the site running cron.
- **Secrets:**
  - On the server only: `SUPABASE_SERVICE`, `VAULT_KEY`, odds and AI API keys (Vercel environment
    variables).
  - On a PC: one revocable **agent token** in `%APPDATA%\pedla\agent.json`. Nothing else.

## 5. Phases (each one session, each shippable on its own)

### Phase 1 — Login and lock-down
- [ ] Supabase Auth (email + password). An allow-list table `app_users` decides who may sign in.
- [ ] Protect every page and API route. Next 16 renamed middleware to **proxy**: read
      `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` first (AGENTS.md: this is not the
      Next.js you know).
- [ ] Sign-in page; header shows who is signed in, with sign-out.
- [ ] Local mode keeps working: on `localhost` with `PEDLA_LOCAL=1` the login can be skipped, so today's
      single-PC flow is never blocked mid-migration.
- **Done when:** a logged-out browser gets the sign-in page for every page and HTTP 401 from every API.

### Phase 2 — Credentials vault
- [ ] Migration `009_vault_and_agents.sql`:
  - `book_accounts` (id, owner user, book_id, label, login, `password_enc`, `iv`, created/updated);
  - `vault_audit` (who / which agent / when / which account).
- [ ] `lib/vault.ts`: AES-256-GCM encrypt/decrypt with `VAULT_KEY` (32 bytes, server env only). Unit tests:
      round trip; tampered ciphertext rejected; wrong key rejected.
- [ ] Settings → **Accounts**: add or edit a SportyBet account. The password is write-only: shown as
      "set", never sent back to the browser.
- [ ] One-off import of the current `.env` `SPORTY_*` / `BETWAY_*` into the vault.
- **Done when:** the account is in the vault, `.env` no longer needs `SPORTY_*`, and nothing returns a
  password except the agent endpoint in Phase 3.

### Phase 3 — Agents and the job queue (the main piece)
- [ ] Migration:
  - `agents` (id, owner, name, host, version, token hash, last seen, accounts it serves, revoked);
  - `agent_jobs` (id, type, session, payload, status `queued|claimed|running|done|failed`, claimed_by,
    lease_until, progress, result, error, created/updated);
  - RPCs `claim_job` / `renew_job` / `finish_job` (`FOR UPDATE SKIP LOCKED`, the same pattern as
    `claim_slips` in 008).
- [ ] Agent API (`/api/agent/*`, agent-token auth):
  - `register` (device-code sign-in: the PC shows a code, the operator approves it on the site);
  - `heartbeat`;
  - `jobs/claim`, `jobs/:id/progress`, `jobs/:id/finish`;
  - `credentials/:account` (decrypts, audits, only for the agent's own accounts).
- [ ] `scripts/agent.mjs` (`npm run agent`):
  - sign-in, heartbeat, launch Chrome (`cdp-launch-chrome.ps1`), log into SportyBet with vault
    credentials (never toggle REAL/SIM — memory `never-auto-toggle-real-sim`);
  - claim and run jobs by calling the existing code:
    - **build** → `buildDecisionBotForAdapter`, then save slips;
    - **place** → `place-session.mjs` (queue mode);
    - **settle** → the settle logic;
    - **history** → `sync-h2h.mjs`;
    - **prepare** → `prepareBrowser`;
  - exactly one job type `place` per Chrome window; `build` / `settle` may run alongside.
- [ ] Website: each button inserts a job instead of spawning. The session page shows job progress and the
      roster of online agents (`WorkersRoster` already exists for placement workers).
- [ ] The secret-dependent reads used by pages (coverage `site=1`, survival, games) read what agents last
      stored, plus a "refresh" job.
- **Done when:** with the site on `localhost` and the agent on the same PC, build → place → settle runs
  end to end through jobs only (no spawn), on a ₦10 test session in dry run, then one live ₦10 slip.

### Phase 4 — Go online
- [ ] Vercel project, environment variables from §4, Supabase row-level security on every table (the site
      uses the user's session; only server code uses the service key).
- [ ] Remove the service key and all third-party keys from PCs.
- [ ] Rate limits on `/api/agent/*` and sign-in.
- **Done when:** the hosted site works from a phone, and a PC with only the agent placed a live ₦10 slip.

### Phase 5 — Second PC and packaging
- [ ] `scripts/install-agent.ps1`:
  - install Node, clone/pull, `npm ci`, `npx playwright install chromium` if needed;
  - a desktop shortcut "PEDLA agent".
- [ ] The agent auto-updates from git on start (version shown on the site).
- [ ] Test on a second PC with a second SportyBet account: both place one session together, with no
      double placing (re-run `scripts/test-queue.mjs` against the hosted database).
- **Done when:** a fresh PC goes from nothing to placing in under 15 minutes with only the site login.

## 6. Security checklist (review before Phase 4 goes live)

- `VAULT_KEY`, `SUPABASE_SERVICE` and API keys exist only in Vercel env. Never in git, the client bundle or
  logs.
- Passwords:
  - decrypted only inside `/api/agent/credentials`, only for that agent's own accounts;
  - sent only over HTTPS, and every read is audited;
  - the agent keeps them in memory only.
- Agent tokens: random 32 bytes; the database stores only the hash; revocable from the site. A revoked
  agent stops at its next heartbeat.
- The placement safety rules stay as they are:
  - per-account submit lock;
  - lease → begin_submit → verify;
  - the price floor;
  - Flexi pay-window checks;
  - never toggle REAL/SIM.

## 7. Risks and open questions

- **SportyBet may challenge a new device or IP** (OTP or captcha) on a new PC. The first sign-in on a new
  PC may need the operator in the loop: the agent should detect it and ask on the site.
- **Several accounts on one person's devices** may breach SportyBet's terms. That's the operator's
  decision; the code supports one account per agent window.
- **Vercel's function time limit:** long work (builds take minutes) must run on agents, never in a route.
  This is already the plan, but don't move `buildDecisionBotForAdapter` into a route.

## 8. How to resume

Read this file, `docs/placement-architecture.md` and `AGENTS.md`. Pick the first unticked phase, confirm
the §2 decisions with the operator if they're still pending, then build that phase, test it as written
under **Done when**, tick its boxes, update **Status**, commit and push to `irekanmi`.
