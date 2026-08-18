# The Tegridy Battle Plan

**Instructions from Claude to future Claude: how to build all one hundred.**
Drafted 2026-08-18 against the live repo. Companion to [YEAR_PLAN_2026_2027.md](YEAR_PLAN_2026_2027.md) (the operational to-do list) and [TOP_100_BUILDS.md](TOP_100_BUILDS.md) (the ranked list with revenue evidence). This document is the third leg: **per-item implementation instructions**, organized so any future session can open it, pick the next unstarted item, and build it correctly without re-deriving context.

---

## How to use this document

1. **Never skip the Preconditions line.** Every item names its foundation tracks (F1–F9), prior items, and operator actions. If a precondition isn't met, build the precondition — the ordering in this plan exists because building out of order has already cost this repo money (see EVERYTHING_LEFT's "doing it early is worse than never" table).
2. **Waves are sequential; items within a wave mostly parallel.** Wave N does not require Wave N−1 to be 100% complete, but the wave order encodes the dependency direction and the revenue logic: earlier waves fund and de-risk later ones.
3. **The rank number is the item's permanent ID** (matches TOP_100_BUILDS.md). Reference items as #N everywhere — commit messages, PRs, session handoffs.
4. **When you finish an item, update this file**: mark it `✅ shipped <date> <commit>` under its heading, and note anything the instructions got wrong. This document is a living runbook — a wrong instruction left uncorrected is a trap for the next session.
5. **When an instruction conflicts with repo reality, reality wins** — then fix the instruction. The repo moves; this plan was drafted 2026-08-18.
6. **Before starting any Wave 6 or Wave 7 item, read Part III (the Tradermigos annex)** — a dedicated sweep of the marketplace sub-app produced standing corrections that override anything a wave item assumes about NFT or social surfaces.

## The ten operating rules

These apply to every item, before and above each item's own Gates section:

1. **Verbatim-fork discipline (F7).** New contract surface is forked from a named battle-tested source at a pinned commit, vendored with a diff-guard CI job. Innovate in periphery and config, never in core math. If an item requires bespoke core math (flagged inline), it gets its own adversarial audit wave before deploy — no exceptions.
2. **Every fee line ends at the distributor split.** New revenue routes through F3 plumbing into the RevenueDistributor / treasury / POL split. No orphan fee accounts — the ReferralSplitter dust saga is the cautionary tale.
3. **Honesty-gating is load-bearing.** Every surface self-gates to "no data" rather than rendering a guess. Every fee is displayed before signature. Every risk (liquidation, decay, slashing, theta, depeg) is on the fact sheet, not the footnote.
4. **Nothing user-facing ships without its `isDeployed()`/flag gate** wired to constants, so the operator can un-gate by setting an address/env — the pattern that already runs this repo.
5. **The 12-function Vercel cap is real** until F5's escape lands. New backend surfaces extend the aggregator catchall (`?resource=` + lazy import) — read `api/SERVERLESS_BUDGET.md` before adding any route.
6. **Non-custodial or not at all.** No server ever holds user keys. Telegram/bot/session flows use F6 scoped session keys (spend caps, expiry, revocation). This is the one line the revenue evidence never justifies crossing.
7. **Law amendments are written, not silent.** Items conflicting with NO-perps / NO-stablecoin / NO-RWA (flagged in their Gates) require the operator to amend the doc law in a commit *before* the branch opens. If the amendment isn't written, the item is not buildable — move on.
8. **Deploys are ceremonies.** Post-re-home, every deploy/param change goes through the Safe with the oneshot-guard rehearsal pattern. No hot-key mainnet writes, ever again.
9. **Each wave ends with an honesty-debt sweep** (docs, addresses.json, README claims) and a coverage check — the ratchet only moves up.
10. **Measure or it didn't happen.** Every item's Done-when includes an observable metric (a fee event on-chain, an indexer row, a paying API key). Wire it into the Dune/analytics dashboards as part of the item, not later.

## The master schedule

How the waves map onto the year plan and beyond. Dates assume the year plan's Q1 (custody, login, TWAP, first revenue) completes on schedule — if it slips, everything slips with it; do not build around it.

| Wave | Theme | Target window | Gate to enter |
|---|---|---|---|
| W0 | Year-plan Q1 prerequisites | Sep–Nov 2026 | — (this IS the gate) |
| W1 | First money — 12 low-effort fee lines | Nov 2026–Jan 2027 | Custody re-homed, indexer deployed (F1), login live (F2) |
| W2 | The terminal complex — the flagship bet | Dec 2026–Mar 2027 | F1 websocket feed, F3 fee legs, F9 alerts |
| W3 | Launch economy — the wedge | Jan–Apr 2027 | W1 shipping fees; Solana Tier-4 ceremony done for #4 |
| W4 | Yield & credit stack | Feb–Jun 2027 | F7 audit pipeline proven on a small fork first |
| W5 | Pro & B2B | Mar–Jul 2027 | F5 API platform live; perps-law amendment for #8 |
| W6 | Social & identity | Apr–Aug 2027 | F2 fully live with RLS verified |
| W7 | NFT-fi & commerce completers | May–Sep 2027 | Redeploy batch (staking marketplace change) landed |
| W8 | Frontier & the flagged wing | Jun 2027 → ongoing | Per-item decision gates — each opens with a written amendment |

Foundations F1–F9 are not a wave — they start immediately, in parallel with W0/W1, in this priority order: **F1 → F3 → F2 → F9 → F5 → F4 → F6 → F7 → F8** (F7's discipline applies from day one even though its tooling matures over time).

## The dependency spine (memorize this shape)

```
Year-plan Q1 (custody · login · TWAP · fee rails · indexer)
        │
   F1 data spine ──────────┬──────────────┬───────────────┐
        │                  │              │               │
   W1 first money     W2 terminal    W3 launch econ   APIs (F5)
        │                  │              │               │
   funds & proves     referral+fee    creator/anti-rug   B2B rev
   the fee split      rails (F3)      primitives         │
        │                  │              │               │
        └────────► W4 yield/credit ◄──────┴── W5/W6/W7 ───┘
                        │
                   W8 frontier (decision-gated, never blocks anything)
```

Three chokepoints appear in more preconditions than anything else — treat them as sacred:
1. **F1 (indexer live)** — feeds the terminal, copy-trading, competitions, every API, tax reports, leaderboards.
2. **F3 (fee plumbing)** — every new revenue line lands here; build it once, correctly, with the referral ledger designed in from the start (bolting referrals on later means migrating fee accounting).
3. **F2 (login)** — the entire social tier plus referral claims, watchlists-as-product, and quest identity.

---

# Part I — Foundation tracks (F1–F9)

Shared infrastructure referenced by every wave. Start these immediately, priority order F1 → F3 → F2 → F9 → F5 → F4 → F6 → F7 → F8.

## F1 — Data spine — Ponder indexer deployed + hosted, GraphQL client, Solana leg, new-pair feed

**Where it stands today:** indexer/ is a complete Ponder 0.8 app deployed nowhere with zero consumers. ponder.config.ts subscribes (mainnet, start block 25263328) to TegridyStaking (0xcaDc93E9...), RevenueDistributor (0xF993316E...), SwapFeeRouter (0x6d5791A6...), every TegridyPair via factory(PairCreated) on TegridyFactory (0xa24C7287...), POLAccumulator pause+business events, TegridyFactory governance, TegridyTWAP DeviationBypassed, and the StakingAdmin/SwapFeeRouterAdmin timelock triplets. ponder.schema.ts has the typed tables; indexer/src/api/index.ts re-mounts GraphQL with tightened depth/alias/token limits, but the M3 note in ponder.config.ts is explicit: Ponder ships no auth and no rate limiting — a reverse proxy is mandatory. The frontend reads chain state via wagmi + the Alchemy/Etherscan Vercel proxies; there is no GraphQL client anywhere in frontend/src. No Solana indexing exists. SERVERLESS_BUDGET.md flags stale PR #25's api/indexer.js as a function-count hazard — do not merge it.

**The build:**

1) Host: create a Railway project (recommended over Fly — managed Postgres in one click, colocates every later service: keeper F4, api host F5, realtime F9). Provision Postgres, deploy indexer/ with `ponder start`, env: DATABASE_URL, PONDER_RPC_URL_1..4 (Alchemy primary, fallback keys — the config's fallback transport already rotates), TEGRIDY_STAKING_ADMIN_ADDRESS / SWAP_FEE_ROUTER_ADMIN_ADDRESS only if overriding the baked relaunch addresses. 2) Proxy: put the Ponder port behind Cloudflare (or Railway's edge) enforcing per-IP rate limits; expose only /graphql, /health, /ready. Never expose 42069 raw — the M3 runbook comment is law. 3) Frontend client: create frontend/src/lib/indexer/client.ts — plain fetch POST GraphQL with zod response parsing (mirror the src/lib/schemas/ pattern), env VITE_INDEXER_URL. isDeployed()-style gating: if VITE_INDEXER_URL is unset or /health fails, every consumer hook returns an explicit 'no data' state — never fall back to fabricated numbers (honesty-gating). Add first consumer hooks (frontend/src/hooks/useIndexedSwaps.ts, useIndexedStakingHistory.ts) and wire one page (StakePage history or pool stats) to prove the loop. Do NOT add a Vercel api/indexer.js function. 4) Solana leg: Ponder is EVM-only — create indexer-solana/ as a small Node service on the same Railway project: Helius webhooks (or polling getSignaturesForAddress) for the Meteora DBC pool + future curve program, decoding trades/fees into the same Postgres under solana_-prefixed tables so one GraphQL/REST surface serves both chains. 5) New-pair feed: add a Postgres trigger NOTIFY on the pair-creation table; F9's fan-out service consumes it. Document everything in indexer/DEPLOY.md.

**Done when:** 1) Hosted GraphQL endpoint answers behind the proxy, synced within ~10 blocks of mainnet head, and survives a 24h soak without stall (RPC fallback verified by killing the primary key). 2) At least one production frontend page renders indexer data through frontend/src/lib/indexer/client.ts, and unsetting VITE_INDEXER_URL yields the explicit 'no data' state, not stale or fake numbers. 3) A DBC trade on Solana appears as a solana_ row within one minute. 4) Raw Ponder port unreachable from the public internet; rate limit demonstrably enforced.

## F2 — Identity & social backbone — SIWE live, RLS verified, profiles/DMs/watchlists, push

**Where it stands today:** The code is written; the database is the blocker. frontend/api/auth/siwe.js + me.js and _lib/authCookie.js implement SIWE (2 of the counted Vercel functions). frontend/supabase/migrations/001–015 cover SIWE auth+RLS, orderbook, push subscriptions (002), revoked JWTs (003), P2P trades + chat (007), analytics (013), siwe_nonces (014), and the permissive-policy drops (015). Login is dead in prod until the year-plan Q1 'Login change-set' runs in its strict order (docs/YEAR_PLAN_2026_2027.md Q1: enumerate live qual=true policies → castVote proxyWrite repoint → 015 §1 DROPs → 014 → verify 42501 on all four tables → 016 → prune_revoked_jwts hardening → 013 + VITE_ANALYTICS_ENDPOINT; never 008 after 014). Push sending exists in api/_lib/push.js (web-push, VAPID env pair, dead-sub pruning) but VAPID keys are unverified in prod. No profiles, DMs, or watchlists tables exist; chat is trade-scoped (007). Year plan also flags: 5 of 10 live Supabase tables are unbuildable from repo — commit the base schema first.

**The build:**

1) Execute the Q1 login change-set exactly as written in YEAR_PLAN_2026_2027.md — do not reorder; several steps are [op] (operator runs SQL in the Supabase dashboard). Commit the missing base schema + restore script as migration 000 or a schema/ snapshot before touching anything. 2) Write an RLS probe suite (frontend/api/__tests__/rls-probe or a scripts/ node script) that hits every table with the anon key and asserts 42501 on unauthorized writes — this is the 'RLS verified' gate every social wave cites. 3) New migration 016_profiles_social.sql: profiles (wallet PK, handle, avatar_url, heat_tier_cache + fetched_at), watchlists, dm_threads/dm_messages — all RLS keyed to the SIWE JWT wallet claim, following 007's pattern. 4) Backend: route reads/writes through the existing api/supabase-proxy.js function (no new Vercel functions — SERVERLESS_BUDGET.md). 5) Frontend: extend the existing auth hook/consumers; new src/hooks/useProfile.ts, useWatchlist.ts, useDMs.ts; profile surface on existing pages before any new page. 6) Push: operator sets VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VITE_VAPID_PUBLIC_KEY/VAPID_SUBJECT in Vercel (npx web-push generate-vapid-keys), wire the service-worker subscribe flow to the 002 table, send a test push via _lib/push.js. Honesty-gating: heat_tier_cache always renders with its fetched_at age; stale > 24h renders as 'unverified'.

**Done when:** 1) SIWE login round-trips in production: sign → cookie → /api/auth/me returns the wallet; logout revokes via revoked_jwts. 2) RLS probe suite green: every anon-key unauthorized write returns 42501; suite runs in CI or a documented script. 3) A profile + watchlist created on one device renders on a second device; a DM lands between two test wallets under RLS. 4) A real web-push notification arrives on a physical device from the prod VAPID pair.

## F3 — Fee plumbing — fee-on-top legs, periphery FeeRouters, referral ledger

**Where it stands today:** The on-chain sink exists and is live: contracts/src/SwapFeeRouter.sol (0x6d5791A6..., with SwapFeeRouterAdmin timelock sister) → ReferralSplitter.sol → RevenueDistributor.sol (0xF993316E..., epoch ETH to veTOWELI stakers) and POLAccumulator (0x2A5f65f4...). The feeSplit/POL wiring is deployed but awaits the operator's strict-order timelock sequence (YEAR_PLAN Q1 'First revenue': proposePolAccumulator → 48h → execute → proposeFeeSplit → 48h → execute; never raise polShareBps first). docs/SWAP_REVENUE_ARCHITECTURE.md is the design doc. Frontend: the 7-aggregator meta-router (src/lib/aggregator.ts, swapRouting.ts) currently routes with NO venue fee; integrator-fee scaffolding exists only on the launcher side (src/lib/launcher/integratorFees.ts, src/hooks/useIntegratorFees.ts). The indexer already subscribes to SwapFeeRouter.SwapExecuted. No referral ledger exists off-chain.

**The build:**

1) Operator prerequisite: complete the Q1 POL/feeSplit timelock sequence so the sink actually splits. 2) Native integrator fees first (zero new contracts): in src/lib/aggregator.ts, set each provider's integrator-fee parameter where supported — LiFi (fee + integrator), KyberSwap (feeAmount/chargeFeeBy), OpenOcean (referrer + referrerFee), Paraswap (partnerAddress/partnerFeeBps), 0x-style swapapi (swapFeeBps) — recipient = SwapFeeRouter or a per-chain fee wallet that forwards. CoW: use the app-data partner-fee field. Rate: 0.25% default on convenience-mode routes; the raw 0-fee route stays selectable (this is build #3's substrate — F3 only lays the legs, waves set final rates). 3) Periphery FeeRouter contracts for providers without native fees: do NOT fork external code — extend the house's own audited SwapFeeRouter pattern; new contracts/src/FeeRouterV2.sol only if a delta is truly needed, deploy via contracts/script/DeployFeeRouterV2.s.sol, F7 audit wave before deploy, immutable, Safe-owned. 4) Referral ledger: on-chain share flows through ReferralSplitter where the leg is on-chain; for aggregator-native fees (paid off-path), record attribution rows — referrer, trader, provider, fee — in a Supabase referral_ledger table written by the swap flow and reconciled against F1's SwapExecuted/provider data; payouts only from actually-received fees (never spend unearned capital). 5) Emit fee lines in the UI honestly: every fee-on-top quote shows the fee before signing.

**Done when:** 1) A LiFi- or Kyber-routed prod swap delivers the venue fee to the configured recipient, visible on-chain and as an F1 SwapExecuted/ledger row. 2) RevenueDistributor receives and distributes an epoch containing routed-swap fees; a staker claim succeeds. 3) Referral attribution row written for a ref-linked swap and reconciles 1:1 against on-chain/provider records. 4) UI shows the exact fee pre-signature on every fee-bearing route; the 0-fee raw route remains available.

## F4 — Keeper network — conditional-order execution, shared trigger engine, receipts

**Where it stands today:** EVM conditional orders exist client-side only, riding CoW's infrastructure: src/lib/composableCow.ts, cowProtocol.ts, cowSwap.ts; hooks useCowLimitOrder.ts, useCowTwap.ts, useDCA.ts; components LimitOrderTab.tsx, DCATab.tsx, TwapOrderPanel.tsx under src/components/swap/. Execution is done by CoW's watchtower/solvers — the venue runs no keeper. There is no Solana keeper, no shared trigger engine, no retry/receipt store. TegridyTWAP (0xdFdd6D72...) is live as an on-chain price source and F1 indexes its DeviationBypassed rebootstrap signal.

**The build:**

1) Design decision — keep CoW's watchtower as the executor for everything expressible as a ComposableCoW conditional order (limit/TWAP/DCA on mainnet); the venue keeper exists only for what CoW cannot do: oracle-triggered SL/TP/trailing/OCO (wave #16) and all Solana execution. Never rebuild what CoW runs for free. 2) Create keeper/ (Node/TS) deployed on the F1 Railway project. Shared trigger engine: a rules table (keeper_orders) in the F1 Postgres — order type, trigger predicate, signed payload, status; an evaluator loop consuming prices from F1 GraphQL plus direct TegridyTWAP reads (pause evaluation for a pair while DeviationBypassed is fresh). 3) Execution adapters: EVM — submit the user's pre-signed order (EIP-712 / ERC-1271 via ComposableCoW where possible, else direct SwapFeeRouter call with a session-key grant from F6); the keeper NEVER holds user funds, only gas. Solana — Jito-aware: build bundle, auto-tuned tip, blockhash-expiry retry. 4) Discipline: idempotency key per order-attempt; bounded retries with backoff; every attempt writes keeper_receipts (tx hash, outcome, gas, tip) surfaced in the UI via F1's API — failed orders show as failed, never silently dropped (honesty-gating). 5) Keeper wallet: dedicated hot wallet funded ONLY from earned revenue with a hard balance cap, refill via Safe transaction; env KEEPER_PK, JITO_BLOCK_ENGINE_URL, RPC urls. Alerting on wallet-low and stuck-order via F9.

**Done when:** 1) On a mainnet fork test, a stop-loss order executes within 3 blocks of its trigger price; the receipt row records the tx hash. 2) A forced execution failure retries with backoff and lands exactly once (idempotency proven), with the failure visible in the user's order UI. 3) A Solana order lands via a Jito bundle with the tip recorded in its receipt. 4) Keeper wallet compromise drill: max loss = capped gas balance; no path to user funds exists in code review.

## F5 — API platform — keys, metering, billing, the serverless-budget escape

**Where it stands today:** frontend/api/ sits at 11 of the Hobby plan's hard 12-function cap (api/SERVERLESS_BUDGET.md documents the counting rules, the load-bearing aggregator/[provider]/[...path].js catchall, and the ?resource= lazy-import pattern for zero-cost first-party resources — heat, births, record, launch-radar, etc.). Recount before touching anything; the doc's own table is dated 2026-06-01. A keyed-API precursor exists: api/v1/index.js is a real NFT data API (collections/listings/floor/holders/activity/token) with allowlisted contracts — but it has no API keys, no metering, no billing; only the per-IP Upstash sliding-window limiter in api/_lib/ratelimit.js (which fails OPEN when Upstash is unconfigured, per the 2026-06-09 outage fix). No Stripe, no key issuance, no usage dashboard.

**The build:**

1) The escape — decide the host. Recommendation: do NOT buy Vercel Pro for this; stand up a dedicated api host (Hono or Fastify) on the F1 Railway project at api.memetic.fun. Rationale: paid API traffic wants colocated Postgres (F1 data, usage records), no cold-start metering distortion, no per-function cap, and it keeps the Vercel deploy on Hobby. Vercel Pro remains the fallback if the operator prefers one platform (a billing decision — flag it). Existing free consumer endpoints stay on Vercel untouched. 2) Keys: api_keys table in Supabase (key hash, owner wallet, tier, created/revoked) — issued from a SIWE-authed dashboard page (F2 prerequisite), served through the existing supabase-proxy.js. 3) Middleware chain on the api host: key auth → tier limits (port the ratelimit.js sliding-window pattern, but fail CLOSED here — paid endpoints without metering must not serve) → metering (Upstash counters flushed to Postgres usage_daily). 4) Billing: Stripe first (webhook → tier assignment; GoPlus-class buyers pay fiat), with on-chain PremiumAccess honored as an alternate entitlement check later. Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, UPSTASH_*, DATABASE_URL, SUPABASE_SERVICE_KEY. 5) Version everything under /v1/; migrate api/v1/index.js routes there as the first product; publish docs/API.md updates. All paid-API waves (#39, #40, #41, #42, #97) mount here.

**Done when:** 1) A keyed request returns 200 with the call recorded in usage_daily; the same request unkeyed returns 401, over-quota returns 429 with tier info. 2) A Stripe test-mode subscription provisions a working key end-to-end without human intervention; cancellation downgrades it. 3) The Vercel deploy's function count is unchanged and the deploy stays green on Hobby. 4) Paid endpoints fail closed when Upstash/Postgres are unreachable (503, never unmetered service).

## F6 — Wallet/session infra — embedded wallets, 4337 paymaster, session keys, Telegram signing

**Where it stands today:** Effectively greenfield. Wallet connection is stock wagmi/viem (src/lib/wagmi.ts) plus Solana wallet-adapter; src/lib/eip5792.ts adds EIP-5792 batched-call support where wallets offer it. There are no embedded wallets, no account abstraction, no paymaster, no session keys, and no Telegram signing anywhere in frontend/src (verified by search). Waves #5 (TG bot), #44 (embedded wallets), #48 (gas abstraction), and F4's pre-signed keeper orders all depend on this track.

**The build:**

1) Embedded wallets: integrate Privy (recommended over Dynamic — mature wagmi connector, embedded + external wallets in one modal, Solana support). New src/lib/wallet/privy.ts; wrap the app root provider; env VITE_PRIVY_APP_ID (+ server PRIVY_APP_SECRET on the F5 host for verification). External-wallet users see no change — Privy wraps, never replaces, the existing wagmi config. Never build custody; the SDK's key-share model is the whole point. 2) 4337: pick Pimlico as bundler/paymaster API with Safe smart accounts (permissionless.js) — Safe accounts align with the house's Safe-owned custody culture and vendor battle-tested modules verbatim (F7 intake for any on-chain module). New src/lib/wallet/smartAccount.ts. House-law compliance for sponsorship: the paymaster deposit is funded exclusively from the treasury's earned-revenue share ('may not spend capital it has not earned') — sponsorship policy (per-user daily cap, eligible ops) lives server-side on the F5 host at /v1/paymaster-policy. 3) Session keys: Safe module route (e.g., Zodiac/Safe allowance or 7579 session-key module, vendored verbatim at exact commit) granting scoped permissions: allowed targets (SwapFeeRouter, ComposableCoW), per-tx and cumulative spend caps, hard expiry. New src/lib/wallet/sessionKeys.ts; this is what F4's keeper and the TG bot present as authority. 4) Telegram delegated signing (non-custodial): the TG bot (F9 transport) deep-links into the PWA where the user mints a session key; the key material stays client-side (passkey-wrapped); the bot server relays intents that only a live, capped, expiring session key can execute. Flag-gate the whole track behind VITE_ENABLE_SMART_WALLETS until audited.

**Done when:** 1) An email-login user completes a real swap with no extension and no seed phrase. 2) A sponsored transaction executes under the paymaster policy; exceeding the daily cap is rejected; the deposit source traces to earned revenue. 3) A session key with a spend cap and 24h expiry executes within scope, is rejected beyond cap, and is dead after expiry (fork tests). 4) A Telegram-initiated trade executes with zero private-key material on any server.

## F7 — Contracts factory & audit pipeline — fork intake, diff-guard, fuzzing CI, Safe ceremony

**Where it stands today:** Foundry repo at contracts/ (~53 sources) with vendored libs in contracts/lib/ (forge-std, openzeppelin-contracts, solady, solmate, v4-core, v4-periphery, uniswap-hooks). CI already runs contracts-ci.yml, contracts-coverage.yml, slither.yml, codeql.yml, gitleaks.yml in .github/workflows/. Deep audit culture in-repo (AUDITS.md, SECURITY_AUDIT_300_AGENT.md, SPARTAN_AUDIT.txt, per-date findings files). Deploy tooling: contracts/script/ with DeployMVP.s.sol, VerifyMVP.s.sol, TransferOwnershipToMultisig.s.sol, deploy-gated.sh, rehome-ownership.sh. Missing: no formal verbatim-fork intake procedure, no diff-guard proving vendored code matches its upstream commit, no echidna/halmos in CI, no standing fork-test harness convention, and the Safe deployment ceremony is blocked on the Q1 custody re-home (docs/SAFE_REHOME_RUNBOOK.md). YEAR_PLAN Q1 also lists the unarmed coverage ratchet (.github/coverage-floor.json absent).

**The build:**

1) Write contracts/FORK_INTAKE.md — the law's procedure: name upstream repo + exact commit hash; vendor via pinned submodule or copied tree with the hash recorded in a manifest (contracts/fork-manifest.json: {source repo, commit, files, declared-delta files}); every delta file gets a top-comment justifying the amendment. 2) Diff-guard CI: new job in contracts-ci.yml running a script (scripts/diff-guard.sh) that clones each manifest entry at its pinned commit and fails on any diff outside the declared-delta list. This makes 'verbatim fork' machine-verified, not vibes. 3) Fork-test harness: contracts/test/fork/ForkBase.t.sol reading MAINNET_RPC_URL, with the live address book (staking, fee stack, factory) as constants; every wave's integration tests inherit it. 4) Fuzzing/formal: add echidna and halmos jobs to CI — nightly and non-blocking for two weeks, then required for contracts/src changes; start corpus with TegridyStaking and the fee stack invariants (fixed supply, fee conservation, no unearned spend). 5) Arm the coverage ratchet (.github/coverage-floor.json) per the year plan. 6) Audit-wave gate: docs/AUDIT_WAVE_TEMPLATE.md; deploy-gated.sh refuses to run unless a signed-off audits/<wave>.md exists for the target contracts. 7) Safe ceremony: after Q1 re-home, standardize — deploy from script → VerifyMVP-style check → TransferOwnershipToMultisig.s.sol → acceptOwnership from the Safe → only then wire frontend addresses (isDeployed() gating in src/lib/constants.ts stays the last switch).

**Done when:** 1) Deliberately editing one vendored line fails CI via the diff-guard. 2) Echidna + halmos jobs green and required on contracts/src PRs; coverage ratchet armed and enforcing. 3) A rehearsal wave on a fork completes the full ceremony ending with the Safe as owner and frontend gated until the address flip. 4) deploy-gated.sh provably refuses a deploy lacking audit sign-off.

## F8 — Reputation productization — Heat + deployer reputation + wallet exposure as keyed API and attestations

**Where it stands today:** Every input already exists as client-side TS. Heat: frontend/src/lib/heat/ (heatClient.ts, heatOracle.ts, attestation.ts, launchGate.ts, gateAudit.ts, heatGateConfig.ts) reading the Jungle Bay Island held-time oracle through the Vercel catchall ?resource=heat (api/_lib/heat.js — CORS-forced server proxy); tiers Drifter→Elder, launch floor 80; the venue reads Heat, never computes it. Reputation: frontend/src/lib/detection/ (deployerReputation.ts, walletExposure.ts, deployerLaunches.ts, score.ts, metrics.ts, exclusions.ts) and the scanner in frontend/src/lib/scanner/ (scanner.ts + ethereumAdapter.ts/solanaAdapter.ts). None of it is served to third parties; no venue-signed attestations exist (heat/attestation.ts handles ISLAND attestations, pending the island publishing its signing key per ISLAND_WAVE_THREE_STATUS).

**The build:**

1) Precondition: F5 api host live (this is a paid product; it mounts there, never as a new Vercel function). F1 helps freshness (deployer launch histories) but v1 can run on the same RPC-derived paths the client libs use. 2) Extract the scoring code into a shared package — create packages/reputation/ holding the detection/, scanner/, and heat-client logic with its existing tests, imported by both frontend and the F5 host (avoid a fork of the scoring logic at all costs; one implementation, two consumers). 3) Endpoints on the F5 host: GET /v1/score/token/:chain/:address, /v1/score/deployer/:address, /v1/exposure/wallet/:address, /v1/heat/:address (a metered proxy of the island oracle — the venue still never computes Heat; pass through tier + held-time with the island's own freshness stamp). 4) Signed attestations: POST /v1/attest returns an EIP-712 signature over {subject, scoreModel, modelVersion, score, issuedAt, expiry} from a dedicated attestation key held only in the F5 host env (rotation per docs/SECRET_ROTATION.md); publish the verifying address in docs/API.md so integrators and contracts can verify. Never attest Heat itself as venue-originated — attest 'the island oracle reported X at T'. 5) Honesty-gating is the product: every response carries data-freshness and an explicit insufficient_data state for thin histories; the API must return 'no data' exactly where the in-app scanner would. 6) Pricing/metering rides F5 tiers; per-attestation surcharge.

**Done when:** 1) A keyed API score for a given token byte-matches the in-app scanner's score for the same inputs (shared-package test proves it). 2) An attestation verifies against the published key in a Foundry test via ecrecover. 3) A thin-history deployer returns insufficient_data, not a fabricated score. 4) Calls meter and bill through F5; unkeyed access is refused.

## F9 — Real-time & alerts — event stream, alert rules engine, Telegram transport

**Where it stands today:** Push sending exists: api/_lib/push.js (web-push with VAPID envs, graceful no-op when unset, dead-subscription pruning) and the push-subscriptions table from frontend/supabase/migrations/002. The only websockets in the app are the Nakamigos marketplace's third-party feeds (src/nakamigos/hooks/useActivityWebSocket.js and eventFeed.js). There is no venue event stream, no alert rules engine, no Telegram bot, and nothing consumes F1 (which itself is undeployed). VAPID prod keys are unverified until F2's operator step runs.

**The build:**

1) Preconditions: F1 deployed (the stream's source of truth); F2 for user identity + verified VAPID; F5/Railway host for the service. 2) Stream source: add Postgres triggers with NOTIFY on the F1 tables that matter (pair created, swaps over size, pause-state transitions, EpochDistributed, timelock ProposalCreated) plus the solana_ trade tables. 3) Fan-out: create realtime/ (Node/TS) on the Railway project — LISTEN on those channels, fan out over wss:// with per-connection topic subscriptions; heartbeat + last-event-id resume. Frontend: new src/lib/realtime/client.ts with reconnect/backoff and honesty-gating — a stale or dropped socket flips the UI to an explicit 'live feed disconnected' state; never render stale events as live (mirror the Nakamigos hooks' patterns, but venue-owned). First consumers: new-pair feed for the terminal, protocol-paused banners (replacing polling). 4) Alert rules engine: alert_rules table in Supabase (wallet via F2 SIWE, rule_type, params JSON, transports); the evaluator lives inside realtime/ consuming the same stream; v1 rule types: new pair, LP/lock unlock, whale swap > threshold, pause/unpause, epoch distributed, deployer-reputation change, Heat-tier change (via F8 polling). 5) Transports: web push by importing the _lib/push.js logic into the service (same VAPID pair — extract to a tiny shared module rather than HTTP-bouncing through Vercel), and a Telegram bot (grammY; env TELEGRAM_BOT_TOKEN) with chat linking via a SIWE-signed deep-link code so a chat id binds to a wallet. Idempotency: every alert delivery keyed by (rule_id, event_id) so restarts never double-fire. This bot is also F6's TG-signing transport shell and wave #52's substrate.

**Done when:** 1) A mainnet PairCreated reaches a subscribed browser over wss:// in under 5 seconds. 2) An alert rule fires exactly once per event across a forced service restart (idempotency verified), delivering both web push and Telegram. 3) Killing the socket flips consuming UIs to the explicit disconnected state within the heartbeat window. 4) A Telegram chat unlinks/relinks cleanly via a fresh SIWE-signed code.

---

# Part II — The waves


## Wave 1 — First money

Wave 1 turns the machine that already exists into revenue in the first weeks after year-plan Q1 lands (custody re-homed, SIWE login live, TWAP warm, F1 indexer wired). The ordering is strictly risk-ascending: first the pure-frontend fee configs (3, 38) that attach disclosed fee legs to aggregator parameters the venue already proxies — zero new contract surface, revenue on day one; then the switch-flip (35) that lights up the deployed-but-dark VoteIncentives/GaugeController pair behind the existing isDeployed() gates; then four small peripheries (2, 34, 65, 66) that are either verbatim forks with one-line deltas or Seaport-native constructions with no custom escrow, each gated by the F7 ceremony; and finally the API/SaaS lane (39, 40, 52, 43, 98), which monetizes the scanner, Heat attestations, and alert plumbing but is serialized behind F5 because the Vercel 12-function cap makes a paid API impossible on the current host. Shared risks across the wave: the treasury Safe is the fee sink for every off-chain-collected leg, so the F3 sweep into SwapFeeRouter→RevenueDistributor must be operating before fee volume accumulates; the honesty-gating law binds every item (net-of-fee quote ranking, indexed-truth-only alerts, fail-closed Heat attestations); and three items (2, 43, 40) carry external-party dependencies — Doppler Airlock whitelisting, ramp-partner KYB, and island-oracle uptime — that should be started in parallel on day one since they, not code, are the long poles.

### #2 — Graduation venue on the native DEX

**Preconditions:** F1 (indexer live — graduation rows need a consumer), F7 (audit wave + Safe deploy ceremony). Prior items: none, but ship after the pure-frontend fee configs (3, 38) since this is the wave's first contract deploy. Operator action: request Doppler Airlock module whitelisting from Whetstone (`setModuleState` for the new migrator) — without it `migrate()` reverts, exactly as documented in `contracts/src/v4/TegridyLiquidityMigrator.sol`.

**The build:** Contracts — create `contracts/src/TegridyV2GraduationMigrator.sol` by cloning the license posture and structure of the existing `v4/TegridyLiquidityMigrator.sol` (MIT `ILiquidityMigrator` + Airlock owner-getter interfaces, byte-identical error selectors), with one delta: on `migrate()`, create/fetch the pair via the live `TegridyFactory`, mint liquidity directly on `TegridyPair`, and send 100% of LP tokens to `address(0xdead)` — permanently locked, no owner, no state. Deploy script `contracts/script/DeployV2GraduationMigrator.s.sol` (mirror `DeployV4.s.sol` conventions). Frontend — register the migrator in `frontend/src/lib/launcher/doppler.constants.ts` and `config.ts`; surface "graduates to Tegridy DEX, LP burned" on `factSheet.ts` and `afterlife.ts`; discovery via `discovery.ts`. Data — add `graduation` table to `indexer/ponder.schema.ts` (token, pair, lpBurned, txHash) keyed off `PairCreated` + first mint.

**Fee wiring:** TegridyPair's existing 0.30% swap fee: 0.25% accrues to the burned LP (deepens the pool forever), ~0.05% protocol take mints to the factory `feeTo` (treasury) via `harvest()`, entering the established treasury→RevenueDistributor path. Payer: every post-graduation swapper. No new fee parameters.

**Gates:** Complies — minimal immutable periphery mirroring an already-written audited pattern; retaining graduated liquidity would be a rug, so the burn is mandatory. F7 adversarial audit before deploy. Honesty: fact sheet renders graduation state only from chain events; self-gates to "not graduated" otherwise. Flag-gated until one real launch graduates end-to-end.

**Done when:** (1) A mainnet launch graduates into a TegridyPair with LP verifiably at 0xdead; (2) `harvest()` moves protocol fee LP to feeTo; (3) indexer `graduation` row renders on the fact sheet.

### #3 — Ultra-Mode swap fee layer

**Preconditions:** None beyond year-plan Q1 — this is the wave's first ship: pure frontend + proxy config, zero contracts. Operator actions: register integrator/partner identities where required (Odos referral code, LiFi integrator string, ParaSwap partner), and designate the fee-collection address (treasury Safe) per aggregator.

**The build:** Frontend — in `frontend/src/lib/aggregator.ts`, add a `feeBps`/`feeRecipient` leg to each provider that supports native fee-on-top: LiFi (`integrator` + `fee` params), ParaSwap (`partnerAddress`/`partnerFeeBps`), KyberSwap (`feeReceiver`/`chargeFeeBy`), OpenOcean (`referrer`/`referrerFee`), Odos (registered `referralCode`). For CoW, author a new appData JSON with the `partnerFee` field in `frontend/src/lib/cowProtocol.ts` and pin its hash (the module already documents the hash-must-match rule). Build the Ultra toggle as `frontend/src/components/swap/UltraModePanel.tsx`, composing the existing `mevProtection.ts` (MEV Blocker RPC), CoW gasless route, and simulation; the raw 0-fee route stays one tap away in `TradePage.tsx`. Extend `routeSavings.ts` so rankings are computed NET of the venue fee — never let a fee-carrying quote outrank a better raw quote dishonestly. Backend — widen `allowedQuery` per provider CONFIG in `frontend/api/aggregator.js` to admit the new fee params (nothing else changes; the catchall stays consolidated per `api/SERVERLESS_BUDGET.md`).

**Fee wiring:** 0.25% default on Ultra routes, 0.5% on the gasless CoW path; payer is the swapper, disclosed inline pre-quote. Fees accrue at each aggregator's native fee mechanism to the treasury Safe; F3's sweep forwards the ETH leg into SwapFeeRouter→RevenueDistributor under the live stakerShareBps/polShareBps split.

**Gates:** Fully house-law compliant: zero new contracts, disclosed fee, raw route preserved. Honesty: fee shown before signing; net-of-fee quote ranking; no "best price" claim on Ultra.

**Done when:** (1) Each of the 5+ fee-capable aggregators returns quotes with the fee leg attached and disclosed; (2) a real Ultra swap lands fee at the treasury Safe; (3) raw 0-fee route still executes.

### #35 — Bribe market activation

**Preconditions:** F7 (verification, not a fresh audit — the contracts carry pass-8 audit fixes in-source). Prior items: none. Operator actions: confirm the dark mainnet `GaugeController`/`VoteIncentives` deployments byte-match current `contracts/src/` (the `constants.ts` ZEROED comments from 2026-05-31 predate the current src and are stale); if they don't match, redeploy via the existing `contracts/script/DeployGaugeController.s.sol` and `DeployVoteIncentives.s.sol` against live TegridyStaking, Safe ceremony per F7. Then Safe seeds gauges for target pairs and starts the epoch clock.

**The build:** This is a switch-flip: the entire UI already exists and gates on `isDeployed()`. Frontend — fill `GAUGE_CONTROLLER_ADDRESS` and `VOTE_INCENTIVES_ADDRESS` in `frontend/src/lib/constants.ts`; `GaugeVoting.tsx`, `components/community/VoteIncentivesSection.tsx`, `hooks/useBribes.ts`, `hooks/useGaugeList.ts` light up on their own. Add a single consolidated claim view (extend `VoteIncentivesSection.tsx`) listing claimable epochs per gauge. Defer external-market aggregation (Votium etc.) to a later wave — activation only. Data — add `gaugeVote`, `bribeDeposit`, `bribeClaim` tables to `indexer/ponder.schema.ts` off the contract's `BribeDeposited`/claim events so the epoch UI reads indexed truth, not RPC scans.

**Fee wiring:** `bribeFeeBps` default 300 (3%), skimmed at deposit from every bribe (payer: the briber), accrued in-contract under the H-03 pull pattern, withdrawn to treasury. Contract cap is 5% (`MAX_FEE_BPS`); a move toward Hidden Hand's 4% goes through the contract's own 24h-timelocked fee change — no code change.

**Gates:** DEBATABLE per the list — bribes monetize governance; ship it as vote incentives on emissions gauges only. Contracts are immutable and already written (Curve FeeDistributor pattern). Honesty: epoch UI self-gates to "no active gauges" until the Safe seeds them; never render projected APRs for bribe rounds.

**Done when:** (1) A real bribe deposits, is voted on, and claims across one full epoch; (2) 3% fee lands withdrawable by treasury; (3) UI shows only indexed epochs and hides projections.

### #38 — Cross-chain one-click swaps

**Preconditions:** Item 3 (the fee-param plumbing and proxy allowlist changes in `aggregator.ts`/`api/aggregator.js` land there). No contracts, no foundation blockers. Operator action: register the LiFi integrator string and set up fee-collection claiming on each chain.

**The build:** Frontend — extend `getLiFiQuote` in `frontend/src/lib/aggregator.ts` to accept `fromChain`/`toChain` (currently the meta-aggregator short-circuits on non-mainnet via `SUPPORTED_CHAIN_ID`; cross-chain quotes bypass that guard explicitly rather than weakening it), always passing `integrator` + `fee`. Widen `liFiResponseSchema` in `frontend/src/lib/schemas/aggregator.ts` for cross-chain estimates (duration, bridge steps). New `frontend/src/components/swap/CrossChainTab.tsx` mounted in `TradePage.tsx`: ETH-mainnet source leg via wagmi, Solana destination via the already-present wallet-adapter; destination-token pricing display via `frontend/src/lib/jupiter.ts`. Backend — in `frontend/api/aggregator.js`, extend the `lifi` CONFIG `matchPath` to admit `/v1/status` (post-send tracking) and `allowedQuery` for `fromChain`/`toChain`/`integrator`/`fee`. Poll LiFi status and render bridge progress honestly — LiFi's own estimates and states, never a synthesized "almost there".

**Fee wiring:** 0.25% integrator fee (LiFi pays it natively), payer is the swapper, disclosed pre-quote. Fees accrue in LiFi's per-chain FeeCollector under the integrator identity; operator claims EVM-side to the treasury Safe (F3 sweep → SwapFeeRouter → RevenueDistributor staker/treasury/POL split) and Solana-side to the Squads vault (`frontend/src/lib/launcher/solana/squads.ts` custody posture).

**Gates:** Compliant: zero contracts, battle-tested routing partner already integrated, fee disclosed. Honesty: transfers render LiFi's real status; failure states shown with the recovery link, never hidden; quote ranking stays net-of-fee. Flag-gate Solana-destination routes until three successful round-trips are verified.

**Done when:** (1) One signature moves ETH-mainnet funds into a Solana token with fee attached; (2) integrator fee is claimed to treasury on both chains; (3) a deliberately failed transfer renders its true LiFi status.

### #34 — DCA-into-yield

**Preconditions:** Item 3 (CoW appData partner-fee rail), F4 (keeper for schedule execution). Phase 2 (yield vault) additionally needs F7. Operator action: none for phase 1.

**The build:** Phase 1 — contract-free. Today `useDCA.ts`/`DCATab.tsx` schedule plain ETH→TOWELI buys client-side. Add a "park in yield" option: the unfilled budget is swapped once into wstETH (earning while idle), and each tranche sells wstETH via the existing CoW rails — for Safes, reuse the ComposableCoW conditional-order machinery in `frontend/src/lib/composableCow.ts` verbatim (it already honesty-gates EOAs to the single-signature path); for EOAs, the F4 keeper submits each due tranche as a CoW limit order via `useCowLimitOrder.ts` patterns. Extend `frontend/src/hooks/useDCA.ts` with the wstETH leg and `components/swap/DCATab.tsx` with the toggle; completed buys can auto-stake via `stakeBatch.ts`. Phase 2 (flag-gated, separate deploy): `contracts/src/TegridyDCAVault.sol` — a minimal ERC-4626 escrow (OZ 4626 verbatim base, minimal delta: keeper-executed fills + yield-skim on wstETH exchange-rate growth), script `DeployDCAVault.s.sol`, only after F7 audit. Data — DCA fill history table in `indexer/ponder.schema.ts` once fills settle on-chain.

**Fee wiring:** 0.1% per fill via the item-3 CoW partner-fee appData (payer: the DCA user, disclosed on schedule creation) → treasury Safe → F3 sweep → RevenueDistributor split. Phase 2 adds a 10% skim of realized idle-yield only (never principal), sent by the vault straight to RevenueDistributor's open `receive()` (100% to stakers under current stakerShareBps).

**Gates:** Phase 1 fully compliant (zero contracts; wstETH is battle-tested, immutable). Phase 2 is new surface — F7 adversarial audit mandatory, DELETE-before-ADD review against the existing client-side DCA. Honesty: display wstETH rate risk and that yield accrues to the user minus the disclosed skim; render only executed fills.

**Done when:** (1) A yield-parked schedule completes all tranches with 0.1% fees at treasury; (2) idle funds verifiably sit in wstETH between fills; (3) EOAs see the honest "keeper-submitted" labeling, Safes get true conditional orders.

### #43 — Fiat on/off-ramp

**Preconditions:** None technical — API/SaaS-lane item but it needs no F5; ship whenever partner onboarding completes. Operator actions (the long pole): MoonPay and/or Transak partner accounts, KYB review, fee-share config in their dashboards, payout destination set to the operating entity.

**The build:** Frontend — new `frontend/src/components/RampWidget.tsx` embedding the MoonPay widget (Transak as fallback) as an iframe, mounted at swap entry (`TradePage.tsx`, `SolanaSwapPage.tsx`) and on `LaunchTokenPage.tsx` for the "no funds" state; prefill wallet address and target asset only — never personal data. Update the CSP in `frontend/vercel.json` with `frame-src` for `buy.moonpay.com`/`global.transak.com` (no `connect-src` change — the iframe talks to its own origin). Backend — MoonPay requires server-side URL signing with the secret key: add `frontend/api/_lib/ramp-sign.js` dispatched from the aggregator catchall as `?resource=ramp-sign` behind a lazy import (identical pattern to `api/_lib/heat.js`; function count unchanged per `api/SERVERLESS_BUDGET.md`). Env: `MOONPAY_SECRET_KEY` (server), `VITE_MOONPAY_PUBLISHABLE_KEY` (client). Rate-limit via `api/_lib/ratelimit.js`. Data — none; the venue never sees KYC or card data.

**Fee wiring:** 0.5–1% partner fee configured in the provider dashboard, paid by the ramp user on top of MoonPay's own fee, paid out by the provider to the operating entity off-chain → treasury. No on-chain split — declare this fee line treasury-only (off-chain revenue cannot honestly flow through RevenueDistributor).

**Gates:** Compliant: zero contracts, zero custody, KYC/licensing risk carried entirely by the licensed partner. Prohibited-actions note: the venue embeds the widget; users enter payment details with the provider directly. Honesty: render the provider's full fee breakdown including our partner fee; never label ramp quotes as exchange rates. Flag-gate per-geo per provider availability.

**Done when:** (1) A real card purchase lands tokens in a user wallet through the widget; (2) partner-fee revenue appears in the provider dashboard; (3) CSP passes with no new violations in console.

### #65 — Airdrop factory

**Preconditions:** F1 (holder snapshots from the indexer), F7 (audit + deploy ceremony). Heat targeting needs nothing new — `api/_lib/heat.js` already proxies the oracle. Operator action: none beyond ceremony.

**The build:** Contracts — vendor Uniswap's `merkle-distributor` VERBATIM (exact commit, MIT, diff-guard per F7 intake) into `contracts/lib/`, then add `contracts/src/AirdropFactory.sol`: OZ Clones factory stamping immutable, ownerless distributors; the sole delta on the distributor is a payable `claim()` requiring a flat `claimFeeWei` fixed at campaign creation, forwarded on. Deploy script `contracts/script/DeployAirdropFactory.s.sol`. Backend — `frontend/api/_lib/airdrop.js` behind the catchall (`?resource=airdrop`, lazy import): builds Merkle trees from indexer holder snapshots with optional Heat-floor filtering (anti-sybil upsell; Heat read via the existing heat resource, attributed to the island with reckoning date). Frontend — new `frontend/src/pages/AirdropPage.tsx` (create + claim views), `frontend/src/lib/airdrop/` (client-side tree verification so claimants can independently verify their proof), route in `App.tsx` + `navConfig.ts`. Data — `airdropCampaign` and `airdropClaim` tables in `indexer/ponder.schema.ts`.

**Fee wiring:** ~0.0005 ETH per claim (≈$1–2, the Sablier comparable), payer: claimant, at `claim()`. The distributor forwards fee ETH directly to `RevenueDistributor`'s open `receive()` (verified bare-payable), so it distributes to stakers next epoch under current stakerShareBps=10000. Optional creation fee to treasury, disclosed.

**Gates:** Compliant: verbatim battle-tested fork, minimal delta (one payable gate), immutable, ownerless. F7 adversarial audit on the delta + factory. Honesty: campaign pages render only on-chain claim state; targeting criteria (Heat floor, snapshot block) printed on every campaign; unclaimable wallets told exactly why. Heat is displayed as the island's measurement, never re-tiered.

**Done when:** (1) A campaign with 1,000+ leaves deploys, claims succeed with proofs verified client-side; (2) claim fees arrive at RevenueDistributor and distribute; (3) a Heat-floor-filtered snapshot excludes sub-floor wallets verifiably.

### #66 — P2P OTC escrow desk

**Preconditions:** F2 (SIWE login live — the orderbook writes are identity-gated), existing `api/orderbook.js` + Supabase orderbook. No contracts, no audit wave. Operator: none.

**The build:** Extend the existing Seaport P2P trade SDK — `frontend/src/nakamigos/lib/trades.js` already settles two-sided trades through canonical Seaport with zero custom escrow (the documented Dec-2023 NFT Trader lesson: the only on-chain surface is Seaport + conduit). Seaport natively supports ERC-20 offer/consideration items, so token blocks need no new contract. Build `frontend/src/lib/otc/` (TypeScript, outside the nakamigos tree): order construction for TOKEN-block vs WETH/USDC/native-ETH legs, reusing the maker-WETH rule and named-taker soft pin from `trades.js`; add the protocol fee as an extra Seaport consideration item. Backend — extend `frontend/api/_lib/seaport-verify.js` to validate ERC-20 offer structures and the mandatory fee item before an order is accepted into the orderbook; reuse `api/orderbook.js` storage with a `kind: otc` discriminator. Frontend — new `frontend/src/pages/OTCPage.tsx` (route in `App.tsx`/`navConfig.ts`): deep-linkable trade windows, both-sides preview, and a mandatory price-context panel showing the TegridyTWAP/aggregator mid so neither party trades blind; hard warning banner when the block prices >10% off-market. Data — settled OTC fills recorded via the existing orderbook flow; add an indexer view later.

**Fee wiring:** 0.5% of the cash leg as a Seaport consideration item, payer: effectively split into the price, visibly itemized. WETH/ETH fee legs point at the treasury Safe → F3 sweep → SwapFeeRouter → RevenueDistributor split; stablecoin legs to treasury for conversion.

**Gates:** Compliant: zero new contracts, canonical Seaport as escrow, DELETE-before-ADD honored by extending the built module. Honesty: price context is mandatory render, not optional; orders missing the fee item are rejected server-side, not silently repaired.

**Done when:** (1) An ERC-20 block trade settles atomically through Seaport with the fee item paid; (2) server rejects a fee-stripped order; (3) the off-market warning fires on a mispriced test order.

### #52 — Alerts Pro

**Preconditions:** F1 (indexed event stream), F2 (SIWE + VAPID push live — `api/_lib/push.js` is written, needs keys set), F9 (rules engine + Telegram transport + the off-Vercel delivery worker), F5 for Stripe billing of the standalone tier. PremiumAccess (live mainnet) covers the bundled tier immediately. Operator: generate VAPID keys, provision the F9 worker host.

**The build:** Backend — alert-rule CRUD as `frontend/api/_lib/alerts.js` behind the catchall (`?resource=alerts`, lazy import per `SERVERLESS_BUDGET.md`), rules stored in Supabase under RLS keyed to the SIWE identity. Delivery runs on the F9 worker (never Vercel functions): it consumes the F1 stream and fires web-push via `api/_lib/push.js` semantics plus Telegram via F9 transport. Rule types, all from indexed truth: whale transfers over threshold, LP unlock/locker-stream events (`lockerStream.ts` shapes), deployer-reputation changes (recompute `frontend/src/lib/detection/deployerReputation.ts` on new launches), launch go-lives (the births/launch-radar feeds in `api/_lib/births.js` / `launch-radar.js`), Heat-tier changes (via the heat resource, attributed to the island with reckoning date). Frontend — new `frontend/src/pages/AlertsPage.tsx` generalizing the `usePriceAlerts.ts` pattern into a rules builder; gate premium rule counts via `usePremiumAccess.ts`.

**Fee wiring:** Bundled tier: the existing PremiumAccess `monthlyFeeToweli`, payer: subscriber, TOWELI to treasury (live contract, no change). Standalone $5–15/mo via F5 Stripe → treasury, declared off-chain/treasury-only — no staker split on fiat revenue.

**Gates:** Compliant: zero contracts. Honesty is the product: alerts fire only on confirmed indexed events; every alert carries the block/tx it derives from; no speculative or predictive alerts, ever — loss-prevention framing only. Heat alerts self-gate when the oracle is unreachable. Flag-gate Telegram transport until F9 receipt discipline is proven.

**Done when:** (1) A whale-transfer rule fires a push within one minute of the indexed event; (2) rules are invisible cross-user under RLS; (3) a paying PremiumAccess holder gets premium rule slots and a free user is capped.

### #39 — Trust & scanner API SaaS

**Preconditions:** F5 is a hard prerequisite (API keys, metering, billing, and the serverless-budget escape — this cannot live under the 12-function cap). F1 for indexed launch/afterlife data. Prior items: none. Operator: Stripe account, API host provisioning, published pricing page.

**The build:** Backend — extract the pure scoring modules into a shared workspace package `packages/trust-core` consumed by both the frontend and the F5 API host: `frontend/src/lib/scanner/` (scanner.ts + ethereumAdapter/solanaAdapter), `frontend/src/lib/detection/` (score.ts, metrics.ts, deployerReputation.ts, walletExposure.ts, exclusions.ts), and `frontend/src/lib/launchSim/`. These are already pure TS — the extraction is a move, not a rewrite (DELETE-before-ADD: the frontend re-imports from the package, no duplication). Serve on the F5 host: `GET /v1/scan/token/:chain/:address`, `GET /v1/deployer/:address`, `GET /v1/wallet-exposure/:address`, `POST /v1/launch-sim`. Metering via Upstash counters (reuse the `api/_lib/ratelimit.js` pattern), keyed tiers $99/$499/$2k monthly + per-call overage. Scanner RPC reads go through the venue's own Alchemy keys with the `alchemy-failover.js` discipline. Frontend — extend `docs/API.md` and add a public docs page (extend the existing `api/v1/index.js` doc style). Data — response cache tables on the F5 host, TTL-stamped.

**Fee wiring:** Stripe subscriptions + overage, payer: integrator, revenue → treasury (off-chain, treasury-only — no staker split on fiat). No on-chain fees.

**Gates:** Compliant: zero contracts, productizes only self-computed scores from own RPC reads — no third-party data resale. Honesty-gating is the moat: every response carries `computedAt`, input provenance, and a hard `"insufficient_data"` state for unindexed tokens — never a fabricated score. Rate-limit anonymous probes to zero (keyed access only).

**Done when:** (1) A keyed customer scans a token and hits the same score the ScannerPage renders; (2) metering bills overage correctly on a test account; (3) an unindexed token returns `insufficient_data`, not a number.

### #40 — Reputation credit API (Heat-as-a-product)

**Preconditions:** F5 (keys/metering/billing + host — same platform as item 39, ship immediately after it), F8 (this item IS F8's first productization), item 39's `packages/trust-core` extraction. Operator: generate the venue attester keypair, store it only on the F5 host (`ATTESTER_PRIVATE_KEY`), publish the attester address.

**The build:** Backend — on the F5 host, `GET /v1/reputation/:address` returning a composite report: Heat (read live through the same upstream the display-grade `frontend/api/_lib/heat.js` uses — but this endpoint implements the fail-closed semantics that file explicitly declines: no fresh oracle read, no report), deployer reputation, and wallet exposure from `trust-core`. `POST /v1/attest` returns the same report as an EIP-712 signed attestation (typed struct: subject, heatDegrees, heatTier, reckoningDate, deployerScore, exposureFlags, issuedAt, expiry) — reuse the attestation shapes already in `frontend/src/lib/heat/attestation.ts` and `certification.ts`, and the fail-closed discipline proven in `attestation.failClosed.test.ts`. Consumers verify via ecrecover on- or off-chain; no venue contract needed. Frontend — a docs/integration page plus an attestation-verify widget on `TrustHubPage.tsx`. Data — attestation issuance log on the F5 host for revocation lists.

**Fee wiring:** Per-query pricing (e.g. $0.005/query metered) + per-attestation fee (e.g. $0.05), payer: integrating protocol, Stripe → treasury (off-chain, treasury-only). Zero on-chain fees.

**Gates:** The honesty boundary is absolute and inherited from `heat.js`: Heat is the island's measurement — the attestation states "Heat as read from the Jungle Bay Island oracle at reckoning date T", never a Tegridy score; no averaging, no re-tiering. Fail-closed: unreachable oracle means no attestation, not a stale one. Unproven revenue category — flag-gate pricing, launch with 3 design partners before public pricing.

**Done when:** (1) An attestation verifies via ecrecover against the published attester address; (2) killing the Heat upstream makes `/v1/attest` refuse (not stale-serve); (3) a metered customer is billed per query.

### #98 — Streaming payroll & grants

**Preconditions:** F2 (SIWE identity for the grants board UX). CommunityGrants is deployed-but-dark — activating it is an operator switch-flip alongside this item. Operator: Safe decides the first grants cohort; verify canonical Sablier Lockup addresses on mainnet against Sablier's deployments registry.

**The build:** Integrate, do not fork: use the canonical, audited, immutable Sablier Lockup contracts already live on mainnet — zero new contract surface, which is why this NET+/near-zero-revenue item is allowed in a money wave at all. Frontend — new `frontend/src/lib/streams/` (sablier.ts: create LockupLinear streams, withdraw, cancel, renounce; typed against Sablier's published ABI, address-pinned with a selector test in the style of `airlockSelectors.test.ts` — the repo has been burned twice by stale SDK ABIs, per `integratorFees.ts` and `LockerClaimer.sol`). Extend `frontend/src/components/community/GrantsSection.tsx` so grants pay out as streams the treasury Safe creates, and add a payroll view for launched-project teams (entry from the launcher fact-sheet). Route/nav in `App.tsx` + `navConfig.ts`. Data — `stream` table in `indexer/ponder.schema.ts` off Sablier's `CreateLockupLinearStream`/`WithdrawFromLockupStream` events filtered to venue-originated streams (funder or broker match).

**Fee wiring:** Sablier's create functions accept a native `broker` field: set broker = treasury Safe with a 0.25% broker fee on deposit, payer: stream creator, disclosed at creation. Revenue expectation is honestly near-zero (Sablier comparable ~$36K/yr) — this completes the toolset; do not project income from it.

**Gates:** Fully compliant: battle-tested external contracts, immutable, no fork, no custody. Grants comply with "may not spend capital it has not earned": streams are funded only from realized treasury revenue. Honesty: stream state rendered exclusively from chain; cancellable streams labeled cancellable.

**Done when:** (1) A treasury-funded grant streams and the grantee withdraws mid-stream; (2) the 0.25% broker fee lands at treasury on creation; (3) the selector-pin test fails CI if the Sablier ABI drifts from deployed bytecode.


## Wave 2 — The terminal complex

Wave 2 assembles the flagship revenue bet: a safety-scored trenches terminal that owns the richest fee category in crypto apps (Axiom ~$139M/yr comps) by stacking what the repo already has — the F1 indexer feed, the scanner/deployer-reputation/Heat scoring stack, the 7-aggregator meta-router, and the live SwapFeeRouter->ReferralSplitter->RevenueDistributor fee spine. Build order is dependency order: the terminal core (1) proves the feed and ships the shared F3 terminal fee leg; Solana turbo execution (49) makes fills competitive; the referral engine (9) buys distribution out of the same fee flow; trigger orders (16) and charting (47) deepen retention; MEV recapture (17) converts extraction into rebates and earned arb revenue; the Telegram bot (5) and copy-trading (7) resell the same execution backend through new surfaces; the mobile wrap (46) multiplies every line. Shared risks: the single 0.75–1% fee-on-top leg (one contract, one audit wave — every sibling reuses it, so a bug taxes the whole wave), the Vercel 12-function cap (everything backend goes through the aggregator catchall until F5's escape), Solana revenue custody (Squads, off-chain splits until a program exists — must stay honesty-labeled), and the non-custodial line on the TG bot, which is a house-law red line, not a preference.

### #1 — Memecoin Pro Terminal

**Preconditions:** F1 live (Ponder deployed + hosted, GraphQL client, Solana DBC leg, websocket new-pair feed), F3 fee-on-top leg spec, F7 audit pipeline for the fee contract. Operator: fund keeper/relayer gas, confirm Heat oracle uptime SLA with Jungle Bay Island.

**The build:** Contracts — create `contracts/src/TegridyTerminalFeeRouter.sol` as a near-verbatim fork of the live, audited `contracts/src/SwapFeeRouter.sol` (same `OwnableNoRenounce`/`PauseGuardian`/`WETHFallbackLib` base, same timelocked split machinery, `MAX_FEE_BPS = 100`); minimal delta: a generic `chargeAndForward` fee-on-top entry that skims ETH before handing calldata to any allowlisted aggregator target, still calling `IReferralSplitter.recordFee(user)`. Deploy script `contracts/script/DeployTerminalFeeRouter.s.sol`. Frontend — new `frontend/src/pages/TerminalPage.tsx` + `frontend/src/components/terminal/` (PairTable, RowScoreBadges, QuickBuyPanel, PositionsPanel). Rows stream from the F1 websocket feed for venue pairs and the existing market-wide `frontend/api/_lib/launch-radar.js` catchall resource (keep its honesty boundary: separately-labelled sections). Score every row with `frontend/src/lib/scanner/scanner.ts`, `frontend/src/lib/detection/deployerReputation.ts`, and `frontend/src/lib/heat/heatClient.ts`. One-click buy: EVM via `frontend/src/lib/aggregator.ts` routes wrapped by TerminalFeeRouter; Solana via `frontend/src/lib/jupiter.ts` platform-fee path (fee-ATA set in `frontend/src/lib/solana.ts`). Data — indexer tables for pair creation, swaps, and per-pair rolling stats in `indexer/ponder.schema.ts`.

**Fee wiring:** 0.75% fee-on-top per terminal trade, paid by the trader. EVM: TerminalFeeRouter -> ReferralSplitter -> RevenueDistributor, split per SwapFeeRouter invariants (stakers >=50%, POL <=25%, treasury remainder). Solana: fee-ATA -> Squads treasury via `frontend/src/lib/launcher/solana/feeCustody.ts` custody path.

**Gates:** Honesty-gating: rows missing scanner/reputation/Heat data render explicit "no data" badges — never a synthesized score. Fee disclosed in the quote line pre-sign. F7 adversarial audit of TerminalFeeRouter before deploy; Solana side ships fee-ATA-only (no new program). Flag-gated: auto-approve settings stay off until 30 days incident-free.

**Done when:** (1) New venue pair appears as a scored row within 5s of on-chain creation; (2) one-click buy on both chains settles with the fee itemized in the receipt; (3) a terminal-originated fee is claimable by a staker from RevenueDistributor; (4) zero fabricated-score renders in the honesty test suite (extend `frontend/src/pages/revenueClaimHonesty.test.ts` pattern).

### #49 — Solana turbo execution

**Preconditions:** Item 1 live (terminal is the buyer of this backend). F1 Solana leg for fill telemetry. Existing `frontend/api/solrpc.js` proxy and `frontend/src/lib/jupiter.ts`. Operator: pick Jito block-engine region(s), fund the Squads fee account.

**The build:** No contracts, no new Solana program (both mainnet program IDs are closed; this deliberately avoids redeploy). Backend — new catchall resource `frontend/api/_lib/jito.js`, dispatched via `?resource=jito` with lazy import (same pattern documented at the top of `frontend/api/_lib/launch-radar.js`; respects the 12-function cap per `frontend/api/SERVERLESS_BUDGET.md`). It proxies two things server-side: the Jito tip-floor percentile feed, and `sendBundle` to the block engine. Env vars: `JITO_BLOCK_ENGINE_URL`, `JITO_TIP_ACCOUNTS`. Rate-limit via `frontend/api/_lib/ratelimit.js`. Frontend — new `frontend/src/lib/turbo/` module: `tipTuner.ts` (auto-tune tip from live percentile + urgency setting), `bundle.ts` (assemble swap tx + tip transfer into a Jito bundle), `retry.ts` (blockhash-aware resubmit with bounded attempts and terminal receipts — F4 retry/receipt discipline). Wire into the terminal's Solana buy path in `frontend/src/components/terminal/QuickBuyPanel.tsx`; Jito-only submission is the anti-sandwich mode (bundles skip the public mempool). Fall back to plain `solrpc.js` send when Jito is unreachable, labeled as such. Data — indexer/Supabase telemetry table for land-rate and tip-paid stats (rendered only from real submissions).

**Fee wiring:** Tips pass through at cost + a disclosed 15% turbo markup (within the 10–25% band), paid by the trader as extra lamports in the tip transfer, landing in the Squads-held fee account from `frontend/src/lib/launcher/solana/squads.ts` custody. Terminal 0.75% leg (item 1) is unchanged and separate. Splits: Solana revenue accrues to Squads treasury; staker/POL conversion is a manual, published treasury operation until a Solana revenue rail exists.

**Gates:** House law: no capital spent that isn't earned — tips are always user-funded. Honesty: receipts show actual tip, markup, and landed slot; land-rate stats self-gate to "no data" below a minimum sample. No audit wave needed (no contracts); F7 review of the catchall resource only.

**Done when:** (1) Turbo buy lands via bundle with tip+markup itemized in the receipt; (2) Jito outage degrades gracefully to labeled normal send; (3) measured land-rate dashboard populates from real submissions only.

### #9 — On-chain referral engine

**Preconditions:** F2 (SIWE live, Supabase RLS verified) for link attribution; F3; item 1's TerminalFeeRouter deployed. The core contract already exists live on mainnet: `contracts/src/ReferralSplitter.sol` (SwapFeeRouter already calls `recordFee`).

**The build:** Contracts — zero new deploys on EVM. Two timelocked config ops: (a) raise `referralFeeBps` toward the 20–30% band via `proposeReferralFeeChange` (hard cap `MAX_REFERRAL_FEE = 3000`; the doc's 35% top end is unreachable on-chain — consciously cap at 30% rather than amend an audited immutable); (b) point TerminalFeeRouter's splitter at the same ReferralSplitter so terminal and swap referrals share one ledger. Tier boosts already exist: `MIN_REFERRAL_STAKE_POWER` (1000e18 voting power) via `votingPowerOf` — layer Heat-tier bonuses off-chain as fee rebates to the *referred* user, not by touching the contract. Backend — new catchall resource `frontend/api/_lib/referral.js` (`?resource=referral`, lazy import): mints short ref codes mapped to addresses in a Supabase table (RLS: owner-writes only), resolves code->address at trade time. Frontend — new `frontend/src/lib/referral.ts` (code capture from URL, localStorage persistence, one-time on-chain `registerReferrer` prompt); extend `frontend/src/components/ReferralWidget.tsx` with earnings from the F1-indexed `recordFee` events; add referral tables to `indexer/ponder.schema.ts`. Solana — off-chain accrual ledger over F1-indexed DBC/terminal trades, paid weekly from Squads; label it "accrued off-chain, paid weekly," never as on-chain.

**Fee wiring:** No new fee. Reallocates 20–30% of a *referred* user's existing fees (terminal 0.75%, swap legs) to the referrer inside ReferralSplitter before the residual flows to RevenueDistributor stakers/POL/treasury on the standard split. Referrers claim ETH directly from ReferralSplitter.

**Gates:** House law: EVM on-chain ledger is canonical (immutable, already audited); the only deltas are timelocked params + one catchall resource. Honesty: earnings dashboards render solely from indexed events; Solana accruals carry the off-chain label. Sybil note: `MIN_REFERRAL_STAKE_POWER` is the anti-farm gate — do not waive it.

**Done when:** (1) A ref-link signup registers on-chain and the referrer's cut appears in the next `recordFee`; (2) referrer claims ETH from ReferralSplitter; (3) widget totals match indexer-derived totals exactly; (4) terminal fees flow through the same splitter as swap fees.

### #16 — Trigger orders (SL/TP/trailing)

**Preconditions:** F4 keeper network (trigger engine, retry/receipt discipline), F1 price feeds (indexer candles + `contracts/src/TegridyTWAP.sol` on-chain), F6 scoped session keys for the EOA path, item 1 fee leg live.

**The build:** Contracts — none new for the Safe path: use CoW's canonical ComposableCoW deployments with the audited StopLoss conditional-order handler from cowprotocol/composable-cow, verbatim addresses only (same pattern as the TWAP handler already wired in `frontend/src/lib/composableCow.ts`). Extend that module with the StopLoss `Data` struct encoding, keeping its existing honesty note: ERC-1271/Safe wallets only — EOAs self-gate. EOA path: F4 keeper executes a user's pre-authorized order through TerminalFeeRouter under an F6 session key scoped to {router address, token pair, max size, expiry} — the session-key validator contract goes through the F7 audit wave. Solana path: F4 Jito-aware keeper watches the F1 DBC/pool price stream and fires via `frontend/src/lib/jupiter.ts` + item 49's turbo module, using pre-signed durable-nonce transactions (user signs at order creation; keeper only submits — no delegated authority). Frontend — new `frontend/src/components/swap/TriggerOrderTab.tsx` (SL/TP/trailing/OCO builder) alongside the existing `LimitOrderTab.tsx`/`TwapOrderPanel.tsx`; extend `frontend/src/hooks/useCowLimitOrder.ts` patterns into `useTriggerOrders.ts`. Data — trigger-order table in Supabase (RLS, owner-only) + execution receipts indexed via F1.

**Fee wiring:** 0.1% per *triggered execution* (Jupiter Trigger's exact rate), paid by the order owner from proceeds, routed through TerminalFeeRouter -> ReferralSplitter -> RevenueDistributor on the standard stakers >=50% / POL <=25% / treasury split. Untriggered orders cost nothing.

**Gates:** NET+, no law amendment. Honesty: order UI states the trigger price source (TWAP/indexer), staleness bound, and "keeper execution is best-effort, not guaranteed fills"; Solana durable-nonce expiry displayed. F7 audit of the session-key validator before EOA path enables; Safe/ComposableCoW path can ship first, EOA path flag-gated behind it.

**Done when:** (1) A stop-loss fires on both chains within the stated slippage on a live test token; (2) the 0.1% fee appears in RevenueDistributor accounting; (3) canceling an order provably revokes keeper authority (nonce advanced / session key expired); (4) unfilled orders show honest "not triggered" receipts.

### #47 — Pro charting workspace

**Preconditions:** F1 (indexer hosting + GraphQL client + Solana DBC trade leg) — candles are the whole build; item 1 terminal for trade-from-chart. `lightweight-charts` v5 is already in `frontend/package.json`.

**The build:** Data — add OHLCV aggregation to the indexer: `candle_1m` / `candle_15m` / `candle_1h` / `candle_1d` tables in `indexer/ponder.schema.ts`, filled from `TegridyPair` Swap events in `indexer/src/index.ts` (price from reserve deltas, TWAP-checked against `contracts/src/TegridyTWAP.sol`) and from the F1 Solana leg for curve/DBC tokens. Serve via the existing GraphQL surface in `indexer/src/api/index.ts` — no Vercel function spent. Frontend — refactor `frontend/src/components/chart/PriceChart.tsx`: venue tokens read own-indexer candles (source-labeled "Tegridy indexer"); foreign tokens keep the existing GeckoTerminal path, labeled. New `frontend/src/components/chart/ProWorkspace.tsx`: multi-pane layout grid (persisted per-user via F2 Supabase profile), indicator set (EMA/VWAP/RSI/volume — computed client-side from candles, no fake series), and PnL overlay computed from the wallet's F1-indexed fills. Trade-from-chart embeds item 1's `QuickBuyPanel` with price-click prefill; SL/TP lines create item 16 trigger orders by drag. Premium gate: multi-layout + PnL overlay behind `contracts/src/PremiumAccess.sol` `hasPremiumSecure`, checked via `frontend/src/lib/premiumBenefits.ts`; single free chart stays free.

**Fee wiring:** No per-trade fee of its own. Revenue is the premium subscription ($10–30/mo band) paid on-chain through the already-live PremiumAccess contract; proceeds follow PremiumAccess's existing treasury wiring. Trades placed from the chart pay the normal item 1 / item 16 legs.

**Gates:** NET+, no amendment. Honesty is the hard gate: no synthetic candles ever — gaps render as gaps; pre-indexer history shows "no data before <deploy block>"; PnL overlay renders only from indexed fills, self-gating to empty for unindexed wallets. Candle-vs-Gecko divergence beyond tolerance triggers a visible data-quality banner, not silent smoothing.

**Done when:** (1) A venue token chart renders from own indexer and matches GeckoTerminal within tolerance on overlapping ranges; (2) a trade and a trigger order execute from the chart; (3) premium gating verifies on-chain and free tier still works; (4) honesty tests confirm zero synthetic-candle paths.

### #17 — MEV recapture auction

**Preconditions:** F3, F4 keeper. Existing modules do half the work: `frontend/src/lib/mevProtection.ts` (MEV Blocker /fast builder, EIP-3085 user-consent flow) and `frontend/src/hooks/useMevProtection.ts`; Solana anti-sandwich is item 49's Jito-only submission.

**The build:** Two honest phases — do not build a bespoke order-flow auction. Phase A (user rebates, ship immediately): make MEV Blocker `/fast` the default suggested RPC inside the terminal's EVM flow by extending `useMevProtection.ts` and surfacing the prompt in `frontend/src/components/swap/MevProtectionPanel.tsx` and item 1's QuickBuyPanel — users receive ~90% of backrun value per MEV Blocker's existing auction; the wallet prompt stays user-confirmed (the module's EIP-3085 honesty stance is already correct — keep it). Phase B (venue revenue, the actual "recapture"): a F4 keeper that atomically backruns large fills on *own* `TegridyPair` pools — capturing the arbitrage that external searchers currently take from venue liquidity. Contracts: `contracts/src/TegridyBackrunner.sol`, a minimal-surface periphery forked from the standard atomic two-pool arb pattern, immutable, callable only by the keeper allowlist, profits force-forwarded — no custody, no user funds ever touched. Deploy script `contracts/script/DeployBackrunner.s.sol`. Data — rebate/backrun receipts table via F1 so the UI can show measured, not estimated, numbers (follow the `frontend/src/lib/routeSavings.ts` measured-only precedent).

**Fee wiring:** No user fee. Phase A value flows user-ward (rebates from MEV Blocker's auction go to the tx sender). Phase B backrun profit is earned revenue: TegridyBackrunner forwards ETH proceeds to RevenueDistributor via the SwapFeeRouter split discipline (stakers >=50% / POL <=25% / treasury), keeper gas reimbursed from proceeds first — never from treasury capital.

**Gates:** Real-yield law satisfied: arb profit is earned, and the keeper only spends gas it recoups from realized proceeds (skip the backrun if simulation shows profit < gas — "may not spend capital it has not earned"). Honesty: display only measured rebates/backrun totals; zero data renders "no data." F7 audit wave for TegridyBackrunner; Phase B flag-gated until audited.

**Done when:** (1) Terminal EVM sends default through /fast after user approval and a real rebate receipt renders; (2) a keeper backrun lands on a venue pair with profit visible in RevenueDistributor; (3) simulation-negative backruns provably no-op.

### #5 — Telegram trading bot

**Preconditions:** F6 is the hard gate — scoped session keys (spend caps + expiry) and the Telegram delegated-signing flow, non-custodial only. Also F5's serverless-budget escape (the bot webhook + F4 keeper loop cannot fit the Hobby 12-function cap — this is the first item that *requires* Vercel Pro or the dedicated api host), F9 Telegram transport, items 1 + 49 as the execution backend.

**The build:** Contracts — none new beyond F6's session-key validator (audited in F7's wave for item 16; reuse it identically — session keys scoped to {TerminalFeeRouter, allowlisted tokens, per-tx and daily spend caps, expiry}). Backend — bot service on the F5 host: Telegram webhook handler, command router (buy/sell/positions/scan), and a signer-less executor that submits only user-pre-authorized session-key operations (EVM 4337 userOps via F6's paymaster) or, on Solana, transactions the user signs themselves in the Mini App — the server never stores or touches a private key, ever. Env: `TELEGRAM_BOT_TOKEN`, F6 bundler/paymaster endpoints. Frontend — Telegram Mini App at `frontend/src/tgapp/` (new route reusing item 1's terminal components: RowScoreBadges, QuickBuyPanel) where wallet creation/signing happens client-side via F6 embedded wallets; inline scanner cards reuse `frontend/src/lib/scanner/` output with Heat warnings from `frontend/src/lib/heat/heatClient.ts`. Data — F9 alert rules push fills/triggers back into the chat; session-key grants and revocations indexed via F1.

**Fee wiring:** 1% per bot-originated trade (top of the 0.5–1% band — bot convenience premium), paid by the trader, routed through the same TerminalFeeRouter -> ReferralSplitter -> RevenueDistributor path (stakers >=50% / POL <=25% / treasury). Referral engine (item 9) attaches automatically since it's the same splitter. Solana bot trades pay item 49's turbo markup to Squads.

**Gates:** The ⚠ custody risk resolves by construction, not amendment: non-custodial is a hard requirement — any design where the server can sign or recover user keys is prohibited; write this into the bot's SECURITY doc as binding. Honesty: every quote shows fee + tip line items; scanner "no data" states carry into chat cards. F7 review of the delegated-signing flow before launch; sell-side session keys flag-gated after buy-side proves out.

**Done when:** (1) A user buys from Telegram under a session key with caps enforced on-chain; (2) revoking in the Mini App provably kills the bot's ability to execute; (3) a design-review checklist confirms no server-side key material; (4) bot fees appear in RevenueDistributor.

### #7 — Copy-trading engine

**Preconditions:** F1 (full wallet fill history — the leaderboard's only truth source), F4 trigger engine, F2 profiles, F6 session keys (audited via items 16/5), item 1 terminal live.

**The build:** Data first — leaderboard tables in `indexer/ponder.schema.ts`: per-wallet realized PnL, win rate, and hold-time computed strictly from indexed venue fills (extend `indexer/src/index.ts` handlers); surface deployer-reputation cross-checks from `frontend/src/lib/detection/deployerReputation.ts` so known deployer wallets are labeled, not ranked as "smart money." Backend — catchall resource `frontend/api/_lib/copytrade.js` (`?resource=copytrade`, lazy import per `frontend/api/SERVERLESS_BUDGET.md`): follow-list CRUD in Supabase under RLS (owner-only rows); the mirroring loop itself runs on the F4 keeper host, subscribed to the F1 event stream for leader fills. Execution — follower pre-authorizes an F6 session key scoped to {TerminalFeeRouter, max per-trade size, max daily notional, slippage bound, token allowlist/denylist, expiry}; keeper mirrors leader entries and exits within those caps via item 1's EVM route or item 49's Solana turbo path. Contracts — `contracts/src/CopyFeeSplitter.sol`, a verbatim structural fork of the live `contracts/src/ReferralSplitter.sol` (same base contracts, same claim flow) with one delta: `recordFee(leader)` credits the copied wallet instead of a referrer; deploy script `contracts/script/DeployCopyFeeSplitter.s.sol`. Frontend — `frontend/src/pages/CopyTradingPage.tsx` + `frontend/src/components/terminal/CopyPanel.tsx` (leader cards, follow config, live latency badge).

**Fee wiring:** 1% per copied trade, paid by the follower, into TerminalFeeRouter; CopyFeeSplitter peels a 20% leader share (within `MAX_REFERRAL_FEE`-style 30% cap) claimable on-chain by the leader; residual follows stakers >=50% / POL <=25% / treasury.

**Gates:** DEBATABLE — mandatory risk interstitial: past PnL disclaimer plus honest latency labeling ("you fill N blocks behind the leader; entry price will differ"). Honesty: leaderboards render only indexer-derived PnL, never self-reported; wallets with unindexed history self-gate to "insufficient data." F7 audit wave for CopyFeeSplitter; sell-mirroring flag-gated until buy-mirroring runs 30 days clean.

**Done when:** (1) Follower mirrors a leader fill within the labeled latency with caps enforced; (2) leader claims their share from CopyFeeSplitter on-chain; (3) leaderboard PnL reproducible from raw indexer rows; (4) revocation immediately stops mirroring.

### #46 — Mobile apps

**Preconditions:** Items 1/47/16 stable on desktop (mobile is distribution for them, not a new product), F2 push live (the plumbing exists: `frontend/api/_lib/push.js`, `frontend/public/push-sw.js`, `frontend/public/manifest.webmanifest`, splash assets in `frontend/public/splash/`), F9 alert rules for anything worth pushing. Operator: Apple + Google developer accounts.

**The build:** Phase A — PWA hardening (ships value without store review): extend `frontend/public/push-sw.js` into a full service worker (app-shell precache, offline fallback, versioned cache busting) or adopt `vite-plugin-pwa` in `frontend/vite.config.ts`; audit `manifest.webmanifest` (icons, display standalone, shortcuts to /terminal and /scanner); add an install prompt component `frontend/src/components/InstallPrompt.tsx`; run the terminal, charts, and launch feeds through mobile-viewport passes (the terminal PairTable needs a card layout under 768px — do this in `frontend/src/components/terminal/`, not with a separate mobile tree). Wire F9 alerts (trigger fired, copied trade executed, watched pair moved) into the existing VAPID push path. Phase B — store wrap: Capacitor project at `frontend/mobile/` (`capacitor.config.ts` pointing at the built Vite bundle), native push bridge (APNs requires it — web push alone doesn't reach iOS reliably), WalletConnect deep links plus F6 embedded wallets for in-app signing. Explicitly not in scope: native rewrite (per the doc — "PWA-wrapped first, native later").

**Fee wiring:** None new — this item is a multiplier on every existing leg (terminal 0.75%, bot 1%, triggers 0.1%, premium). Do not route any payment through IAP: premium stays on-chain via PremiumAccess to avoid Apple's 30% and policy entanglement.

**Gates:** No law amendment. Store-policy risk is the real gate: Apple's crypto rules require the wrapped app to avoid IAP-bypass framing — keep purchases as on-chain wallet actions and disclose them; if review stalls, the hardened PWA is the fallback and remains fully functional. Honesty: push alerts fire only from real indexed events, never synthesized activity.

**Done when:** (1) PWA installs on iOS + Android and passes Lighthouse PWA checks; (2) a trigger-order fill delivers a push to a locked phone; (3) terminal one-click trade completes on the mobile viewport; (4) store builds submitted with on-chain-only payments.


## Wave 3 — The launch economy

Wave 3 turns the launch rails from venues into an economy, sequenced so each item makes the next cheaper and more credible. First the trust primitives on rails that already exist: #6 creator revenue share and #28 vesting/lock rails need no new category — they bolt onto the live Doppler integration and the SwapFeeRouter→ReferralSplitter→RevenueDistributor spine, and they produce the two ingredients everything downstream consumes (an escrowable creator fee stream, and a registered/vested deployer wallet set). #26 rug-refund escrow composes exactly those two into the net-new category that IS the wedge; #29 gives graduated tokens a transparent afterlife; #13 and #27 convert sniper extraction into LP depth and creator income using the graduation flow and the vendored uniswap-hooks base — deliberately shipped EVM-first because the Solana leg belongs inside #4's single redeploy window. #4 is the wave's hinge and its highest-ceremony item: both old program IDs are spent, so it is a fresh deploy carrying the ~15 scheduled audit fixes, the client decode fixes, and the #11 partner-config delta, with authority rotation dead last after the Squads signer is proven — the shape of the loss the repo already paid for. With the curve live, the social formats (#24, #25) and themed lanes (#64, #80) multiply volume on existing fee lines, #11 rents the whole stack to partners with on-chain-enforced splits, and only then do the chain expansions run — #37 Base first (Doppler is already there; verbatim redeploys, cheap), #36 BNB second (needs a curve-fork selection and inherits Base's bridge-cadence playbook). Shared risks: every escrow/attestation item leans on the F8 signing key (trust disclosed on fact sheets, always fail-closed), the serverless 12-function cap forces all new backend through the aggregator catchall until F5, and every authority named anywhere must first prove it can sign.

### #4 — First-party Solana bonding-curve launchpad

**Preconditions:** F7 (per-wave adversarial audit + deploy ceremony), F1 Solana leg (curve trade/fee indexing). Operator actions: fund ~9 SOL fresh rent/fees; run the Tier 4 authority ceremony — Squads member B must sign and execute a real mainnet proposal BEFORE any authority is named (the findings ledger's first HIGH; the old rail died exactly this way). Both old program IDs are spent — this is a fresh deploy, not an upgrade.

**The build:** Contracts: apply every SCHEDULED fix (~15) in docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md to solana/tegridy-amm/programs/tegridy-launch and the vendored cp-swap fork; generate fresh keypairs, update declare_id! in both programs and Anchor.toml; rehearse on devnet with deploy-devnet.sh, then solana/tegridy-amm/MAINNET_RUNBOOK.md. Client: fix the three proven client findings — BONDING_CURVE_SIZE = 716 + re-derived offsets in frontend/src/lib/launcher/solana/curve/program.ts, add the missing creator account to tradeKeys in curve/ix.ts, rent floors in curve/read.ts — and assert tests against a captured base64 curve blob, not a locally-encoded struct. Deploy order per findings: deploy → initialize_global → update_global with cp_swap_program/amm_config → prove one dust launch graduating end-to-end via migrate_to_amm → ONLY THEN rotate global.authority to the proven Squads vault. Frontend: point solana/liveConfig.ts at new IDs; un-gate CurveLaunchPage.tsx; enforce Heat floor 80 via src/lib/heat/launchGate.ts before create_launch. Data: F1 tables for curve trades, graduations, fee sweeps.

**Fee wiring:** 1% trade_fee_bps on buy/sell + flat SOL creation fee; creator_fee_share_bps carved at source (#6); remainder to global.fee_recipient (Squads vault PDA), swept per docs/SOLANA_FEE_CAPTURE_PLAN.md mirroring the stakers/treasury/POL split.

**Gates:** Full F7 re-audit of the fix diff; upgrade authority retained only until graduation is proven, then rotated per ceremony (conscious, documented deviation from instant immutability). Honesty: read.ts already fails closed to "unreadable" — keep it.

**Done when:** (1) mainnet dust launch graduates e2e into cp-swap; (2) CurveLaunchPage renders real phase/progress/quotes; (3) fee sweep lands at the vault and appears in F1; (4) authority rotated only after member B's proven signature.

### #6 — Creator revenue share

**Preconditions:** F1 (market-cap tiers need indexed FDV), F3 (fee legs live). EVM launches already emit integrator fees (src/lib/launcher/integratorFees.ts); graduation-venue pool fees flowing (Tier-S #2).

**The build:** Contracts: new contracts/src/CreatorShareSplitter.sol modeled on the live ReferralSplitter pattern — immutable, sits on the launch-fee leg upstream of RevenueDistributor; holds per-token creator accruals claimable in ETH. Solana pays at source: the curve's existing creator_fee_share_bps field (lands with #4). Market-cap scaling: base share paid on-chain per trade; the scaled boost settles via periodic Merkle roots computed from F1 FDV data and posted to the splitter by the ops Safe (disclosed cadence). Deploy script contracts/script/DeployCreatorShareSplitter.s.sol via deploy-gated.sh. Backend: aggregator catchall `?resource=creator-earnings` with lazy import api/_lib/creator-earnings.js reading F1 GraphQL. Frontend: new frontend/src/components/launcher/CreatorEarningsPanel.tsx on LaunchPage.tsx and the token dossier; print the share schedule in src/lib/launcher/factSheet.ts and tokenDossier.ts. Data: indexer tables creator_accrual, creator_claim.

**Fee wiring:** Creator receives 30–50% of the launch-fee take, scaled by FDV tier; venue keeps the rest. Path: launch fees → SwapFeeRouter → CreatorShareSplitter (creator leg held for claim) → remainder → ReferralSplitter → RevenueDistributor stakers/treasury/POL as configured. Solana: creator_fee_share_bps at trade time, rest to fee_recipient.

**Gates:** Real-yield law complies — creators are paid only from earned fees, never emissions or unearned capital. Honesty: unclaimed balances render as "unclaimed", no projected-earnings numbers anywhere. Splitter gets an F7 audit pass before deploy.

**Done when:** (1) a creator claims real ETH from a mainnet launch's accrual; (2) fact sheet prints the exact share % and tier schedule; (3) F1-derived tier recompute matches on-chain Merkle root; (4) distributor still receives its remainder unchanged.

### #13 — Graduation priority auction

**Preconditions:** Graduation venue (#2) live — auctions settle inside the migration transaction; F1 for auction history; F7 audit wave. Wave-3 prior: #6 (creator payout rails reused).

**The build:** Contracts: new contracts/src/GraduationAuction.sol — commit-reveal sealed bids: once a launch passes a progress threshold, bidders commit keccak(bid, salt) with ETH deposit; reveal window opens at graduation trigger; clearing is uniform-price over the reserved first-block allocation. Settlement is atomic and needs NO pair changes: the migration flow (the same contract path that seeds the graduated TegridyPair pool) executes winners' buys through TegridyRouter in the same transaction that adds initial liquidity — winners are literally the first fills, everyone else trades from tx+1. Deploy script contracts/script/DeployGraduationAuction.s.sol. Solana leg deferred until after #4 (a follow-on ix around migrate_to_amm). Frontend: new frontend/src/components/launcher/AuctionPanel.tsx (commit/reveal UX, countdown) on the launch page; auction config printed by src/lib/launcher/factSheet.ts; results in LaunchExplorer.tsx rows. Backend: `?resource=auction-state` lazy import api/_lib/auction-state.js from F1. Data: indexer tables auction_commit, auction_settlement.

**Fee wiring:** Clearing proceeds split on-chain: 70% market-buys into the token's new LP (deepening the pool), 20% creator via CreatorShareSplitter, 10% venue → SwapFeeRouter → RevenueDistributor split. Opt-in external snipes pay 1% on top, same path.

**Gates:** DEBATABLE — strictly opt-in per launch, choice printed on the fact sheet; external sniping only as explicit creator opt-in; honesty: full auction results (clearing price, allocations) published post-settlement, unrevealed commits refunded. F7 audit before mainnet.

**Done when:** (1) a launch graduates with auction winners filled inside the seeding tx on a mainnet-fork test, then mainnet; (2) 70/20/10 split verified on-chain; (3) fact sheet and explorer show auction config and results.

### #26 — Rug-refund escrow (launch insurance)

**Preconditions:** #6 (the creator fee share is the escrowed asset), #28 (vested team wallets give the deployer-wallet set meaning), F1 (dump detection), F8 (signed attestations — the trigger transport).

**The build:** Contracts: new contracts/src/LaunchEscrow.sol — immutable; holds the creator's accrued fee share for N days from launch. Deployer/team wallets registered at creation from the launch covenant (src/lib/launcher/covenant.ts). Trigger: EVM cannot read history, so a refund requires an F8-signed attestation (venue attestation key) that registered wallets sold/transferred > X% inside the window, posted on-chain with a 3-day challenge window before refunds open; buyers claim pro-rata via a Merkle root of curve purchase amounts from F1. Clean expiry releases to the creator minus the premium. Deploy script contracts/script/DeployLaunchEscrow.s.sol. Solana leg after #4. Backend: `?resource=escrow-status` lazy import api/_lib/escrow-status.js. Frontend: new frontend/src/components/launcher/RugEscrowPanel.tsx; escrow terms and countdown printed in src/lib/launcher/factSheet.ts and tokenDossier.ts. Data: indexer tables escrow_position, escrow_trigger, escrow_claim.

**Fee wiring:** Venue keeps 5–10% of the escrowed premium ONLY on clean release → SwapFeeRouter → ReferralSplitter → RevenueDistributor split. On a triggered refund the venue takes nothing — 100% pro-rata to buyers. Creator-funded, never venue capital.

**Gates:** Complies with "may not spend capital it has not earned" — the venue never underwrites; only the creator's earned share is at risk. Honesty: fact sheet prints the exact trigger conditions AND the attestation-key trust assumption in plain language. F7 audit; flag-gated to opt-in launches for the first 30 days.

**Done when:** (1) escrowed mainnet launch releases cleanly after the window; (2) simulated deployer dump on a fork triggers attestation → challenge → pro-rata refunds that sum correctly; (3) fact sheet renders full escrow terms; (4) premium lands in the distributor.

### #27 — Anti-snipe decaying-tax mode

**Preconditions:** v4 module audit wave (contracts/src/v4/ exists but hook is undeployed); Doppler V4 migration path in src/lib/launcher/airlock.ts; F1. Solana leg waits for #4.

**The build:** Critical constraint: the launcher gate (src/lib/launcher/gate.ts) disqualifies TOKEN-level taxes from Tier-L — so the decay must live in the POOL, keeping the token clean. Contracts: new contracts/src/v4/DecayingFeeHook.sol built on the vendored contracts/lib/uniswap-hooks base (verbatim base, minimal delta): a dynamic-fee V4 hook starting near-max (~99% effective) and decaying linearly to the baseline pool fee over ~90 minutes from pool initialization; parameters immutable per pool. Wire it as an optional launch format in airlock.ts (V4 migration target) and the graduation flow. Solana: ships with #4 as a curve mode — the BondingCurve struct's mode field plus a decaying trade_fee_bps schedule via set_curve_segments. Deploy script contracts/script/DeployDecayingFeeHook.s.sol. Frontend: live effective-fee display on the trade panel and frontend/src/components/launcher/CurveChart.tsx overlay; mode labeled in factSheet.ts ("pool fee decaying until <timestamp>"); wizard toggle in LaunchPage.tsx. Data: indexer table decay_fee_collection.

**Fee wiring:** Collected decay-fee proceeds split: 50% creator (via CreatorShareSplitter), 25% veTOWELI stakers via RevenueDistributor, 25% treasury/POL — venue keeps ~25% per the doc. Hook fees route through TegridyFeeLocker → SwapFeeRouter. Standard fees continue unchanged at baseline.

**Gates:** NET+. Amend src/lib/launcher/gate.ts + README to distinguish pool-level decay (disclosed format) from token tax (disqualifier) — document the distinction. Honesty: the trade UI must render the CURRENT elevated fee from hook state, never the baseline, while decay is active. Hook joins the v4 audit wave.

**Done when:** (1) fork simulation shows block-zero snipe unprofitable and fee decaying on schedule; (2) live fee % renders correctly during decay on mainnet; (3) 50/25/25 split verified; (4) fact sheet labels the mode.

### #28 — Vesting & lock rails

**Preconditions:** F7 vendor-intake procedure. No prior wave items — this ships first with #6.

**The build:** Law note: Sablier Lockup is BUSL — the "Sablier-fork" framing amends to the house's existing Doppler pattern: INTEGRATE the canonical deployed Sablier Lockup contracts on mainnet, never fork or redeploy them. For the simple team-vesting leg, additionally vendor OZ VestingWallet (already in contracts/lib/openzeppelin-contracts) verbatim behind a thin factory: new contracts/src/VestingFactory.sol emitting registry events (token, beneficiary, cliff, end) the scanner and indexer read; deploy script contracts/script/DeployVestingFactory.s.sol. Frontend: add a vesting/lock step to the LaunchPage.tsx wizard that creates streams/locks pre-launch; implement a real SablierLockResolver for the injectable LockResolver hook in src/lib/launcher/collector.ts so gate.ts's existing Tier-L "team allocation on-chain-vested" and "LP locked ≥ 30d" checks flip on live data instead of conservative defaults; print lock/vest status and expiry in factSheet.ts. Also wire LockerClaimer (deployed, unwired) where LP locks are ours. Backend: `?resource=locks` lazy import api/_lib/locks.js. Data: indexer tables vesting_stream, lp_lock, stream_claim.

**Fee wiring:** 0.25% of streamed value as an ETH fee-on-top leg at stream creation (F3 pattern) → SwapFeeRouter → ReferralSplitter → RevenueDistributor split. Honest expectation per the doc: ~zero direct revenue — the product is launch share and gate truthfulness.

**Gates:** Complies with verbatim-fork law precisely by NOT forking BUSL code; VestingFactory (thin, OZ-verbatim core) gets an F7 pass. Honesty: fact sheet prints "unlocked / unvested" truthfully when no lock exists — no green badges by default.

**Done when:** (1) a launch creates a real Sablier stream + LP lock in the wizard; (2) gate.ts tier computation flips on live resolver data; (3) fact sheet shows expiry dates; (4) the 0.25% leg lands in the distributor.

### #29 — Afterlife buyback flywheel

**Preconditions:** Graduation venue (#2) live on the native DEX; F1 (execution ledger); TegridyTWAP deployed (it is). Prior wave items: none hard, but #6's splitter exists for creator routing.

**The build:** Contracts: new contracts/src/FlywheelVault.sol + FlywheelFactory.sol — per-token minimal clones (Initializable pattern already used by TegridyDropV2): the vault receives ETH/token inflows from anyone (creator fee shares, community, the token's own contracts); a permissionless crank() market-buys the token through TegridyRouter guarded by TegridyTWAP deviation bounds and a max-spend-per-crank rate limit, then burns or LPs per an immutable config chosen at creation — no admin, no discretion. Deploy script contracts/script/DeployFlywheelFactory.s.sol via deploy-gated.sh. Frontend: extend src/lib/launcher/afterlife.ts and afterlifeLedger.ts to include flywheel balances and execution history; render in frontend/src/components/launcher/LaunchAfterlife.tsx; add the opt-in creation step to LaunchPage.tsx and graduation flow. Backend: none new — chain + F1 reads. Data: indexer tables flywheel_deposit, flywheel_execution (amount in, tokens bought, burned/LP'd, price).

**Fee wiring:** 0.25–0.5% of each crank's spend → SwapFeeRouter → ReferralSplitter → RevenueDistributor split; the buy itself also pays the normal 0.25% pool fee with the 0.05% protocol take. Crank callers get a small gas-covering bounty from the executed amount (disclosed).

**Gates:** Complies: immutable, rules-based, transparent — the honest replacement for dev "we'll buy back" promises. TWAP guard is mandatory (crank-MEV defense). Honesty: LaunchAfterlife renders only indexed executions, never projected support or implied floor prices. F7 audit; flag-gated to opt-in launches until 30 days clean operation.

**Done when:** (1) a graduated token's flywheel receives inflows and a permissionless crank buys+burns on mainnet; (2) ledger matches F1 exactly; (3) TWAP guard rejects a manipulated-price crank on fork; (4) execution fee lands in the distributor.

### #24 — Social-attribution launches

**Preconditions:** F2 (SIWE live, profiles), #6 (creator share ledger), #26 (LaunchEscrow claim-key pattern reused). Operator: provision X API + Farcaster hub/Neynar credentials.

**The build:** Contracts: reuse contracts/src/LaunchEscrow.sol with a claim-key variant: the attributed creator share accrues to an escrow slot claimable only with an EIP-712 voucher signed by the venue attribution key, expiring after N days. Backend: `?resource=attribution-claim` lazy import api/_lib/attribution.js — X path: claimant posts a tweet containing their wallet address, server verifies via API; Farcaster path: signed cast verified against the hub; on success the server issues the voucher binding handle→wallet. Rate-limited via api/_lib/ratelimit.js. Frontend: attribution field in the LaunchPage.tsx wizard; attribution badge in frontend/src/components/launcher/LaunchExplorer.tsx rows and src/lib/launcher/tokenDossier.ts — with the mandatory honesty label pre-claim: "unclaimed attribution — this person has not endorsed or acknowledged this token." Claim flow page section on the token page. Data: indexer tables attribution, attribution_claim; F2 profile link on claim.

**Fee wiring:** Standard curve/launch fees; the attributed 30–50% creator share accrues in escrow; on claim it pays the verified handle's wallet; on expiry the unclaimed share sweeps to treasury via SwapFeeRouter → RevenueDistributor split. Venue keeps its normal remainder throughout.

**Gates:** DEBATABLE — the whole delta vs Believe/Bags is honesty: the unclaimed label renders on EVERY surface (explorer, fact sheet, trade page), attribution is never displayed as endorsement, and a documented impersonation-takedown path exists in AdminPage.tsx. Voucher-key trust disclosed on the fact sheet. Escrow delta joins an F7 pass.

**Done when:** (1) attributed launch shows the unclaimed label everywhere; (2) a real handle claims via signed post and receives the accrued share on-chain; (3) expiry sweeps to treasury; (4) forged-voucher and replayed-claim tests fail closed.

### #25 — Live launch streams

**Preconditions:** #24 (verified creator identity), F2 (SIWE + push), F1 (trade timestamps for the boost). Operator: approve a real moderation budget and staffing — pump.fun's suspension arc is the named warning — and a Livepeer (or LiveKit Cloud) account.

**The build:** No video infra in-house. Backend: `?resource=stream-token` lazy import api/_lib/streams.js — mints publish tokens ONLY to the launch's verified creator (F2 session + #24 attribution match); stores playback URL + session heartbeats on the launch record; `?resource=stream-report` for user reports. Heat gate: streaming requires Heat tier ≥ Resident via src/lib/heat/heatClient.ts. Frontend: new frontend/src/components/launcher/LaunchStreamPanel.tsx embedded on CurveLaunchPage.tsx and the EVM token pages; "LIVE" badge in LaunchExplorer.tsx driven strictly by fresh heartbeats; report button; kill switch surfaced in AdminPage.tsx. Boost accounting: compute verified live minutes from session heartbeats, join against F1 trade timestamps, settle the boost through the #6 CreatorShareSplitter Merkle cadence. Data: indexer/Supabase tables stream_session, stream_report.

**Fee wiring:** No new user-facing fee. While verifiably live, the creator's share of the launch-fee take rises (e.g., 50% → 65%), funded entirely out of the VENUE's share — stakers/treasury/POL legs untouched. Revenue case is volume uplift on existing curve/DEX fee lines.

**Gates:** DEBATABLE — moderation IS the gate: no streams ship without the report→review→kill path staffed; Heat floor enforced; allowlist-only for the first 30 days. Honesty: the LIVE badge renders only from current heartbeats — never cached, never replays labeled live.

**Done when:** (1) a verified creator streams on their own launch page; (2) the live boost appears in the claim ledger and reconciles with session logs; (3) a report→kill drill completes end-to-end; (4) sub-Resident creators are refused publish tokens.

### #11 — White-label launchpad rails

**Preconditions:** #4 live (own Solana curve is the rentable asset), F5 (API keys/billing + serverless-budget escape), F7. #26/#28 features parameterized so partners can enable them. Operator: partner legal template.

**The build:** Solana: per-partner config PDAs in the redeployed tegridy-launch program — partner_config { partner_fee_recipient, split_bps, heat_floor, branding_id } referenced at create_launch, with the split enforced inside buy/sell fee logic. Schedule this delta INTO #4's redeploy (it lands before the authority rotation freezes upgrades) — a conscious sequencing requirement, not an afterthought upgrade. EVM: partner leg via src/lib/launcher/airlock.ts withIntegrator plus a new contracts/src/PartnerFeeSplitter.sol on the ReferralSplitter pattern, deploy script DeployPartnerFeeSplitter.s.sol. Frontend: hosted branded surfaces at route /pad/:partner — new frontend/src/pages/PartnerPadPage.tsx reusing CurveLaunchPage/LaunchPage internals with a theme/config object; partner admin gated by F5 keys. Backend: `?resource=partner-config` lazy import api/_lib/partner-config.js; partner analytics served from F1. Data: indexer keyed by partner_id on launches/trades/fees.

**Fee wiring:** Partner sets their fee within program-enforced bounds; the venue's 20–50% cut is split ON-CHAIN at trade time (program on Solana, PartnerFeeSplitter on EVM) — never invoiced. Venue leg → SwapFeeRouter → ReferralSplitter → RevenueDistributor; Solana venue leg → fee_recipient sweep per docs/SOLANA_FEE_CAPTURE_PLAN.md.

**Gates:** Trustless-split complies with minimal-attack-surface law. Heat floor 80 is a hard minimum — partners may raise it, never lower it. Honesty: partner pads carry the same fact sheets, gates, and labels; no white-label opt-out of disclosure. Program delta + splitter audited in the #4 wave.

**Done when:** (1) a partner pad is live at /pad/:x with their branding; (2) a launch through it splits fees on-chain per config, verified in F1; (3) fact sheet renders identically to first-party; (4) partner dashboard shows real F1 analytics behind an F5 key.

### #36 — BNB launcher expansion

**Preconditions:** #37 complete — the multichain playbook (per-chain constants, indexer legs, bridge cadence, Safe ceremony) must be proven on Base first. F1 multichain, F7. Operator: go/no-go memo; BNB Safe signers proven BEFORE any authority is named (the paid-for lesson from SAFE_REHOME_RUNBOOK.md and the Squads loss).

**The build:** Doppler does not serve BNB, so this chain needs an EVM curve: run the selection in docs/CURVE_FORK_EVALUATION.md and vendor the chosen battle-tested open-source curve VERBATIM via F7 intake (exact commit, diff-guard CI) into contracts/src/ — the only permitted delta is fee-recipient wiring and the Heat-gate hook; BUSL candidates are excluded outright. Deploy the venue spine to BNB: parameterize contracts/script/DeployMVP.s.sol (Factory/Router/Pair/SwapFeeRouter/ReferralSplitter/RevenueDistributor) + DeployTWAP.s.sol via deploy-gated.sh. Frontend: extend the per-chain address maps and isDeployed() gating in src/lib/constants.ts; add BNB to the wagmi config; launcher gate/collector are pure and port unchanged. Heat: the island registry does not read BNB — until the oracle confirms coverage, honesty-gate: BNB launches render "no Heat data" and the gate runs on deployer-reputation + structural checks only. Data: add the BNB network + contracts to indexer/ponder.config.ts.

**Fee wiring:** ~1% curve fee + creation fee → BNB-local SwapFeeRouter → BNB ReferralSplitter → chain-local accumulation, bridged to the mainnet RevenueDistributor on the #37-established disclosed cadence; same stakers/treasury/POL split on arrival.

**Gates:** DEBATABLE. Fixed-supply TOWELI untouched. Any non-verbatim curve delta gets a full F7 adversarial pass. Flag-gated beta behind isDeployed until one clean graduation cohort.

**Done when:** (1) launch → graduate e2e on BNB mainnet; (2) fees accrue in the BNB router and a bridge cycle lands at the distributor; (3) BNB surfaces honestly show "no Heat data"; (4) diff-guard CI proves the vendored curve matches upstream.

### #37 — Base L2 expansion

**Preconditions:** #11 not required; F1 multichain capability; F7 ceremony. Operator: the go/no-go memo the roadmap already commits to; Base Safe created with signers PROVEN (nonce > 0) before owning anything — the 0xA360/Squads lesson.

**The build:** Doppler is deployed on Base — extend src/lib/launcher/doppler.constants.ts with the Base address set, verified on-chain via Airlock.getModuleState at a pinned block exactly like the existing mainnet entry (block 25553318 ritual). Parameterize src/lib/launcher/airlock.ts and config.ts by chainId. Contracts: verbatim redeploys of the audited mainnet spine to Base — contracts/script/DeployMVP.s.sol (TegridyFactory/Router/Pair, SwapFeeRouter, ReferralSplitter, RevenueDistributor mirror), DeployTWAP.s.sol, plus BootstrapTWAP.s.sol, all through deploy-gated.sh with Safe ownership per TransferOwnershipToMultisig.s.sol. Note SequencerCheck.sol already exists in contracts/src/lib/ for L2 awareness. Frontend: per-chain maps + isDeployed() in src/lib/constants.ts, chain switcher in the swap/launch surfaces; gate.ts/collector.ts are pure and need only RPC config. Heat: the island registry already reads Base — verify src/lib/heat/heatClient.ts resolves Base wallets and keep the launch floor 80. Data: add Base network + contract set to indexer/ponder.config.ts; websocket new-pair feed covers Base.

**Fee wiring:** Same lines as mainnet: Doppler integrator fee on launches (withIntegrator), 0.25% pool fee with 0.05% protocol take on graduated Base pools → Base SwapFeeRouter → Base splitter; accumulated ETH bridged to the mainnet RevenueDistributor on a published cadence via the Safe — stakers/treasury/POL split applied on arrival, cadence printed on TreasuryPage.tsx.

**Gates:** NET+. Verbatim redeploys of audited code — F7 config review, no new audit wave. Honesty: every Base surface gates per-chain on isDeployed; bridge cadence disclosed, never implied real-time.

**Done when:** (1) Base launch e2e with fact sheet rendered; (2) graduated pool trading on the Base DEX fork; (3) one bridge cycle lands at the distributor and reconciles with F1; (4) indexer serves Base launches to the explorer.

### #64 — Generative-art launch lane

**Preconditions:** TegridyLaunchpadV2 + TegridyDropV2 live (they are); the repo's deferred A.6 sketch; nakamigos Seaport marketplace live for secondaries; F1 mint indexing. No wave dependencies.

**The build:** Contracts: new template contracts/src/TegridyGenArtDrop.sol as a minimal delta on the TegridyDropV2 pattern (same Initializable clone + TimelockAdmin + ERC2981 + dutch-auction/allowlist machinery — DELETE before ADD: reuse, don't rewrite): adds (a) an on-chain per-token seed derived at mint (prevrandao/blockhash + tokenId, committed in the mint event), (b) an immutable art-script hash pinned at init, (c) tokenURI composing seed + script reference. Script bytes stored permanently via the existing Irys client (frontend/src/lib/irysClient.ts); the DropV2 ERC-7572 contractURI carries collection metadata. Deploy script contracts/script/DeployGenArtTemplate.s.sol registering the template with the LaunchpadV2 factory. Frontend: gen-art creation flow in frontend/src/components/launchpad/ wired from ArtStudioPage.tsx — sandboxed deterministic preview that runs the EXACT uploaded script against real seed values; collection pages render from seed in GalleryPage.tsx. Data: indexer tables genart_collection, genart_mint (seed, price).

**Fee wiring:** 3–5% mint fee at mint (ETH via the WETHFallbackLib pattern DropV2 already uses) → SwapFeeRouter → ReferralSplitter → RevenueDistributor split. Secondary: ERC-2981 royalties (capped 10% per the existing DropV2 audit fix) enforced on the nakamigos Seaport marketplace, with the venue's normal marketplace fee on top.

**Gates:** Honesty is the lane's product: previews must run the deployed script with the real seed algorithm — no mock renders, no curated fake outputs; script hash printed on the collection page and fact sheet. Only the seed/URI delta needs an F7 pass — the inherited DropV2 surface is already audited.

**Done when:** (1) a collection deploys via the factory and mints produce on-chain seeds with deterministic renders; (2) preview output matches post-mint output byte-for-byte for a fixed seed; (3) a secondary sale on the own marketplace pays the ERC-2981 royalty; (4) mint fees land in the distributor.

### #80 — AI agent launch track

**Preconditions:** At least one launch rail live for the lane (#4 Solana curve or the EVM launcher); F1; F8 (attestation log). No new contracts.

**The build:** A themed lane whose differentiator is liveness proof, not new machinery. Frontend: extend src/lib/launcher/gate.ts and factSheet.ts with agent-track facts: the agent's controlled wallet, open-source repo link, endpoint, and a liveness record; add the "agent" lane filter to frontend/src/components/launcher/LaunchExplorer.tsx and an agent badge block in src/lib/launcher/tokenDossier.ts; agent-track metadata step in the LaunchPage.tsx / CurveLaunchPage.tsx wizards. Backend: `?resource=agent-liveness` lazy import api/_lib/agent-liveness.js — issues nonce challenges the agent's registered key must sign on a cadence; stores the signed-response history; serves uptime windows. Rate-limited via api/_lib/ratelimit.js; responses logged into the F8 attestation store so third parties can verify. Data: indexer/F8 tables agent_registration, liveness_check (nonce, signature, timestamp).

**Fee wiring:** Standard creation + ~1% curve fees, no premium — same paths as the underlying rail: Solana fee_recipient sweep, EVM SwapFeeRouter → ReferralSplitter → RevenueDistributor. The lane is a volume play on existing fee lines.

**Gates:** DEBATABLE, hype-cycle shaped — ride cycles, never depend: no other roadmap item may take a dependency on this lane. Honesty is the entire pitch: the fact sheet states exactly what was verified ("endpoint signed challenge N at time T") and explicitly what was NOT ("no claim this agent trades, profits, or is autonomous"); a badge renders only with a proof fresher than 24h, else "no liveness data"; lapsed agents auto-downgrade to "liveness lapsed" — never silently keep the badge. No law amendment needed.

**Done when:** (1) an agent launch shows a liveness badge backed by a real challenge log; (2) killing the agent endpoint flips the label within 24h with zero manual action; (3) lane filter live in the explorer; (4) a grep-style audit of the lane's surfaces finds no unverified "alive/autonomous" wording.


## Wave 4 — The yield & credit stack

Wave 4 turns the venue's single real-yield pipe (SwapFeeRouter → ReferralSplitter → RevenueDistributor/POLAccumulator) into a full yield-and-credit stack, ordered by attack surface: first the zero-new-risk moves (18 auto-compounds farms the venue already runs; 19 deploys a restaking module that is already written and audit-scarred), then integration-only surfaces that are pure frontend + fee-on-top (32, 33, 23), then the first new lending primitive as a verbatim Morpho Blue fork with one tiny oracle adapter (14), the vault layer that composes on it (21, 22), loops that reuse it (30), and only after all of that the Aave v3 fork (10) — the largest surface in the whole plan, gated on its own dedicated audit wave and on a written amendment to the immutability law for Aave's proxy architecture. 20, 31, 55 and 56 then productize the stack for third parties and savers. Shared risks: every item's fee leg terminates in the same F3 FeeRouter → stakers/treasury/POL split, so F3 must be live and audited before anything here charges a fee; every APY number rendered anywhere in this wave must come from realized indexer history (F1) or self-gate to "no data"; and the F7 fork-intake discipline (pinned vendor commit + diff-guard CI) is the precondition for 14, 21, 30, 10, 20, 31 and 56 without exception.

### #18 — Harvest vaults (auto-compounder)

**Preconditions:** F1 (realized-APY history), F3 (FeeRouter live), F7 (fork intake + audit wave). Live targets already on mainnet: TegridyLPFarming (`0x1171…e149`), RevenueDistributor, TegridyRouter. No operator capital needed — vaults hold user funds only.

**The build:** Contracts — vendor `beefyfinance/beefy-contracts` at a pinned commit into `contracts/lib/beefy-contracts` per F7 intake (diff-guard CI). Deploy `BeefyVaultV7` VERBATIM; the only delta is one new strategy, `contracts/src/strategies/StrategyTegridyChefLP.sol`, a minimal adaptation of `StrategyCommonChefLP` whose chef calls target `TegridyLPFarming.deposit/withdraw/pendingReward` and whose swap route is `TegridyRouter` (own pairs only at launch). Deploy script `contracts/script/DeployHarvestVaults.s.sol` modeled on `DeployTegridyLPFarming.s.sol`; ownership to the Safe per `TransferOwnershipToMultisig.s.sol` pattern. Frontend — add `HARVEST_VAULT_ADDRESSES` to `frontend/src/lib/constants.ts` behind `isDeployed()`; new hook `frontend/src/hooks/useHarvestVault.ts` (mirror `useLPFarming.ts`); vault cards as a new section in `frontend/src/pages/FarmPage.tsx`. Backend — none. Data — new `indexer/ponder.schema.ts` tables `harvestVault` (pps, tvl) and `harvestEvent`; handlers in `indexer/src/index.ts`; realized APY computed only from pps deltas.

**Fee wiring:** 9.5% of each harvest (Beefy's exact rate: 0.5% caller/keeper gas rebate, 9% protocol), taken in WETH by the strategy at harvest, sent to the F3 FeeRouter → SwapFeeRouter three-way split: ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. No deposit/withdraw fees.

**Gates:** Verbatim-fork law satisfied (vault untouched; strategy is the declared minimal delta and gets echidna + the wave's adversarial audit). Honesty: APY rendered only from ≥1 realized harvest via F1, else "no data". External (non-own) pools stay flag-gated off until own-farm vaults run clean for 30 days.

**Done when:** (1) a vault over an existing TegridyLPFarming pool compounds via a public `harvest()` with monotonically increasing pps; (2) the 9.5% skim shows up in a RevenueDistributor epoch on-chain; (3) FarmPage shows realized APY sourced from the indexer and "no data" pre-first-harvest; (4) diff-guard CI proves the vault bytecode matches the pinned Beefy commit.

### #19 — Restaking activation + liquid receipt

**Preconditions:** F7 — the mandatory external re-audit named in `docs/RESTAKING_EIP170_SPLIT_DESIGN.md` (fund-touching moved surface). Item 18 not required. Operator: fund the bonus reward pool ONLY from already-earned protocol fees ("may not spend capital it has not earned").

**The build:** Contracts — execute the split exactly as designed in `docs/RESTAKING_EIP170_SPLIT_DESIGN.md`: create `contracts/src/TegridyRestakingAdmin.sol` mirroring `TegridyStakingAdmin.sol`/`SwapFeeRouterAdmin.sol` (all propose/execute/cancel triplets, pending state, timelock keys, acceptOwnership flush move to the sister; host `TegridyRestaking.sol` keeps the fund core and gains `setRestakingAdmin` + `applyXxx` per `TegridyStaking.sol:2018-2132`). Confirm `forge build --sizes` in CI — the doc explicitly forbids trusting the estimate. Deploy script `contracts/script/DeployRestaking.s.sol` following the `DeployMVP.s.sol:155-297` pattern, then wire `RESTAKING_CHANGE` on RevenueDistributor. Do NOT build the liquid receipt in this item's first deploy: the module is audited as-is, and a transferable receipt breaks the per-tokenId attribution the C-1 audit fixes exist to protect. Spec the receipt separately (pattern: `TegridyStakingJbacVault.sol`) and flag-gate it. Frontend — flip `TEGRIDY_RESTAKING_ADDRESS` at `frontend/src/lib/constants.ts:24`; existing UI already gates on `isDeployed()` (see `LendingPage.tsx` "ETH loans + restake" tab). Data — extend indexer with `restakePosition`/`bonusClaim` tables alongside the existing `stakingPosition` table.

**Fee wiring:** Activation itself adds no new fee — the bonus pool IS distributed protocol revenue (real-yield law), and the venue earns via deeper/longer TOWELI locks feeding every other fee line. If/when the receipt wrapper ships, it takes 5% of bonus rewards passed through, to treasury via the F3 FeeRouter split.

**Gates:** Re-audit is non-negotiable per the design doc. Honesty: never render the ether.fi "AVS yield" framing — bonus yield is protocol fees, say so; bonus APR shown only from actual pool emission rate on-chain. Receipt token stays flag-gated until separately audited.

**Done when:** (1) CI `--sizes` shows host < 24,576 B; (2) restake → claimAll → unrestake round-trips on mainnet with base rewards forwarded correctly; (3) frontend restaking surface unlocks purely via the constants flip; (4) external re-audit report filed in `contracts/`.

### #32 — LST/LRT yield router

**Preconditions:** F3 (fee-on-top transfer legs — this item charges nothing without it), F1 optional. Prior items: none; this is the wave's first integration-only surface. Operator: none.

**The build:** Contracts — NONE beyond F3's already-audited FeeRouter periphery (minimal-attack-surface law: this item deliberately ships zero new bytecode). Frontend — new page `frontend/src/pages/EarnLstPage.tsx` registered in `frontend/src/lib/navConfig.ts`; new lib dir `frontend/src/lib/lst/` with `registry.ts` (allow-listed LSTs/LRTs: wstETH, rETH, weETH, rsETH — hand-curated, no permissionless additions), `pegData.ts`, `zapRoute.ts`. Zaps execute through the existing meta-router (`frontend/src/lib/swapRouting.ts` + `frontend/src/components/swap/*`) with the F3 fee leg attached — reuse `useIntegratorFees.ts` wiring. Backend — new `frontend/api/_lib/lst-yields.js` dispatched from the aggregator catchall as `?resource=lst-yields` with lazy import, exactly per the `api/_lib/heat.js` header pattern (12-function cap respected); it serves provider APRs, peg deviation (on-chain pool reads via the existing `api/alchemy.js` proxy path), and exit-liquidity depth, Upstash-limited via `_lib/ratelimit.js`. Data — none required day one; F1 later backfills realized-yield charts.

**Fee wiring:** 5 bps fee-on-top of zap notional, paid by the user in the input asset, taken by the F3 fee leg into the FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Partner kickbacks (if any LST pays referral) land in the same FeeRouter — no side accounts.

**Gates:** Honesty is the product: peg deviation, exit-liquidity depth, and slashing-mechanism notes render per asset with source + timestamp; any stale feed (>10 min) self-gates that asset's card to "no data" and disables the zap button. Provider APRs labeled as provider-reported, never venue-computed.

**Done when:** (1) an ETH→wstETH zap on mainnet emits the 5 bps fee into a RevenueDistributor epoch; (2) killing the yields resource makes every card show "no data" and blocks zaps; (3) Vercel function count unchanged at 11.

### #33 — towelSOL validator LST

**Preconditions:** Item 32 (shared EarnLst surface + honesty patterns). F1 Solana leg for holder/APY data. Operator actions dominate: choose Sanctum's multi-validator route (or stand up a validator), complete Sanctum's LST launch process, and run the stake-pool keypair ceremony into the Solana Safe-equivalent multisig. NOTE: this does NOT touch `solana/tegridy-amm/` — the closed program IDs are irrelevant because towelSOL runs on the SPL stake-pool program via Sanctum, not our code.

**The build:** Contracts/programs — none of ours; the pool is an instance of the audited SPL stake-pool program managed through Sanctum infra (verbatim/battle-tested law satisfied at its strongest: we deploy no code at all). Frontend — new `frontend/src/lib/lst/towelsol.ts` (pool address, mint, stake/unstake via `@solana/spl-stake-pool` or Sanctum's router quotes); a Solana tab on `EarnLstPage.tsx`; swap listing added to `frontend/src/lib/solanaTokenList.ts` so `SolanaSwapPage.tsx` can route towelSOL via Jupiter (`frontend/src/lib/jupiter.ts`). Heat-tier perks: read tiers via `frontend/src/lib/heat/heatClient.ts` and grant venue-side perks only (points multipliers in `frontend/src/lib/pointsEngine.ts`, fee rebates on venue swaps) — attributed to Jungle Bay Island with reckoning date per the `api/_lib/heat.js` honesty boundary; the venue never re-tiers Heat. Backend — extend `api/_lib/lst-yields.js` with a towelSOL branch (epoch APY, pool TVL via existing `api/solrpc.js` proxy). Data — F1 Solana leg indexes holder counts and epoch rewards.

**Fee wiring:** Validator commission + MEV commission (target 5% + 5%) on staked SOL, accruing in SOL to the pool's manager-fee account (multisig-held). Consciously amends the everything-to-RevenueDistributor default: SOL revenue holds at the Solana treasury (RevenueDistributor is EVM/ETH-only); a bridge-to-stakers leg is a future item and the split is documented as 100% treasury until then — stated on the page, not hidden.

**Gates:** Honesty: APY shown is realized epoch APY from chain history, never projected; peg vs SOL and unstake-queue time displayed live. Fixed-supply-TOWELI law untouched. Flag-gate deposits behind a TVL cap for the first month.

**Done when:** (1) towelSOL mints/redeems on mainnet through the page; (2) commission accrues to the multisig manager account; (3) Heat perks render with island attribution and self-gate when the oracle is stale.

### #23 — Fixed-yield desk (Pendle integration)

**Preconditions:** F3 (interface-fee leg), item 32 shipped (shared "honest yield card" patterns). Operator: register the venue's fee address with Pendle's interface-fee program (their hosted API supports an integrator fee param).

**The build:** Contracts — none (integration-only; minimal-attack-surface law). Frontend — new page `frontend/src/pages/FixedYieldPage.tsx`; new lib `frontend/src/lib/pendle/` with `client.ts` (hosted-SDK quote/route calls), `markets.ts` (curated market allow-list: PT/YT on majors and the LSTs already listed in `frontend/src/lib/lst/registry.ts`), and `factSheet.ts` modeled directly on `frontend/src/lib/launcher/factSheet.ts` — one fact sheet per market, including the mandatory honest paragraph on YT theta decay ("YT can go to zero at maturity; this is the designed behavior, not a failure") and PT early-exit price risk. Transactions go straight from the user's wallet to Pendle's audited router with our fee param attached. Backend — new `frontend/api/_lib/pendle.js` resource on the aggregator catchall (`?resource=pendle`, lazy import per `heat.js` pattern) proxying Pendle's hosted API for markets/implied-APY/liquidity, body-capped via `_lib/bodycap.js`, rate-limited via `_lib/ratelimit.js`. Data — none day one; F1 later records venue-routed PT/YT flow for the fee ledger.

**Fee wiring:** 0.10% interface fee on routed PT/YT notional, paid by the user inside the Pendle route (their integrator-fee mechanism), remitted to the F3 FeeRouter address → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury.

**Gates:** No-perps/no-stablecoin laws untouched (PT/YT are spot tokens). Honesty-gating: implied APY always labeled "implied — market price, not a guarantee"; maturity date and days-remaining on every card; YT cards carry the decay warning above the buy button; stale Pendle API (>5 min) self-gates the whole desk to "no data" and disables routing. No audit wave needed (zero new contracts) — record that reasoning in the wave's audit log.

**Done when:** (1) a PT purchase routes through Pendle with our fee visible in the route breakdown and landing at the FeeRouter; (2) every listed market renders a fact sheet with the decay language; (3) desk fails closed when the proxy resource is disabled.

### #14 — Isolated lending pairs for launched tokens

**Preconditions:** F7 in full (this is the wave's first new-lending audit wave: fork intake, echidna/halmos CI, adversarial audit, Safe deploy ceremony). F1 live (market/position data). TegridyTWAP deployed and bootstrapped per `contracts/script/BootstrapTWAP.s.sol` for every listed token. Items 18/19 shipped first per wave order.

**The build:** Contracts — vendor `morpho-org/morpho-blue` at its audited v1 release commit into `contracts/lib/morpho-blue` (F7 diff-guard CI proves zero drift); deploy the immutable `Morpho` singleton and Morpho's `AdaptiveCurveIRM` VERBATIM. The single minimal delta is one new contract, `contracts/src/oracle/TegridyTwapMorphoOracle.sol`: an immutable `IOracle` adapter returning TegridyTWAP consults scaled to Morpho's 1e36 convention, reverting (not defaulting) on TWAP staleness. Market creation initially restricted by convention, not code (Morpho is permissionless): the venue only surfaces markets it created — graduated launches vs WETH/USDC, conservative LLTVs from Morpho's canonical set (38.5%–62.5% by liquidity tier). Deploy script `contracts/script/DeployMorphoBlue.s.sol`; market-listing script `CreateMorphoMarket.s.sol`. Frontend — new 'pairs' tab in `frontend/src/pages/LendingPage.tsx` (extend `SECTION` list + `isDeployed` gating at lines 39/133); new hook `frontend/src/hooks/useMorphoMarket.ts`; `MORPHO_BLUE_ADDRESS` in `frontend/src/lib/constants.ts`. Data — new indexer tables `morphoMarket`, `morphoPosition`, `morphoLiquidation`; utilization/rate history feeds the UI.

**Fee wiring:** Enable Morpho's native fee switch at 10% of borrow interest per market (max is 25%; start low), `feeRecipient` = F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Borrowers pay; suppliers keep 90%.

**Gates:** Immutable-contracts law satisfied natively (Morpho Blue is immutable). The oracle adapter is the only audited-new code — echidna + halmos + adversarial review before any market lists. Honesty: every market card shows oracle source, TWAP window, and last-update; stale TWAP renders the market "no data" and blocks new borrows in the UI. Unsurfaced permissionless markets never render. Non-venue market creation stays undocumented/flag-gated until a quarter of clean operation.

**Done when:** (1) diff-guard CI green against the pinned Morpho commit; (2) supply→borrow→repay→liquidate exercised on a fork test and one mainnet market; (3) 10% fee skim arrives at the FeeRouter; (4) UI self-gates a market when its TWAP is stale.

### #21 — Curated stable-yield vaults

**Preconditions:** Item 14 live with ≥2 healthy markets. F7 (second fork intake in the wave). F1 (allocation + realized-APY data). Operator: Safe assumes MetaMorpho's owner/curator roles.

**The build:** Contracts — vendor `morpho-org/metamorpho` at its audited release commit into `contracts/lib/metamorpho` (F7 diff-guard); deploy the `MetaMorphoFactory` and two vaults VERBATIM, zero deltas: a USDC vault and a WETH vault. Allocations: own isolated pairs from item 14 plus a small allow-list of external blue-chip Morpho mainnet markets (wstETH/WETH, WBTC/USDC) — set via MetaMorpho's native timelocked `submitCap`/`setSupplyQueue` flows with the Safe as curator, guardian set for veto. Deploy script `contracts/script/DeployMetaMorphoVaults.s.sol`. Frontend — new page `frontend/src/pages/EarnPage.tsx` (this becomes the wave's earn hub; register in `navConfig.ts`), vault cards + a mandatory per-market allocation table; hook `frontend/src/hooks/useMetaMorphoVault.ts`; addresses in `constants.ts` behind `isDeployed()`. Backend — none new. Data — indexer tables `metaVaultAllocation` (per-market caps + current supply, from `ReallocateSupply`/`SetCap` events) and share-price history for realized APY.

**Fee wiring:** MetaMorpho's native performance fee set to 10% of yield (charged on interest accrual via share dilution — suppliers pay, only when yield exists), `feeRecipient` = F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Stacked underneath, the 14 markets' 10% interest skim also flows — disclose the stack on the card.

**Gates:** NO-stablecoin law explicitly complied and stated in-UI: the venue allocates external stables, it issues nothing. Verbatim fork, no deltas — audit wave covers only deployment parameters and role wiring. Honesty: the allocation table (market, cap, current, oracle) renders always; APY only from realized share-price history via F1, "no data" before 7 days of history; both fee layers disclosed on the deposit screen.

**Done when:** (1) both vaults live with Safe-curated caps and diff-guard green; (2) deposit→accrue→withdraw round-trips with the 10% fee minted to the FeeRouter; (3) EarnPage shows the full allocation table and gates APY pre-history.

### #22 — Stable yield router

**Preconditions:** Item 21 (own vaults are one destination), F3 (fee-on-top leg for external routing), scanner lib (`frontend/src/lib/scanner/`) for risk labels. Operator: none.

**The build:** Contracts — none new (minimal-attack-surface law; routing is client-side, fees ride the F3 leg). Frontend — a "Stable Router" section on `frontend/src/pages/EarnPage.tsx`: input USDC/USDT/DAI amount, output a ranked table of destinations — the venue's own MetaMorpho USDC vault (21), external Morpho vaults, Aave v3 mainnet, each with rate + risk label. New lib `frontend/src/lib/stableYield/` with `rates.ts` and `riskLabels.ts`; risk labels composed from the existing scanner adapters (`frontend/src/lib/scanner/ethereumAdapter.ts`) plus hand-written protocol dossiers (audit status, oracle type, admin keys) — each label carries a source and review date. One-click deposits execute direct wallet→protocol via each protocol's canonical contract, with the F3 fee leg attached for external destinations. Backend — new `frontend/api/_lib/stable-rates.js` on the aggregator catchall (`?resource=stable-rates`, lazy import per `heat.js`), reading rates on-chain through the existing `api/alchemy.js` provider path (no third-party yield aggregator as source of truth), cached ≤60s, Upstash-limited. Data — F1 records routed volume per destination for the honesty ledger.

**Fee wiring:** Two legs, both disclosed: (a) routing into the venue's own vault charges nothing extra — the 21 performance fee already applies; (b) external routing charges a 5 bps fee-on-top at deposit via F3 → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. No performance skim on external positions (the venue doesn't custody them — "may not spend capital it has not earned" stays clean).

**Gates:** NO-stablecoin law: the page states verbatim that the venue routes to stables and issues none. Honesty: rates timestamped, "live"/"cached" badge, any destination with a stale read (>5 min) self-gates to "no data" and its deposit button disables; risk labels always show source + date. Own-vault ranking gets no preferential placement — sort is strictly by net rate after all fees.

**Done when:** (1) an external Aave deposit routes with the 5 bps fee landing at the FeeRouter; (2) the table sorts by after-fee net rate with the venue's vault ranked honestly; (3) killing the rates resource gates every row.

### #30 — One-click leverage loops

**Preconditions:** Item 14 live and seasoned (loops execute against the venue's own Morpho markets). F4 keeper (auto-deleverage triggers). F7 (third fork intake). Whitelist limited to majors/LSTs — launched-token loops are out of scope.

**The build:** Contracts — vendor Morpho's bundler periphery (`morpho-org/bundler3` at its audited commit) into `contracts/lib/bundler3` VERBATIM; loops use the Morpho singleton's free flash loans: flashLoan → swap to collateral via the meta-router calldata → supplyCollateral → borrow → repay flash, all one atomic bundle. No custom looping contract. Whitelist: WETH/wstETH, WETH/weETH, USDC/WETH markets from 14's listing set, max leverage capped so entry LTV sits ≥10% below the market's LLTV. Deploy script `contracts/script/DeployBundler.s.sol`. F4 wires an optional stop-loss: user-signed conditional deleverage the keeper executes when health factor crosses a user-set floor. Frontend — 'Multiply' tab on `frontend/src/pages/LendingPage.tsx`; new lib `frontend/src/lib/loops/loopMath.ts` (leverage↔LTV math, liquidation-price calc, unit-tested like `limitOrderMath.ts`); reuse `frontend/src/components/PositionHealth.tsx` for live health display. Data — indexer `loopPosition` view derived from `morphoPosition` + bundler events; realized borrow-cost history.

**Fee wiring:** 10 bps origination on opened notional, taken as an F3 fee-on-top leg inside the bundle's swap step, → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Ongoing: the 14 markets' 10% interest skim applies to the loop's borrow — no extra spread is added (disclose both).

**Gates:** DEBATABLE flag: before shipping, add a written note to `docs/GOVERNANCE.md` distinguishing loops from perps under the no-perps law — fully collateralized spot borrow, no funding rate, no synthetic exposure, liquidation by Morpho's standard path; this is a clarification, not an amendment. Honesty: pre-trade screen shows liquidation price, current oracle price, worst-case loss, and both fee layers; no projected APY — only current net rate labeled "variable". Whitelist is flag-gated; additions need a quarter of market history.

**Done when:** (1) open→adjust→close round-trips atomically on mainnet at ≤ the advertised LTV cap; (2) keeper deleverage fires on a fork-test health breach; (3) origination fee lands at the FeeRouter; (4) pre-trade screen renders liquidation price from live oracle data or blocks the trade.

### #10 — Pooled money market (Aave v3 fork)

**Preconditions:** LAST in the wave by design: items 14/21/30 running clean for a full quarter first. F7's biggest single engagement — a dedicated adversarial audit wave for this item alone, plus running Aave's shipped Certora specs in `contracts/certora/`. F1 live. Operator: a written amendment to the immutable-contracts law (below) merged into `docs/GOVERNANCE.md` BEFORE deploy.

**The build:** Contracts — vendor `aave-dao/aave-v3-origin` at an exact audited release tag into `contracts/lib/aave-v3-origin`, VERBATIM (F7 diff-guard). Deploy pool, configurator, ACLManager, Collector, and Chainlink AaveOracle via Aave's own deployment tooling wrapped in `contracts/script/DeployAaveMarket.s.sol`. Listings: WETH, USDC, wstETH, WBTC only — no TOWELI, no launched tokens (they live in 14's isolated pairs; risk stays partitioned). "veTOWELI-boosted rates" WITHOUT touching pool code: a periphery `contracts/src/RebateDistributor.sol` (small, new, audited) that refunds a slice of the reserve-factor take to borrowers by veTOWELI weight read from TegridyStaking checkpoints — the fork stays byte-identical. Frontend — new `frontend/src/pages/MoneyMarketPage.tsx`; hook `frontend/src/hooks/useAaveMarket.ts`; constants entries behind `isDeployed()`. Data — indexer tables `aaveReserve` (rates/utilization history), `aaveUserPosition`, `aaveLiquidation`.

**Fee wiring:** ReserveFactor 15% of borrow interest per listed asset + Aave's 0.05% flash-loan premium, accruing to the Collector; an F4 keeper sweeps Collector → F3 FeeRouter monthly → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury; the RebateDistributor's boost budget is carved from the treasury share only (real-yield law: rebates are earned fees, not emissions).

**Gates:** HOUSE-LAW AMENDMENT (required, written first): Aave v3 is proxy-upgradeable; freezing it would be a non-verbatim delta that voids its battle-testing. The amendment: retain Aave's proxy architecture verbatim, with ProxyAdmin/ACL held by the Safe behind a 7-day public timelock, and a standing commitment that upgrades only ever track upstream Aave releases. Honesty: rates from live on-chain reads; health factors always shown; any oracle-feed staleness gates the affected reserve's UI.

**Done when:** (1) diff-guard + Certora green on the pinned tag; (2) dedicated audit report filed; (3) supply/borrow/liquidation/flash-loan exercised on mainnet; (4) Collector sweep lands in a RevenueDistributor epoch; (5) amendment merged before the deploy ceremony.

### #20 — Curator vault marketplace

**Preconditions:** Item 21 (MetaMorphoFactory already deployed — curators create vaults through it, zero new vault code). F8 (Heat + deployer-reputation attestations as the vetting layer). F2 (curator profiles). F1 (realized track records).

**The build:** Contracts — one small piece only: fee splitting. Vendor `0xSplits` `SplitMain` VERBATIM at its audited commit into `contracts/lib/splits` (F7 intake); each approved curator vault sets its MetaMorpho `feeRecipient` to an immutable 75/25 curator/venue Split. No custom marketplace contract — listing is a venue-side registry, not an on-chain permission (Morpho is permissionless anyway; the venue curates what it RENDERS). Deploy script `contracts/script/DeployCuratorSplits.s.sol`. Backend — new `frontend/api/_lib/curators.js` on the aggregator catchall (`?resource=curators`, lazy import): the curator registry (Supabase table, RLS per F2; application, F8 attestation hash, approved vault addresses). Frontend — 'Curators' tab on `frontend/src/pages/EarnPage.tsx`: vault cards showing curator identity (F2 profile), F8 attestation badge, realized performance from F1, allocation table (same component as 21); new lib `frontend/src/lib/curators/registry.ts`. Data — indexer extends `metaVaultAllocation`/share-price tracking to every listed curator vault; a `curatorTrackRecord` view aggregates realized APY, drawdown, and fee history per curator.

**Fee wiring:** Curator sets their MetaMorpho performance fee (venue cap for listing: ≤15% of yield). The Split routes 75% to the curator, 25% to the venue; the venue's 25% flows to the F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Depositors pay only when yield exists.

**Gates:** Verbatim forks throughout (MetaMorpho + SplitMain); the audit wave covers only Split wiring and registry auth. Honesty: curator track records ONLY from indexer-realized data — a new curator's card says "no history" with no projections; the F8 attestation renders with issuer and date; delisting removes rendering but is disclosed (funds stay withdrawable — the venue never custodies). Listing criteria published in `docs/GOVERNANCE.md`.

**Done when:** (1) an external curator's vault is listed, earns, and the 25% venue share arrives at the FeeRouter through the Split; (2) new-curator cards show "no history"; (3) registry writes require SIWE auth and RLS holds under test.

### #31 — Liquid locker hub (external ve-tokens)

**Preconditions:** F7 (major audit wave — this is real new surface), F4 keeper (vote casting, reward claiming, bribe collection cadence), item 18 (compounding path for locker yields). Explicitly NOT related to the existing `contracts/src/LockerClaimer.sol` (that is launcher fee-locker plumbing — do not conflate or reuse).

**The build:** Contracts — vendor Stake DAO's liquid-locker contract set (Depositor, sdToken, LiquidityGauge) VERBATIM at a pinned audited commit into `contracts/lib/sd-lockers` (F7 intake). Start with exactly ONE target protocol: vePENDLE (synergy with the item-23 desk; PENDLE flows already exist in-app). New dir `contracts/src/lockers/` holding only the concrete instantiations (constructor params, no logic deltas): `PendleDepositor`, `sdPENDLE` token, reward gauge. The venue's Safe holds the locker's vote rights initially; F4 keeper executes claims/votes on a published cadence. Deploy script `contracts/script/DeployPendleLocker.s.sol`. Frontend — 'Lockers' tab on `frontend/src/pages/EarnPage.tsx`; new lib `frontend/src/lib/lockers/` (deposit, live sdPENDLE/PENDLE peg from the secondary pool, exit-liquidity depth); hook `frontend/src/hooks/useLocker.ts`. Data — indexer tables `lockerDeposit`, `lockerHarvest`, `lockerPeg` (secondary-market price snapshots).

**Fee wiring:** 16% total skim on rewards flowing through the wrapper (boosted yield + bribe income collected by the keeper), taken at harvest in the reward token, converted via the meta-router, → F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Depositors keep 84% plus the boost they couldn't get solo.

**Gates:** Hard law line, stated in code comments and UI: this hub NEVER wraps veTOWELI — wrapping the venue's own lock would hollow out TegridyStaking. Honesty: the deposit screen says plainly that locking is PERMANENT and exit is only via the secondary market; live peg and pool depth render always; stale peg data gates deposits. Full adversarial audit before mainnet; second protocol flag-gated until vePENDLE runs a clean quarter.

**Done when:** (1) PENDLE→sdPENDLE deposit locks and the gauge accrues; (2) keeper harvest routes the 16% skim to the FeeRouter; (3) peg + permanence warnings render and self-gate on stale data; (4) grep proves no veTOWELI address appears anywhere in `contracts/src/lockers/`.

### #55 — Long-horizon vaults

**Preconditions:** Item 32 (LST zap route is the DCA target), item 18 (compounding), F4 keeper (scheduled DCA execution), F7 audit wave. Operator: none beyond the deploy ceremony.

**The build:** Contracts — no battle-tested fork exists for term-locked DCA savings, so this consciously amends the verbatim-fork law the approved way: one SMALL custom contract from OZ primitives in the house style of `TegridyStakingJbacVault.sol`, with the full F7 treatment (echidna, halmos, adversarial audit). `contracts/src/TegridySavingsLocker.sol`: user deposits WETH or USDC with a chosen term (1–10 years, per-term pools); an F4 keeper executes periodic DCA into ONE allow-listed LST per pool (wstETH via the item-32 zap path, fee-exempt internally); holdings sit in the item-18 harvest vault for auto-compounding. Early exit permitted always (never trap funds) with a penalty linearly decaying from 10% to 0% over the term; positions are non-transferable ERC-721 receipts. Deploy script `contracts/script/DeploySavingsLocker.s.sol`. Frontend — 'Savings' tab on `frontend/src/pages/EarnPage.tsx`; new lib `frontend/src/lib/savings/termMath.ts` (penalty curve, unit-tested); hook `useSavingsLocker.ts`; constants behind `isDeployed()`. Data — indexer tables `savingsPosition`, `savingsDca` (each keeper execution with price), `savingsPenalty`.

**Fee wiring:** 0.5%/yr management fee streamed on AUM (accrued at DCA checkpoints, no separate keeper cost to users) → F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury. Early-exit penalties: 50% redistributed pro-rata to remaining savers in the SAME term pool (their real yield — earned, not emitted), 50% to the FeeRouter split.

**Gates:** "May not spend capital it has not earned": penalties and management fees are the only venue take — no promised rates, ever. Honesty: the deposit screen shows term, penalty curve chart, and ONLY historical LST staking yield with source attribution — projected multi-year returns are banned copy; the UI must render "past yield, not a promise". Flag-gate with a TVL cap (e.g. 200 ETH) for the first quarter.

**Done when:** (1) deposit→2 keeper DCAs→early exit round-trips with penalty split verified on-chain; (2) audit filed for the custom contract; (3) no projected-return string exists in the page (copy test like `launchFeeCopy.test.ts`); (4) TVL cap enforced.

### #56 — Venue-graduates index & baskets

**Preconditions:** F1 (graduation + liquidity data — the constituent screen), F8 (Heat data productized), TegridyTWAP bootstrapped for every constituent, item 14 helpful but not required. F7 intake for the basket primitive.

**The build:** Contracts — vendor Reserve's Folio (DTF) contracts VERBATIM at their audited release commit into `contracts/lib/folio` (F7 diff-guard); Folio gives ERC-4626-adjacent baskets with in-kind mint/redeem, timelocked rebalance auctions, and native fee handling — no custom basket code. Deploy one flagship basket, TGRAD: Heat-weighted graduated launches. Constituent rules (published, mechanical): graduated on the venue, TWAP live ≥30 days, on-chain liquidity floor from F1, cap N=10. Weights: computed off-chain from the island's raw `degrees` (via `frontend/src/lib/heat/heatClient.ts`) × liquidity caps — this is a VENUE methodology derived from island data, so per the `api/_lib/heat.js` honesty boundary it must be labeled "Tegridy weighting using Jungle Bay Island Heat data (reckoned <date>)", never presented as the island's own score. Rebalances proposed by the Safe through Folio's timelocked auction flow. Deploy script `contracts/script/DeployGraduatesIndex.s.sol`. Frontend — 'Index' tab on `frontend/src/pages/EarnPage.tsx`; new lib `frontend/src/lib/index-baskets/weights.ts` (weight computation, unit-tested, deterministic from published inputs); mint/redeem UI. Data — indexer tables `basketConstituent` (weight history), `basketNav`, mint/redeem events.

**Fee wiring:** 0.75%/yr AUM fee (Folio's native tvl-fee, streamed via share dilution) + 0.25% mint and redeem fees, all to the F3 FeeRouter → ≥50% stakers via RevenueDistributor, ≤25% POLAccumulator, remainder treasury.

**Gates:** Verbatim fork; audit wave covers deploy params + the weights lib only. Honesty: constituents, exact weights, methodology doc link, Heat reckoning date, and NAV source render on the card always; stale Heat or TWAP on any constituent freezes rebalance proposals and badges the basket "weights stale"; the small-category economics get honest copy — no "index fund revolution" framing. Fixed-supply-TOWELI untouched (TOWELI is never a constituent).

**Done when:** (1) TGRAD mints/redeems in-kind on mainnet with fees at the FeeRouter; (2) a rebalance executes through Folio's timelocked auction from a published weight computation anyone can reproduce; (3) stale-Heat freeze verified in test.


## Wave 5 — Pro & B2B

Wave 5 turns the venue from a retail terminal into a professional desk and a B2B vendor. The order is deliberate: the perps desk (8) leads because it is the largest confirmed fee line and needs only a law amendment plus UI, no contracts; the two APIs (41, 42) productize routing and indexer data as soon as F5 billing exists; the points desk (58) reuses the existing Supabase orderbook while its escrow contract clears the F7 audit queue; wallet UX (44, 48) rides F6 and multiplies conversion on every other item; automation (53, 54) rides F4's keeper/trigger engine and shares its receipt discipline; engagement (50, 51) monetizes the F1 indexer that is by then serving the data API; copy-vaults (57) is the wave's only heavyweight new contract and goes last in the audit queue; the venue wallet (45) starts as design-only because its XL build must not block the wave. Shared risks: everything backend-shaped must respect the Vercel 12-function cap (catchall ?resource= pattern or the F5 escape), every new fee leg must terminate in SwapFeeRouter's guarded split (stakers ≥50%, POL ≤25%, remainder treasury), and three items (8, 58, and 51's redemption budget) touch house law and must ship their written amendments or earned-capital caps before code.

### #8 — Hyperliquid builder-code perps desk

**Preconditions:** The written no-perps law amendment MUST land first: add `docs/LAW_AMENDMENT_2026_PERPS.md` stating the venue routes perps orders to Hyperliquid's book via builder codes, deploys zero perps contracts, holds no user margin, runs no oracle; then grep the repo docs for every "no perps" claim and update each to cite the amendment. F2 (SIWE live) optional; no foundation hard-dependency. Operator: register the treasury Safe-controlled builder address on Hyperliquid and set the builder fee.

**The build:** Zero contracts. Frontend: new `frontend/src/pages/PerpsPage.tsx` + `frontend/src/lib/perps/hyperliquid.ts` (typed REST/WS client for HL's public info + exchange endpoints; all order signing is client-side EIP-712 with the connected wallet — we never touch keys). First-use flow calls HL's `approveBuilderFee` action so every subsequent order carries our builder code (cap 0.1%). Reuse `frontend/src/lib/formatting.ts`, `txErrors.ts`, and the TradePage layout conventions. Backend: HL's API is called directly from the browser; if CORS blocks any endpoint, add lazy `?resource=hyperliquid` to `frontend/api/aggregator.js` per the `api/_lib/heat.js` pattern — no new function. Register the page in `frontend/src/lib/navConfig.ts` behind a feature flag.

**Fee wiring:** Builder fee 0.05% per order (cap 0.1%), paid by the trader, accrues in USDC to the builder address on Hyperliquid. Ops claims monthly, bridges to mainnet, converts to ETH, and deposits into `SwapFeeRouter` so the guarded split applies: stakers ≥50% via RevenueDistributor, POL ≤25%, remainder treasury.

**Gates:** Law amendment is the gate — no code merges before it. Honesty: label the venue as Hyperliquid everywhere, render liquidation/leverage risk plainly, and self-gate the whole page to "Hyperliquid unreachable" when the WS feed drops (no cached books). No F7 audit wave (no contracts); security review of the signing path only. Flag-gated until the first fee claim round-trips.

**Done when:** (1) an order placed through the UI shows our builder code on HL's explorer; (2) builder fees accrue and one claim reaches SwapFeeRouter with the split visible on-chain; (3) killing the WS feed blanks the page to an honest error state.

### #41 — Meta-router swap API (B2B)

**Preconditions:** F5 (API keys, metering, billing, and the serverless-budget escape — this cannot fit the Hobby cap), F3 (fee-on-top transfer leg + periphery FeeRouter contract), F7 for the fee leg's audit. Item 8 independent.

**The build:** Contracts: none new beyond F3's periphery FeeRouter (the fee-on-top leg is F3's deliverable; do not re-specify it). Backend: port the fan-out logic of `frontend/src/lib/aggregator.ts` (the 7 `AggregatorSource` providers) to the F5 host as `POST /v1/swap/quote` and `POST /v1/swap/build`, reusing the provider allowlists and schema validation from `frontend/api/_lib/aggregator-proxy.js` and `proxy-schemas.js` verbatim — one routing brain, two consumers. `build` returns calldata that composes the F3 fee leg with `integratorFeeBps` (validated 0–100) and the integrator's payout address. Ship a thin typed SDK extracted from `aggregator.ts` types into `packages/tegridy-swap-sdk/` plus an embeddable iframe widget page `frontend/src/pages/WidgetSwapPage.tsx` (chrome-less TradePage swap panel reading `?apiKey=&feeBps=` params). Document in `docs/API.md`. Frontend for us: none else.

**Fee wiring:** Integrator sets 0–100bps, paid by the end trader in the sell token via the F3 fee leg. The leg splits at source: 80% to the integrator's address, 20% platform share (floor: 15bps effective on integrator fees ≥75bps) routed to `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury remainder. Surplus capture: 50% of positive slippage on `build`-generated routes, same path.

**Gates:** Verbatim reuse of existing proxy code satisfies minimal-attack-surface; the only new contract surface is F3's, which needs its F7 wave before mainnet `build` responses go live (until then the API is quote-only — honesty-gate `build` to 501). Never synthesize quotes: if all seven providers fail, return "no route," never an interpolated price.

**Done when:** (1) an external API key fetches a quote and executes a swap whose fee-leg transfer is visible on-chain with the 80/20 split; (2) F5 metering bills the calls; (3) provider outage returns honest no-route, not fabricated pricing.

### #42 — Portfolio & PnL data API

**Preconditions:** F1 (Ponder indexer deployed + hosted — the whole product is the indexer with a paywall), F5 (keys/metering/billing + budget escape), F8 for the Heat endpoints' attribution rules. Item 41's F5 host can be shared.

**The build:** Data: extend `indexer/ponder.schema.ts` with a `pnlLot` table (wallet, token, lot amount, cost basis in ETH, acquired block) populated in `indexer/src/index.ts` from the existing `swap` and `pairEvent` tables using FIFO lot accounting; add a `walletDay` rollup for time-series. Backend: REST façade on the F5 host wrapping the Ponder GraphQL API (`indexer/src/api/`): `GET /v1/portfolio/:address` (holdings), `GET /v1/pnl/:address` (realized from closed lots, unrealized marked to `TegridyTWAP`-sourced or indexed pool price, each labeled), `GET /v1/launches/:token/afterlife` (port the read logic of `frontend/src/lib/launcher/outcomes.ts` / `afterlifeLedger.ts` server-side), `GET /v1/heat/:address` (forward per `frontend/api/_lib/heat.js` rules — attribute to Jungle Bay Island, surface reckoning date, never re-tier). Contracts: none. Frontend: an API docs + key-management page `frontend/src/pages/DevelopersPage.tsx` using F5's key UI.

**Fee wiring:** Metered subscription tiers via F5 (Stripe): free 1k req/day, $49/mo, $299/mo. Revenue lands in the treasury account; monthly, an earned-revenue slice is converted to ETH and deposited into `SwapFeeRouter` so stakers ≥50% / POL ≤25% / treasury applies. No per-trade leg.

**Gates:** Honesty is the product: every response carries `coverage: {fromBlock, toBlock, chains}` and PnL for wallets with pre-indexer history returns `partial: true` — never backfill by estimation. Heat endpoints obey the display-grade boundary in `api/_lib/heat.js` (no gating semantics). No contracts, no audit wave; F5 rate limiting via the `api/_lib/ratelimit.js` pattern.

**Done when:** (1) a paid key's PnL response matches a hand-computed spot-check wallet; (2) coverage metadata correctly flags a pre-indexer wallet as partial; (3) tier limits enforce and billing invoices.

### #58 — Points desk (pre-TGE OTC)

**Preconditions:** F2 (SIWE + Supabase RLS — the desk reuses the existing orderbook rails), F7 (audit wave — this custodies collateral), F3 conventions for the fee sink. Operator: written DEBATABLE acknowledgment in `docs/GOVERNANCE.md` noting pre-TGE points trading's legal posture before mainnet deploy.

**The build:** Contracts: at F7 intake, attempt a verbatim fork of Whales Market's published EVM pre-market escrow at an exact commit; if no audited source is verifiable, consciously amend the verbatim-fork law (write it in the PR) and build `contracts/src/TegridyPreMarket.sol` minimal: two-sided escrow — buyer deposits payment (ETH/stable), seller deposits collateral ≥100% of trade value, both immutable once matched; at TGE the operator sets the settlement token + window via a timelocked call (mirror `RevenueDistributor`'s propose/execute pattern); seller delivers or the window lapses and collateral forfeits to the buyer. Deploy script `contracts/script/DeployPointsDesk.s.sol`. Backend: order listing/matching through the existing `frontend/api/orderbook.js` Supabase orderbook (new `premarket_orders` table with RLS); no new function. Frontend: `frontend/src/pages/PointsDeskPage.tsx` + `frontend/src/lib/pointsDesk/{escrow.ts,markets.ts}`; gate rendering on `isDeployed()` from `frontend/src/lib/constants.ts`. Defer the farming autopilot to a follow-up — EV labels without positions data would violate honesty.

**Fee wiring:** 2.5% from each side, charged at settlement (and on forfeiture, from collateral), accrued in the escrow and swept to `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury.

**Gates:** DEBATABLE flag + governance note required. Full F7 adversarial audit + fork tests before deploy (collateral custody). Honesty: every market shows settlement terms, forfeit rules, and "points are unpriced claims" verbatim; no market renders without at least one on-chain-escrowed order.

**Done when:** (1) fork test exercises match → deliver and match → forfeit paths; (2) fees from a settled trade reach SwapFeeRouter; (3) UI refuses to render a market with zero escrowed orders.

### #44 — Embedded wallets (social login)

**Preconditions:** F6 (embedded-wallet vendor selection + config is F6's deliverable — this item is the venue integration of it). F2 helps (SIWE session continuity) but is not blocking.

**The build:** Contracts: none — never build custody. Frontend: add the F6-selected SDK (Privy-class) as an additional wagmi connector in `frontend/src/lib/wagmi.ts`; new `frontend/src/lib/embedded/embeddedConnector.ts` isolating all vendor SDK imports behind one module (so the vendor is swappable and the bundle is code-split), plus `frontend/src/lib/embedded/embeddedSession.ts` for login-state handling. Extend the existing wallet-connect modal component to offer "Continue with email/social" above the extension options, flag-gated via a `VITE_EMBEDDED_WALLETS` env check. Verify the connector satisfies every existing signing path: swap approvals in `frontend/src/lib/swapRouting.ts`, SIWE in `frontend/api/auth/siwe.js`, EIP-712 flows (`cowSwap.ts`, Seaport in `src/nakamigos/`). Solana: only if the F6 vendor ships wallet-adapter support; otherwise the Solana pages keep the existing adapter untouched. Backend: none — auth stays vendor-side; env vars `VITE_EMBEDDED_APP_ID` (client) only, no server secret.

**Fee wiring:** No new fee. Indirect: widens the funnel for every existing line (swap fees via SwapFeeRouter, launcher integrator fees via `frontend/src/lib/launcher/integratorFees.ts`, marketplace fees). Later white-labeling of the onboarding kit to launched projects is a separate F5-billed item — do not build it here.

**Gates:** House law: no custody code, no key material in our repo — SDK-only integration is the minimal surface. Honesty: label the wallet as vendor-custodied MPC (name the vendor) in the connect modal and FAQ; never present it as self-custody. Flag-gated until a full fee-paying journey is proven. No audit wave (zero contracts).

**Done when:** (1) email login → funded wallet → completed swap paying normal fees; (2) SIWE login works from the embedded wallet; (3) with the flag off, existing connectors behave byte-identically.

### #45 — Venue wallet + extension (design only this wave)

**Preconditions:** Item 41 live (the wallet's swap engine is the meta-router API — no API, no wallet business case), item 44 shipped (funnel data proves demand), F6 learnings documented. This wave produces a DESIGN, not code — the XL build starts only after a written go decision.

**The build:** Write `docs/VENUE_WALLET_DESIGN.md` covering: (1) fork base — evaluate open-source extension wallets for a verbatim fork per house law; verify licenses at F7-intake standard (MetaMask's license restricts commercial forks — likely disqualifying; Rabby and Block Wallet are the candidates to license-check at exact commits). The keyring/signing core MUST be inherited verbatim, never rewritten. (2) Swap integration: in-wallet swaps call `POST /v1/swap/build` from item 41 with the venue as integrator — the wallet is customer zero of our own B2B API, proving it. (3) Fee schedule: in-wallet swap fee 0.5% (undercutting MetaMask's 0.875%) via the F3 fee leg. (4) Scope cuts: extension-only first, no mobile, no custom networks UI, no built-in bridge — DELETE before ADD. (5) Security posture: what the fork inherits audited, what our delta is (target: delta = branding + swap tab + default RPC list), and the F7 wave required for any delta touching signing. (6) Distribution: Chrome Web Store review timeline, update cadence, key-compromise incident plan referencing `docs/INCIDENT_RESPONSE.md`. Include a build-vs-not recommendation with cost. Optionally a throwaway spike branch proving the fork builds — no merges to main.

**Fee wiring:** Design-stage only: 0.5% in-wallet swap fee, payer is the trader, path is the item-41 fee leg → `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury.

**Gates:** No deployable output this wave — that is the gate. The design must state the verbatim-fork compliance plan and the full F7 audit scope before any go decision.

**Done when:** (1) design doc merged with license verification evidence for the chosen fork base; (2) delta surface enumerated file-by-file; (3) explicit go/no-go recommendation with staffing and audit cost.

### #48 — Gas abstraction + session keys

**Preconditions:** F6 (4337 paymaster relationship + scoped session keys are F6 deliverables), item 44 (embedded wallets are the natural 4337 accounts), `PremiumAccess` live (it is — used for the premium sponsorship gate).

**The build:** Contracts: none of our own initially — use the F6-selected hosted paymaster (Pimlico/Alchemy class) for both ERC-20 gas and sponsorship; an owned verbatim-fork paymaster is a later item (minimal attack surface now). Frontend: extend `frontend/src/lib/eip5792.ts` (already handles `wallet_sendCalls` capabilities) to attach the paymaster capability when the connected account supports it; new `frontend/src/lib/gas/{paymaster.ts,sponsorBudget.ts}` — `paymaster.ts` builds the ERC-20-gas and sponsored-gas capability payloads, `sponsorBudget.ts` reads the live sponsorship budget and self-gates. Session keys: wire F6's scoped keys (spend cap + expiry) into a "sign once per session" toggle on `TradePage.tsx`, scoped strictly to router + approval targets from `frontend/src/lib/contracts.ts`. Backend: lazy `?resource=gas` in `frontend/api/aggregator.js` (per `api/_lib/heat.js` pattern) exposing the sponsorship budget remaining and countersigning sponsorship requests for verified premium holders (checks `PremiumAccess.hasPremium` via `api/_lib/ethcall.js`); env `PAYMASTER_API_KEY`, `SPONSOR_BUDGET_ETH_MONTHLY`.

**Fee wiring:** ERC-20 gas: 7% markup over actual gas cost, paid by the user in the traded token, collected by the paymaster flow to the treasury account. Sponsored gas: paid BY treasury, capped monthly at ≤5% of the prior month's realized fee revenue (read from RevenueDistributor history) — "may not spend capital it has not earned," enforced in `sponsorBudget.ts` and the resource handler.

**Gates:** Earned-revenue cap is the law-compliance mechanism — budget exhausted means the UI honestly says "sponsored gas exhausted this month," never silent fallback billing. Session keys flag-gated until spend-cap enforcement is demonstrated on mainnet. No audit wave (no owned contracts); review the session-key scoping config in F7's harness anyway.

**Done when:** (1) a swap settles with gas paid in the traded token, markup visible; (2) a premium user gets a sponsored tx and the budget decrements; (3) budget exhaustion self-gates honestly; (4) a session-key tx exceeding its spend cap reverts.

### #50 — Trading competitions

**Preconditions:** F1 (indexer live — scoring reads only indexed data), F2 (SIWE identity for registration), item 51's season plumbing shared (`frontend/src/lib/season.ts`). Operator: first sponsor or prize commitment from earned treasury funds.

**The build:** Contracts: none for season one — prizes escrowed in the treasury Safe and paid via published tx receipts; a `CompetitionEscrow.sol` only if sponsor volume later justifies its F7 wave. Data: scoring derives exclusively from the indexer's `swap` table plus SwapFeeRouter fee events — only fee-paying routed volume counts, which is the wash-resistance-by-construction claim: wash trading costs the full venue fee, making manipulation strictly unprofitable at the prize sizes offered. Add a `competitionScore` rollup materialization in `indexer/src/index.ts` (wallet, bracket, window, volume, realized PnL from item 42's `pnlLot` lots). Backend: lazy `?resource=competitions` in `frontend/api/aggregator.js` → new `frontend/api/_lib/competitions.js` (registration writes to a Supabase `competition_entries` table with RLS; standings read the indexer GraphQL). Frontend: new `frontend/src/pages/CompetitionsPage.tsx` + `frontend/src/lib/competitions/{brackets.ts,scoring.ts}`; reuse `seasonStatus()` from `season.ts` for window phases (its expired-renders-as-expired discipline applies verbatim) and cross-link from `LeaderboardPage.tsx`.

**Fee wiring:** Free brackets: sponsor/treasury-funded from earned revenue only. Paid-entry brackets: entry fee in ETH, 10% rake, 90% to the bracket pool; the rake goes to `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury. Volume uplift feeds every existing fee line.

**Gates:** Earned-capital law: prize commitments never exceed realized revenue + collected sponsorships. Honesty: standings labeled "indexed on-chain volume only," no fake participant counts, results reproducible from public data. Paid entries flag-gated until a free season completes cleanly.

**Done when:** (1) a bracket scores identically from an independent indexer replay; (2) window phases render per `season.ts` semantics (ended shows ended); (3) first payout published with tx receipts matching standings.

### #51 — Tegridy Seasons (quests & points)

**Preconditions:** F1 (quest completion verified from indexed events, never client claims — `pointsEngine.ts`'s existing on-chain-authoritative rule generalized), F2 (identity + RLS), `PremiumAccess`/SwapFeeRouter discount plumbing live (it is: `MAX_PREMIUM_DISCOUNT_BPS` exists in `SwapFeeRouter.sol`).

**The build:** Contracts: none new — redemption reuses the existing premium-discount mechanism. Frontend: extend `frontend/src/lib/pointsEngine.ts` (keep its security posture: on-chain/indexed data authoritative, localStorage a paint cache) and `frontend/src/lib/season.ts` for multi-season windows; new `frontend/src/pages/SeasonsPage.tsx` + `frontend/src/lib/seasons/{quests.ts,redemption.ts}`; surface progress on `LeaderboardPage.tsx`. Backend: lazy `?resource=seasons` in `frontend/api/aggregator.js` → new `frontend/api/_lib/seasons.js`: quest definitions in a Supabase `quests` table (predicate = indexer GraphQL query + threshold), accrual job verifies each claimed completion against F1 data, ledger in `season_points` with RLS. B2B: launched projects buy quest slots (flat fee, invoiced via F5 billing) — their quest predicates still verify against indexed actions only; document in `docs/API.md`.

**Fee wiring:** Inbound: B2B quest-slot fees ($500–$2,000 flat per slot per season) to treasury via F5 billing. Outbound: points redeem ONLY for fee discounts through the SwapFeeRouter premium-discount path — never a token promise (fixed-supply TOWELI stays untouched). Redemption budget capped per season at ≤10% of prior-season realized fee revenue; when exhausted, redemptions honestly pause.

**Gates:** Earned-capital law: the redemption cap is the compliance mechanism, enforced server-side in `seasons.js`. Honesty: quest progress renders only from verified indexed events ("pending verification," never optimistic completion); expired seasons render as ended per `season.ts`. No audit wave (no contracts). B2B slots flag-gated until season one's verification pipeline is proven.

**Done when:** (1) a quest completes solely from an indexed on-chain action with the client offline; (2) a redemption measurably discounts a live swap's fee; (3) a B2B slot is invoiced and its quest runs; (4) budget exhaustion pauses redemptions honestly.

### #53 — Liquidation shield

**Preconditions:** F4 (keeper network + shared trigger engine + retry/receipt discipline — the monitor loop is F4's, this item supplies the strategy), F1 (position indexing), F7 (audit wave — mandatory, this contract moves user debt), F6 session keys optional. `TegridyLending` deployment is NOT a precondition — launch against Aave v3 positions first (bigger market), add own-lending support when it deploys.

**The build:** Contracts: at F7 intake, vendor DeFi Saver's automation contracts (github.com/defisaver/defisaver-v3-contracts, exact commit) and fork VERBATIM the subscription/strategy-executor pattern; minimal delta = our fee sink address and the strategy set reduced to exactly two actions (flashloan-repay via Aave v3 flashLoanSimple, and deleverage) — DELETE before ADD applies to the strategy library. New `contracts/src/ShieldExecutor.sol` (the delta-bearing wrapper), deploy script `contracts/script/DeployShield.s.sol`. Users subscribe on-chain: trigger health factor, target HF, max repay, revocable approval. Backend: F4 keeper watches subscribed positions' HFs (RPC reads, indexer for discovery); trigger engine fires the executor; receipts per F4 discipline. Frontend: new `frontend/src/pages/ShieldPage.tsx` + `frontend/src/lib/shield/{subscription.ts,healthFactor.ts}`; gate on `isDeployed()` from `constants.ts`; link from `LendingPage.tsx`.

**Fee wiring:** 0.25% of the repaid amount per triggered save + 0.05% automation surcharge (DeFi Saver's own schedule), taken in the repaid asset inside the executor, converted and forwarded to `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury. User pays only on successful saves.

**Gates:** Full F7 adversarial audit + mainnet-fork test suite before deploy (flashloan surface). Honesty: marketed as "best-effort automation," never "liquidation-proof"; the UI shows keeper latency stats and every historical trigger receipt (including failures) from F4's ledger. Flag-gated to allowlisted wallets for the first month.

**Done when:** (1) mainnet-fork test: position driven under trigger HF, shield fires, HF restored, fee event emitted with correct split; (2) subscription revocation immediately stops execution; (3) a failed save renders honestly in the receipt log.

### #54 — Robo rebalancer

**Preconditions:** F4 (trigger engine + keeper receipts), item 41 (server-side meta-router `build` endpoint executes the trades), F6 session keys (the execution credential), F1 (holdings snapshots via item 42's portfolio data). No new contracts, so no F7 wave — that is a design constraint, not an accident.

**The build:** Contracts: none — execution uses F6 scoped session keys (spend-capped, expiring, scoped to the F3 fee-leg router) so the venue never holds funds; for Safe users, offer the ComposableCoW path via the existing `frontend/src/lib/composableCow.ts` module's conventions instead. Frontend: new `frontend/src/pages/RebalancerPage.tsx` + `frontend/src/lib/rebalancer/{policy.ts,drift.ts,execution.ts}` — `policy.ts` defines target allocations + drift bands (e.g., rebalance when any asset drifts >5% absolute from target), `drift.ts` computes drift from item-42 portfolio reads, `execution.ts` builds trades via the item-41 API. Follow `composableCow.ts`'s honesty precedent: EOAs without session-key support self-gate to "manual rebalance" with one-click prepared trades. Backend: policies stored in Supabase (`rebalance_policies`, RLS per F2); F4's shared trigger engine evaluates drift on its tick and dispatches through the keeper with retry/receipt discipline. Env: none new beyond F4/F6's.

**Fee wiring:** 7bps per rebalance trade (within the 5–10bps range), paid by the user, taken via the F3 fee-on-top leg on each routed trade → `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury — stacked on normal routing fees, disclosed as a single all-in number in the UI.

**Gates:** No projected returns, no backtests, no APY language — the page shows only realized rebalance history from F4 receipts (honesty-gating). Session-key scope must be verifiably limited to the router; publish the scope in the UI. Flag-gated until 30 days of receipts with zero out-of-band executions.

**Done when:** (1) a 60/40 policy auto-executes on real drift with a session key, receipt logged; (2) fee split verified on-chain for a rebalance trade; (3) revoking the session key halts execution immediately; (4) an unsupported wallet self-gates to manual mode.

### #57 — Copy-vaults (spot strategies)

**Preconditions:** F1 (vault PnL rendered from indexed data), F3 (fee legs on vault trades), F7 (audit wave — custodies deposits), F8 (Heat gating for leaders: signed attestations). Items 41/42 helpful, not blocking.

**The build:** Contracts: base on the vendored `contracts/lib/solmate` ERC-4626 (battle-tested, already in-repo — verbatim-fork law satisfied at the primitive layer) rather than forking dHEDGE's sprawling PoolLogic (minimal attack surface + DELETE-before-ADD favor the narrow contract). New `contracts/src/TegridyCopyVault.sol` + `TegridyCopyVaultFactory.sol`: deposits/withdrawals per 4626; the leader may ONLY call an allowlisted execution target (TegridyRouter + the F3 fee-leg periphery — immutable allowlist set at vault creation, no arbitrary calls, no transfers out); per-share high-water-mark accounting for the profit share; deposit caps at launch. Leader eligibility: factory requires an F8 signed Heat attestation (tier ≥ Resident) verified on-chain, mirroring the pattern in `frontend/src/lib/heat/attestation.ts`. Deploy script `contracts/script/DeployCopyVaultFactory.s.sol`. Frontend: new `frontend/src/pages/VaultsPage.tsx` + `frontend/src/lib/vaults/{vaultClient.ts,hwm.ts}`; gate on `isDeployed()`. Data: index vault events in `indexer/ponder.schema.ts` (`vaultAction`, `vaultShareValue` tables) — all displayed PnL derives from these.

**Fee wiring:** 10% leader profit share above the high-water-mark, crystallized on withdrawal; the venue takes 20% of the leader's share (2% of profits) → `SwapFeeRouter` → stakers ≥50% / POL ≤25% / treasury. Plus normal routing fees on every vault trade via the allowlisted router.

**Gates:** Full F7 adversarial audit + fork tests before mainnet (deposit custody + HWM math). Honesty: vault pages render ONLY indexer-derived realized performance — no leader-supplied track records, no projections; a vault younger than 30 days is labeled so. Per-vault and global TVL caps flag-gated up gradually.

**Done when:** (1) fork tests cover deposit → leader trade → profitable and unprofitable withdrawal with correct HWM crystallization; (2) a sub-Resident Heat attestation is refused by the factory on-chain; (3) a leader call to a non-allowlisted target reverts; (4) displayed vault PnL matches an indexer replay.


## Wave 6 — Social & identity

Wave 6 turns the dormant social layer (SIWE auth, dm_messages/chat tables from frontend/supabase/migrations/007, profiles from F2) into a fee-earning identity economy. Everything here presumes F2 login is live; nothing ships before it. The order is deliberate: 75 and 76 are the smallest possible proofs of the layer and they mint the one shared primitive — an immutable, ownerless TegridyPayRail contract with per-context fee splits — that 77, 82, and 84 reuse instead of growing new payment surfaces (DELETE before ADD applied to contracts themselves). Gating comes next (77 clubs, 79 the Heat bot) because it monetizes reputation the repo already computes. 82 lights up the already-deployed-but-dark MemeBountyBoard before any new escrow code exists. 83 is the wave's only large fork, and it is config-only verbatim PoolTogether V5. The speculation products (73 content coins, 74 creator keys) sit late and open with written DEBATABLE amendments plus mandatory honest buy-screen framing; 84 (fantasy leagues) is last because it is boom-bust by design and gambling-shaped. Shared risks: the Vercel 12-function cap forces every new backend surface through the aggregator.js ?resource= catchall until F5's escape; the Heat oracle is third-party and every gate must fail closed to "no data", never admit-by-default; and three items (75's rail, 78's vouching, 84's escrow) consciously amend the verbatim-fork law with small custom contracts, so each carries a full F7 adversarial audit before its Safe deploy ceremony.

### #75 — Paid DMs / attention market

**Preconditions:** F2 live (SIWE via `frontend/api/auth/siwe.js`, `dm_messages` RLS from `frontend/supabase/migrations/007_p2p_trades_and_chat.sql`, profile surfaces). F3 FeeRouter deployed. F7 audit slot + Safe deploy ceremony.

**The build:** No battle-tested verbatim source exists for a pay-to-message rail, so write one minimal shared primitive the whole wave reuses: `contracts/src/TegridyPayRail.sol` (~80 LoC) — immutable, ownerless; `pay(bytes32 context, address recipient) payable` splits msg.value by immutable per-context feeBps fixed in the constructor (DM=1500, TIP=100, CLUB=1000, BOUNTY=1000), forwards the recipient share via solady SafeTransferLib (`contracts/lib/solady`), sends the venue share to the F3 FeeRouter, emits `Paid(context, payer, recipient, amount, fee, ref)`. Deploy script `contracts/script/DeployPayRail.s.sol`. Backend: migration `frontend/supabase/migrations/016_paid_dm_pricing.sql` adds `dm_prices(wallet, price_wei)` with owner-write RLS; add a `?resource=paid-dm` branch in `frontend/api/aggregator.js` (above the `const provider` line, lazy import) to `frontend/api/_lib/paid-dm.js`, which verifies the payment receipt via `frontend/api/_lib/ethcall.js` (Paid event: context=DM, correct recipient, amount ≥ price) before the `dm_messages` INSERT path in `frontend/api/supabase-proxy.js` accepts a stranger's message. Frontend: new `frontend/src/components/community/PaidDMGate.tsx` (price display, pay-then-send flow via wagmi); price setter on the F2 profile editor.

**Fee wiring:** Sender pays the recipient's posted price; the rail splits 85% recipient / 15% venue atomically. Venue share → F3 FeeRouter → RevenueDistributor (stakers) / treasury / POLAccumulator at the live SwapFeeRouter ratios (stakerShareBps ≥ 5,000, POL ≤ 2,500, remainder treasury).

**Gates:** Conscious amendment of the verbatim-fork law (no fork source exists); mitigated by ~80 LoC, zero admin, immutability, full F7 adversarial audit + echidna. Honesty: copy sells inbox delivery only — never "reply guaranteed". UI gated on `isDeployed(PAY_RAIL_ADDRESS)` in `frontend/src/lib/constants.ts`.

**Done when:** paid message from a fresh wallet lands e2e on mainnet; unpaid stranger INSERT rejected server-side (not just UI); the 15% fee shows in RevenueDistributor epoch accounting; zero-price wallets are unaffected.

### #76 — Native tipping rails

**Preconditions:** Item 75 shipped (TegridyPayRail live with TIP context). F1 indexer deployed (leaderboard source). F2 profiles/chat live.

**The build:** No new contract — the rail's TIP context is the entire on-chain surface (DELETE before ADD). Frontend: new `frontend/src/components/community/TipButton.tsx` — one-tap ETH tip calling `pay(TIP, recipient)` with the `ref` bytes32 encoding the surface (chat message id hash, bounty submission id, launch token address). Mount it on chat message rows in `frontend/src/pages/CommunityPage.tsx`, on F2 profiles, on submission cards in `frontend/src/components/community/BountiesSection.tsx`, and on launch pages (`frontend/src/pages/CurveLaunchPage.tsx`, `LaunchPage.tsx`). ERC20 tips deferred: ETH-only v1; token→ETH conversion happens through the existing swap UI, which already captures SwapFeeRouter fees. Data: add a `tips` table to the Ponder indexer in `indexer/` keyed on `Paid` events with context==TIP; new "Tippers" tab on `frontend/src/pages/LeaderboardPage.tsx` querying it through the F1 GraphQL client. Points: `frontend/src/lib/pointsEngine.ts` stays on-chain-derived — tip points come from indexed events only, never client claims.

**Fee wiring:** Tipper pays the face amount; the rail skims 1% (the immutable 100bps TIP context), recipient receives 99%. Venue 1% → F3 FeeRouter → staker/treasury/POL at the live SwapFeeRouter ratios. Conversion swaps additionally ride the existing ≤1% SwapFeeRouter fee.

**Gates:** House-law clean — reuses the rail audited in item 75's wave, zero new attack surface. Honesty-gating: the leaderboard renders exclusively from F1 data; if the indexer is unreachable the tab self-gates to "no data" rather than showing cached ranks. TipButton hidden unless `isDeployed()`.

**Done when:** a tip lands on-chain and appears indexed within ~1 minute; leaderboard totals match an independent on-chain sum for a sampled wallet; the 1% fee arrives at the F3 FeeRouter.

### #77 — Token-gated clubs

**Preconditions:** F2 (chat + SIWE), F8 (Heat served with attestations), item 75 (rail CLUB context). Item 74 later adds key-gating as one more gate type.

**The build:** Migration `frontend/supabase/migrations/017_clubs.sql`: `clubs(id, owner_wallet, gate_type, gate_params jsonb, entry_price_wei)`, `club_members(expires_at)`, `club_messages`, member-only RLS following the hardening pattern of `015_drop_permissive_policy_overrides.sql`; add the tables to `ALLOWED_TABLES` in `frontend/api/supabase-proxy.js`. Gate verification is server-side only: new `?resource=club-gate` branch in `frontend/api/aggregator.js` → `frontend/api/_lib/club-gate.js`, which checks ERC20/721 balances via `frontend/api/_lib/ethcall.js`, veTOWELI via `TegridyStaking.votingPowerOf`, Heat tier via `frontend/api/_lib/heat.js`, and paid entries via a `Paid(CLUB)` receipt; on pass it writes a `club_members` row with a 24h expiry, and message INSERTs re-verify on expiry. Frontend: new `frontend/src/pages/ClubsPage.tsx` (register in `frontend/src/lib/navConfig.ts`) plus `frontend/src/components/community/ClubCard.tsx` and `ClubChat.tsx` reusing CommunityPage chat components; the creation wizard reads tier names from `frontend/src/lib/heat/heatGateConfig.ts`. The "you need X more TOWELI" block deep-links to `TradePage.tsx` — gates drive buy-pressure through the venue's own swap.

**Fee wiring:** Paid one-time entries go through TegridyPayRail's CLUB context: 90% club owner, 10% venue → F3 FeeRouter → staker/treasury/POL live ratios. Upsell: PremiumAccess holders (`PREMIUM_ACCESS_ADDRESS`, live) create unlimited clubs; free tier gets one.

**Gates:** No new contract, so no new audit wave beyond the rail's. Honesty: gates fail closed — Heat oracle or RPC failure pauses entry with "gate check unavailable", never admits by default; member counts render from real rows only. RLS reviewed as part of the migration PR.

**Done when:** a non-holder is blocked at the RLS layer, not just UI; a paid entry admits exactly once and splits fees correctly; a Resident-tier club admits a Resident, blocks a Drifter, and pauses closed during a forced oracle 5xx.

### #79 — Heat-gated community bot

**Preconditions:** F2 (SIWE wallet-link deep-links), F8 (Heat + deployer-reputation scoring API), F5 for billing; F9's Telegram transport is a bonus, not required. Operator: create the bot via BotFather, set `TELEGRAM_BOT_TOKEN` + a webhook secret in Vercel env.

**The build:** Telegram first, because a TG webhook fits the serverless cap: new `?resource=tg-gate` branch in `frontend/api/aggregator.js` → `frontend/api/_lib/tg-gate.js` handling `chat_join_request` updates. Flow: join request → bot DMs a SIWE deep-link (reusing `frontend/api/auth/siwe.js` with a wallet↔tg-id link table) → once bound, check Heat tier via `frontend/api/_lib/heat.js` and deployer reputation via the F8 scoring API → approve/decline the join. Config: migration `frontend/supabase/migrations/018_gate_communities.sql` — `gate_communities(tg_chat_id, owner_wallet, min_tier, min_heat, plan, paid_until)`. Periodic re-checks run as an F9 scheduled sweep; kicking on tier-loss is opt-in per community. Discord requires a persistent Gateway process — explicitly deferred to F5's dedicated-host escape; the pricing page says "Telegram now, Discord when the paid host lands". Frontend: setup wizard `frontend/src/components/community/GateBotSetup.tsx` linked from `ClubsPage.tsx`. Rate-limit the webhook with `frontend/api/_lib/ratelimit.js`.

**Fee wiring:** SaaS at the Collab.Land ladder ($20–450/mo per community) billed via F5 — Stripe revenue is off-chain and goes to treasury/opex (stated plainly, not dressed up as staker yield); communities may instead pay monthly in ETH via TegridyPayRail CLUB context, in which case the 10% venue share follows the F3 staker/treasury/POL split and 90% is simply the venue's own SaaS price paid to treasury.

**Gates:** No contracts, no audit wave. Honesty is the product: on oracle outage the bot answers "no data" — joins queue (fail-closed for admits), nobody is kicked on stale reads (fail-open for removals). The venue reads Heat, never computes it. Secrets per `docs/SECRET_ROTATION.md`.

**Done when:** a TG group auto-admits a Resident wallet and declines a Drifter e2e; a forced oracle outage queues joins without any approval; the first external community completes paid setup.

### #73 — Content coins

**Preconditions:** DEBATABLE — before any code, the operator signs a written framing note (new `docs/CONTENT_COINS_FRAMING.md`) acknowledging this is an attention-speculation product and fixing the mandatory buy-screen language. F1 (trade indexing), F2 (posts/profiles exist), F3 (fee-on-top legs + referral ledger), items 75/76 proving the social layer.

**The build:** DELETE before ADD — no new AMM, no coin factory. A content coin is a standard launch through the existing Doppler EVM launcher rail (`frontend/src/lib/launcher/airlock.ts`) bound to a post. New `frontend/src/lib/launcher/contentCoin.ts`: creates the launch with metadata (post id, author wallet, content hash) pinned via `frontend/src/lib/irysClient.ts`; binding row via migration `frontend/supabase/migrations/019_content_coins.sql` (post_id ↔ token address, creator, referrer). UI: a "coin this post" action in the F2 post composer and a coin chip on posts deep-linking to `frontend/src/pages/TradePage.tsx`. Trades route through the existing 7-aggregator meta-router with an F3 fee-on-top leg tagged with the creator+referrer from the binding; creator earnings accrue in F3's referral accounting ledger and are claimable from the profile. Data: F1 tables `content_coins`, `content_coin_trades`; profile earnings render from the ledger only.

**Fee wiring:** 1% fee-on-top on venue-routed trades of bound coins, paid by the trader: 80% creator / 20% venue (venue ≈0.2% of volume, matching the Zora comp). Venue leg → F3 FeeRouter → staker/treasury/POL live ratios. Trades routed off-venue earn nothing — the docs say so.

**Gates:** Buy screen must render: "this coin's only utility is speculation on this post's attention; most buyers lose money" — enforced by a copy test following the `frontend/src/pages/launchFeeCopy.test.ts` pattern. The Heat launch floor (80) applies to coin creators unchanged via `frontend/src/lib/heat/launchGate.ts`. No new contracts, so no audit wave; feature-flagged for the first 30 days.

**Done when:** post→coin→first trade→creator claim completes e2e; the framing-copy test is green and unremovable without failing CI; per-coin F1 volume matches a chain-derived spot check.

### #74 — Creator keys

**Preconditions:** Item 73 live (the written DEBATABLE speculation-framing note extended to cover keys), item 77 (clubs to gate), item 75 (DM paywall to bypass), F1, F3, F7 full intake + audit slot.

**The build:** Fork VERBATIM friend.tech's `FriendtechSharesV1` from its Basescan-verified Base mainnet source via the F7 intake procedure: vendor the exact source at `contracts/vendor/friendtech/FriendtechSharesV1.sol` with diff-guard CI. Minimal delta as `contracts/src/TegridyKeys.sol`: (1) delete the Ownable fee setters — `protocolFeePercent` (5%), `subjectFeePercent` (5%), and `protocolFeeDestination` (the F3 FeeRouter) become immutable, constructor-set, closing friend.tech's admin rug vector and satisfying the immutability law; (2) the bonding-curve math stays byte-identical, proven by fork tests in `contracts/test/` replaying real friend.tech trade traces. Deploy `contracts/script/DeployKeys.s.sol` through the Safe ceremony. Utility wiring (the honesty backbone — keys gate real things): extend `frontend/api/_lib/club-gate.js` with `gate_type=creator_key` (sharesBalance ≥ N); key holders bypass 75's DM paywall (holder check added to `frontend/api/_lib/paid-dm.js`); F2 watchlist/alpha feeds become key-gateable. Frontend: `frontend/src/components/community/KeyTradePanel.tsx` on profiles — the buy screen renders the full curve, the sell-now price, and "price follows a bonding curve; late buyers likely lose money; keys are access, not investment". Data: F1 tables `key_trades`, `key_holders` from Trade events.

**Fee wiring:** 10% per trade, buy and sell, paid by the trader exactly as upstream: 5% → creator wallet directly, 5% → F3 FeeRouter → staker/treasury/POL live ratios.

**Gates:** DEBATABLE amendment note required (cycle-shaped product). Full F7 adversarial audit + echidna on the delta despite the verbatim core. Launch behind a creator allowlist flag for 30 days.

**Done when:** buy/sell round-trip splits fees correctly on mainnet; a key-gated club and DM bypass both work; curve outputs match friend.tech reference vectors exactly.

### #78 — Heat passport & vouching

**Preconditions:** F8 (signed Heat attestations — extend `frontend/src/lib/heat/attestation.ts` and its server signer), F2, F1 (rug-predicate data), full F7 audit wave, attestation-signer key ceremony. Items 75–77 live so badges have surfaces.

**The build:** Two contracts. (1) `contracts/src/HeatPassport.sol` — soulbound ERC-721: OZ ERC721 from `contracts/lib/openzeppelin-contracts` verbatim, sole delta = transfers revert; `mint`/`refresh` consumes an F8-signed attestation (wallet, tier, epoch; ECDSA via solady) so the venue still never computes Heat. (2) `contracts/src/VouchRegistry.sol` — no battle-tested fork source exists (Ethos is not fork-suitable), so a conscious verbatim-law amendment: ~250 LoC custom. A vouch = ETH staked on a deployer wallet, 90-day lock, unvouch after lock. Slashing V1 is objective-only: the F8 signer attests "rug predicate met" (>90% LP pull within 30 days of graduation, computed from F1 data), then a 48h contest window using the `contracts/src/base/TimelockAdmin.sol` pattern, then slash. No discretionary slashing exists, and the UI says so. Deploy scripts `contracts/script/DeployPassport.s.sol`, `DeployVouch.s.sol`. Frontend: panels on `frontend/src/pages/TrustHubPage.tsx` and `DeployerPage.tsx`; new `frontend/src/components/community/VouchPanel.tsx`; `frontend/src/components/scanner/ScanReport.tsx` shows "X ETH vouched by N wallets" from F1 tables `vouches`/`slashes`.

**Fee wiring:** Badge mint 0.002 ETH + 2% of each vouch stake on deposit, both → F3 FeeRouter → staker/treasury/POL live ratios. Slashed stakes flow 100% to RevenueDistributor (stakers). B2B: vouch data joins F8's keyed scoring API under F5 billing.

**Gates:** Full F7 adversarial audit + echidna (custom slashing code). Honesty: revenue is flagged unproven in all copy, per the source doc; scanner badges render only indexed on-chain vouches, otherwise "no data".

**Done when:** mint + vouch + lock work e2e; a simulated rug on the fork harness runs attest→timelock→slash to stakers; ScanReport shows live vouch totals matching chain.

### #81 — Venue MCP server + AI copilot

**Preconditions:** F5 mandatory — MCP needs a persistent HTTP/SSE process plus API keys, metering, and billing; it cannot live under the Vercel 12-function cap. F1 (portfolio data), F8 (scores). Ships after the social core proves retention.

**The build:** New top-level package `mcp-server/` (TypeScript, `@modelcontextprotocol/sdk`, streamable HTTP transport) deployed on F5's dedicated host. Tools wrap existing surfaces only — no new logic: `get_quote` (the aggregator meta-router), `scan_token` (the scanner logic from `frontend/src/lib/detection/`, ported to run server-side), `get_heat` (the heat resource — venue reads, never computes), `get_birth_record` (`?resource=record`), `get_portfolio` (F1 GraphQL), and `build_swap_tx` — which returns unsigned SwapFeeRouter calldata and never holds or requests keys. Auth via F5 API keys: free tier read-only, paid tier for quotes/tx-building. In-app copilot: extend the existing `frontend/src/components/TowelieAssistant.tsx` with an "explain this scan" mode calling an F5-hosted LLM proxy route; the system prompt hard-codes: restate only fields present in the ScanReport/Heat payload, cite the field for every claim, refuse predictions; a render-gate strips any sentence referencing data absent from the payload.

**Fee wiring:** Agent-built swaps are ordinary SwapFeeRouter clients — the existing ≤1% fee and live staker/treasury/POL split apply untouched. MCP calls are metered per-call via F5 billing (off-chain revenue → treasury/opex, stated as such — not staker yield). Unlimited copilot use gates behind PremiumAccess (`PREMIUM_ACCESS_ADDRESS`, live).

**Gates:** DEBATABLE — the copilot may never fabricate signals; add an honesty test suite in the `frontend/src/lib/docsClaimHonesty.test.ts` pattern asserting refusal when data is absent. No contracts, no audit wave; key custody is prohibited by design (unsigned calldata only). Beta behind an allowlist flag.

**Done when:** an external MCP client completes quote→user-signed swap that pays the venue fee; the copilot refuses a baited "will this pump" prompt in CI; metering produces a correct per-key invoice.

### #82 — Audit & bounty marketplace

**Preconditions:** F1, F2. Operator action: un-dark the already-deployed `contracts/src/MemeBountyBoard.sol` — set `MEME_BOUNTY_BOARD_ADDRESS` in `frontend/src/lib/constants.ts` from the deploy record and verify its treasury/staking wiring. Item 75's TegridyPayRail live (BOUNTY context). F8 for attestations.

**The build:** DELETE before ADD — light up the existing immutable contract before writing anything new. Phase 1: wire `frontend/src/components/community/BountiesSection.tsx` to the live board: create/submit/vote/complete, veTOWELI voting through TegridyStaking with the contract's existing MIN_UNIQUE_VOTERS=3 whale guard. Phase 2, the security lane: an "audit" bounty type with structured submissions (severity, PoC link, target contract) via new `frontend/src/components/community/AuditBountyForm.tsx`, reports pinned through `frontend/src/lib/irysClient.ts`. The deployed board has no platform-fee bps (its treasury only receives expired-refund sweeps — verified in source), so the 10% fee is charged at posting: the creator funds the escrow on the board AND pays 10% of the reward through TegridyPayRail (BOUNTY context, fee-only path) in one UI flow; the listing renders as "live" only after both txs confirm. Scanner feed: a completed audit bounty produces an F8-signed attestation; `frontend/src/components/scanner/ScanReport.tsx` gains a badge — "community security review: N findings, X ETH paid" — linking the Irys report and explicitly labeled "not a formal audit". Data: F1 indexes BountyCreated/BountyCompleted into an `audit_bounties` table.

**Fee wiring:** 10% of the bounty reward, paid by the poster on top; PayRail → F3 FeeRouter → staker/treasury/POL live ratios. Winners keep 100% of escrow, exactly as the contract pays.

**Gates:** House-law clean — deployed immutable contract reused verbatim; new surface is UI + attestations only. Honesty: no badge without an indexed on-chain completion event; the token-holder-vote judging model (not sponsor judgment) is stated on the posting screen; sponsor-judged contests deferred.

**Done when:** a full bounty lifecycle completes on mainnet through the UI; the 10% fee lands in the FeeRouter; a ScanReport badge appears only after BountyCompleted is indexed.

### #83 — No-loss prize vault

**Preconditions:** F1, F4 (keepers for draws/claims), full F7 intake, Safe ceremony. Operator: approve Aave v3 WETH as the yield source and sign a written dependency note in the Tier C preamble.

**The build:** Fork VERBATIM PoolTogether V5 through the F7 intake procedure: vendor exact release tags of `pt-v5-prize-pool`, `pt-v5-vault` (PrizeVault), `pt-v5-twab-controller`, `pt-v5-claimer`, and the `pt-v5` Aave ERC-4626 wrapper into `contracts/vendor/pt-v5/` with diff-guard CI. Zero delta to core code — configuration only, the cleanest possible compliance with the verbatim-fork law. Prize token WETH; yield from Aave v3 WETH behind PT's standard wrapper. Deploy `contracts/script/DeployPrizeVault.s.sol` (twab controller → prize pool → vault → claimer), Safe-owned per PT's minimal-role model. Keepers: F4 runs PT's permissionless claimer/draw-auction bots — it competes in open auctions, no privileged role. Frontend: new `frontend/src/pages/PrizeVaultPage.tsx` (route in `frontend/src/lib/navConfig.ts`) + `frontend/src/components/community/PrizeVaultCard.tsx`; deposit/withdraw via wagmi; the odds panel computes only from on-chain TWAB balances — "your odds ≈ your share of deposits", never projected winnings. Data: F1 tables `pv_deposits`, `pv_prizes` and a prize-history feed.

**Fee wiring:** PT-native `yieldFeePercentage` set to 10% at deploy and frozen; `yieldFeeRecipient` = the F3 FeeRouter → staker/treasury/POL live ratios. Depositors pay nothing on principal; principal is always withdrawable. The fee comes exclusively from earned yield — real-yield law satisfied; the venue never touches capital it has not earned.

**Gates:** Fully compliant: verbatim fork, immutable config, no admin upgrade path. Not a gambling-law amendment — no principal can be lost — but the Aave dependency note is mandatory. Honesty: prize/odds panels self-gate to "no data" if F1 lags. F7 fork-test harness must replay real PT mainnet draws before deploy.

**Done when:** deposit→draw→claim on the fork harness matches PT reference behavior; a mainnet deposit withdraws principal to the wei; exactly 10% of yield (and nothing else) reaches the FeeRouter.

### #84 — Fantasy trading leagues

**Preconditions:** Last in the wave — boom-bust by design. Before code: extend the Tier C DEBATABLE framing doc (from items 73/74) with a written note that entry-fee contests are gambling-shaped, flag-gated, and jurisdiction-gated. F1 (scoring source), F8 (signed results), item 75's rail precedent, full F7 audit slot.

**The build:** No battle-tested verbatim source exists for signer-settled contest escrow — conscious verbatim-law amendment: minimal custom `contracts/src/LeagueEscrow.sol` (~200 LoC): `createLeague(entryFee, start, end)` with the F8 result-signer immutable; `join()` payable during the entry window; `settle()` accepts an F8-signed merkle root of wallet→payout; a 48h contest window before claims open (reuse the `contracts/src/base/TimelockAdmin.sol` pattern); `claim()` by merkle proof; unclaimed funds sweep to treasury after 180 days, mirroring MemeBountyBoard's refund discipline. Deploy `contracts/script/DeployLeagueEscrow.s.sol`. Scoring: rosters of venue-launched tokens stored via migration `frontend/supabase/migrations/020_fantasy_leagues.sql`, locked at league start; scores computed from F1 price/volume data by a deterministic, published, open-source scorer living in `indexer/` so anyone can recompute; F8 signs the root. Frontend: new `frontend/src/pages/LeaguesPage.tsx` + `frontend/src/components/community/DraftBoard.tsx`; live standings from F1 only, labeled "provisional until settled on-chain".

**Fee wiring:** 10% rake on each entry pool, taken inside `settle()` → F3 FeeRouter → staker/treasury/POL live ratios; 90% funds the payout merkle. Pack sales deferred entirely — DELETE before ADD, no lootbox mechanics in v1.

**Gates:** DEBATABLE amendment mandatory; free (no-entry-fee) leagues ship first, paid leagues stay behind a flag pending a jurisdiction gate per counsel. Full F7 adversarial audit + echidna on LeagueEscrow. Honesty: the scorer is deterministic and public; standings render only from the indexer; no "projected winnings" anywhere.

**Done when:** a free league completes draft→score→signed settle→claims on mainnet; a third party recomputes scores matching the signed root; a paid league on the fork harness splits the rake correctly and refuses settlement from a non-signer.


## Wave 7 — NFT-fi & commerce completers

Wave 7 turns the venue's already-built NFT/commerce machinery — the Solady-ERC721 staking positions, the ~52K-LOC Nakamigos Seaport marketplace, TegridyNFTLending/TegridyNFTPool, PremiumAccess, and the 7-aggregator meta-router — into complete money lines instead of half-used capability. Order matters: 60 rides the already-queued redeploy batch (8f72bed + E.21) and must land first because 59's boost delegation and 61/62's liquidation settlement all lean on the redeployed staking/marketplace pair; 63 then makes the marketplace the default NFT surface; 67 (zaps) is the connective tissue that feeds every deposit-shaped product later in the wave; 68/69 generalize the meta-router and PremiumAccess into merchant rails; 70/71/72 sell the venue's audited surface B2B; 85 deepens graduated-token books; 100 wraps the whole stack in brokered cover. Shared risks: everything contract-shaped goes through one or two F7 audit waves and the Safe ceremony (no ad-hoc deploys); the Vercel 12-function cap means every new backend surface is a catchall resource or waits on F5; and the wave's honesty burden is high — position valuations, rental APRs, tax lots, and cover quotes must all self-gate to "no data" rather than estimate.

### #60 — Staking-position marketplace

**Preconditions:** F1 (indexer `stakingPosition` table live for valuations), F7 (redeploy ceremony). Operator: execute the queued redeploy batch — commit 8f72bed fixes plus the E.21 contract change. Nakamigos Seaport rails already live.

**The build:** Two phases, per `WORKORDER_V2.md` E.21. Phase 1 (no contract change): interim OTC board on the existing orderbook — extend `frontend/api/orderbook.js` with a `stakingPosition` collection type verified through `frontend/api/_lib/seaport-verify.js`/`seaportHash.js`; enforce the buyer-eligibility pre-check client- and server-side (`userTokenId[buyer]==0` and 24h elapsed) before an offer can be signed, because the live single-position-per-EOA guard (`TegridyStaking.sol` `AlreadyHasPosition`, line ~1006) reverts transfer-in otherwise. Phase 2: in the redeployed `contracts/src/TegridyStaking.sol`, relax the transfer-in guard to allow multi-position receipt (the `_positionsByOwner` EnumerableSet and `votingPowerOf` iteration already support it — minimal delta, stake-path guard unchanged); redeploy via the batch's existing scripts under F7 ceremony. Frontend: new `frontend/src/pages/PositionMarketPage.tsx` reusing `frontend/src/nakamigos/lib/orderbook.js` + `netProceeds.js`; listing card must render lock end, `boostBps`, pending rewards, and intrinsic TOWELI read live from `StakingViewLib`/indexer — never a modeled "fair value". Data: indexer `stakingPosition` + `stakingAction` tables power history and honest floor.

**Fee wiring:** 1% of sale price as a Seaport consideration item paid by the seller, recipient `ReferralSplitter` → `RevenueDistributor`, following the live timelocked split (stakerShareBps default 10000; polShareBps → `POLAccumulator`; remainder treasury).

**Gates:** Complies: immutable contracts (change ships only in the audited redeploy), honesty-gating (no synthetic valuations; self-gate to "no data" if indexer lags). One F7 audit wave on the staking delta. Phase 2 flag-gated behind `isDeployed()` in `frontend/src/lib/constants.ts` until the redeploy verifies.

**Done when:** a position lists, sells, and transfers with all lock state intact on mainnet; the 1% fee lands in RevenueDistributor's next epoch; buyer pre-check blocks ineligible wallets in Phase 1; listing cards show live on-chain reads only.

### #59 — Boost rental market

**Preconditions:** Rank 60's redeploy batch executed (this rides the same ceremony); F1 for rental history; F7 audit wave shared with 60.

**The build:** Paladin Warden pattern. Contracts: fork Warden's offer/purchase/expiry flow VERBATIM (PaladinFinance/Warden, audited, vendored at exact commit via F7 diff-guard) into `contracts/src/TegridyBoostMarket.sol` — lockers list unused boost at a weekly WETH price with min/max duration; renters pay upfront for fixed terms. Minimal delta: a new `contracts/src/lib/BoostDelegationLib.sol` registry the market writes (`delegatedBoostBps(from, to, untilTs)`), and a one-line change in the redeployed `contracts/src/TegridyLPFarming.sol`: the boost read becomes `effectiveBoostBps(user)` = own `staking.aggregateActiveBoostBps(user)` (interface at line 43) plus active inbound delegations minus outbound — capped by the existing 4.5x C-01 defence (`MAX_BOOST` + JBAC clamp). Both changes ship inside the rank-60 redeploy batch, never as a live-contract mutation. Deploy script `contracts/script/DeployBoostMarket.s.sol`. Frontend: new `frontend/src/components/farm/BoostRentalPanel.tsx` wired into `FarmPage.tsx`; extend `frontend/src/lib/boostCalculations.ts` with delegation-aware math. Data: indexer tables `boostRentalOffer`/`boostRentalFill` (new event handlers in `indexer/src/`).

**Fee wiring:** 10% of each rental payment, paid by the renter on top; WETH path `TegridyBoostMarket` → `ReferralSplitter` → `RevenueDistributor` (staker/POL/treasury per the live timelocked split). Remaining 90% to the delegating locker — real yield on an already-earned position.

**Gates:** Complies: verbatim fork (Warden), real yield only, raises lock demand. Amends nothing. Same F7 audit wave as rank 60. Honesty: rental APR shown only from actually-filled rentals via indexer; zero fills renders "no rental history". Flag-gated behind `isDeployed()` until the redeploy verifies.

**Done when:** a renter's LP position earns the delegated boost on-chain (verified via `refreshBoost` + reward accrual); locker receives 90% WETH; delegation expires automatically at term end with no keeper; boost cap invariant holds under echidna.

### #61 — NFT pool lending (Blend-pattern)

**Preconditions:** Rank 60 shipped (marketplace settles liquidations); live `TegridyNFTLending` + `TegridyNFTPoolFactory`; F1 for loan-book data; F7.

**The build:** Do not fork Blend (BUSL, off-chain offer machinery). Instead, DELETE-before-ADD: pool the lender side of the already-audited P2P surface. Contracts: `contracts/src/TegridyNFTLendingVault.sol` — an ERC-4626 WETH vault per whitelisted collection, forked VERBATIM from the same Yearn V3 base the year-plan already mandates for the auto-compounder (vendored exact commit, F7 diff-guard), with one strategy: programmatically maintain standing offers on `TegridyNFTLending.createOffer` at `min(TegridyNFTPool spot, marketplace floor via TegridyTWAP-gated read) × LTV` (start 30%). Borrowers get instant loans by accepting the vault's live offer — no new borrow surface, the audited P2P contract does all escrow/liquidation. On default, seized NFTs settle through rank 60's Seaport marketplace listing flow or sell into the collection's `TegridyNFTPool`. Deploy script `contracts/script/DeployNFTLendingVault.s.sol`. Frontend: extend `frontend/src/components/nftfinance/NFTLendingSection.tsx` with a "Instant loan" tab and a lender vault deposit card; page `frontend/src/pages/LendingPage.tsx` gains the vault APY strip. Data: indexer tables `nftLoanOffer`/`nftLoan` from `TegridyNFTLending` events.

**Fee wiring:** 0.5% origination (paid by borrower, deducted at draw) + 10% of interest (paid from lender yield), both WETH, path vault → `ReferralSplitter` → `RevenueDistributor` per the live split. Depositors keep 90% of interest.

**Gates:** Complies: verbatim fork (Yearn V3 4626 base), minimal attack surface (borrow path unchanged), lender capital is user capital ("may not spend capital it has not earned"). One F7 audit wave. Honesty: vault APY shown only from realized interest; oracle staleness self-gates offers off. Cap per-collection TVL until 90 days of liquidations prove out.

**Done when:** deposit → auto-offer → borrower acceptance → repayment round-trips on mainnet; a forced default liquidates through the own marketplace; realized-only APY renders; TVL cap enforced on-chain.

### #62 — NFT buy-now-pay-later

**Preconditions:** Rank 61 vault live (funds the financed leg); rank 60 marketplace; F4 keeper (installment default sweeps); F7.

**The build:** Cyan-pattern installments inside the Nakamigos marketplace. Contracts: `contracts/src/TegridyNFTBNPL.sol` — new, small, patterned on the repo's own audited escrow idioms (`TegridyNFTLending` escrow + `SafeERC721Call`, `WETHFallbackLib`): buyer posts 25% down in WETH; the contract draws the 75% balance from `TegridyNFTLendingVault` (rank 61), atomically fulfills the Seaport order on the own orderbook (validated via the same order-hash path as `frontend/api/_lib/seaport-verify.js`), and escrows the NFT. Fixed schedule: 3 further installments over 90 days at a posted APR. Full payment releases the NFT; missed installment (F4 keeper checks) forfeits it — escrow lists it via rank 60's flow or sells into `TegridyNFTPool`, repays the vault first, refunds any surplus above debt to the buyer (Cyan's honest-surplus rule). Deploy script `contracts/script/DeployNFTBNPL.s.sol`. Frontend: "Pay in 4" button in `frontend/src/nakamigos/components/Listings.jsx` + a new `frontend/src/nakamigos/components/BnplManager.jsx` (schedule, payoff, health); reuse `netProceeds.js` math. Data: indexer `bnplPlan` table; installment status feeds F9 alerts ("payment due").

**Fee wiring:** Marketplace's normal 1% fee applies to every financed sale (same Seaport consideration path as rank 60), plus the rank 61 interest split on the financed 75% (10% of interest to `ReferralSplitter` → `RevenueDistributor`, 90% to vault depositors). Buyer pays; no venue capital at risk.

**Gates:** Complies: capital lent is vault-depositor capital, not protocol capital; surplus-refund on default is the honesty posture. One F7 audit wave (shared with 61 if timed together). Honesty: total cost of credit (APR + fees, in WETH) displayed before signature; no "0% intro" framing. Flag-gated to Nakamigos/JBAC collections until two default cycles settle cleanly.

**Done when:** a financed purchase escrows and releases after final payment on mainnet; a defaulted plan liquidates, repays the vault, and refunds surplus; every plan's full cost renders pre-commit.

### #63 — NFT marketplace aggregator

**Preconditions:** F1; existing `frontend/api/opensea.js` proxy live; ranks 60–62 (the own orderbook this feeds). No new serverless function — stays within the 12-cap.

**The build:** OpenSea-Pro pattern scoped to what's honest post-Reservoir-sunset: OpenSea orders are Seaport-native, so cross-market fills need no new settlement contract for singles. Backend: extend `frontend/api/opensea.js` to also return raw fulfillable Seaport order components (it already proxies listings); merge external + native books server-side in `frontend/api/v1/index.js` under a new `?route=book` (lazy-import module `frontend/api/_lib/book-merge.js`, following the `heat.js` catchall pattern), best-price-first with per-order source tags. Frontend: extend `frontend/src/nakamigos/hooks/useListings.js` to consume the merged book; upgrade `ShoppingCart.jsx` + `SweepCalculator.jsx` to build multi-order sweeps via Seaport `fulfillAvailableAdvancedOrders` (partial-fill tolerant — skip, don't revert, on raced listings); source badges on every card. Contracts: one thin `contracts/src/TegridySweepRouter.sol` (F3 fee-on-top pattern: wrap the multi-fulfill, skim fee, forward — no arbitrary calls, Seaport address immutable), script `contracts/script/DeploySweepRouter.s.sol`. Data: indexer records own-book fills; external fills tracked via the existing activity feed only.

**Fee wiring:** 0.5% fee-on-top on sweeps through `TegridySweepRouter` (buyer pays); single-order fills route direct to Seaport, fee-free (price-competitiveness law of the meta-router applied to NFTs). Fee in ETH → `ReferralSplitter` → `RevenueDistributor` per live split. Own-orderbook fills keep the rank-60 1% consideration.

**Gates:** Complies: minimal attack surface (immutable Seaport target, no generic router), honesty-gating — external listings re-validated via `frontend/api/_lib/seaport-verify.js` before render; stale/unverifiable orders drop to "unavailable", never shown fillable. F7 audit on the sweep router only. Blur aggregation explicitly out (no public fill API — do not fake it).

**Done when:** merged book shows OpenSea + native listings with badges and verified fillability; a 5-item cross-source sweep settles in one tx with raced items skipped; sweep fee arrives at RevenueDistributor; zero external-API-down states render fake listings.

### #67 — Zap engine

**Preconditions:** None hard; F1 improves receipts. Note the governing law first: `docs/USER_VALUE_ROADMAP.md` line 101 forbids a custom zap router (OpenZeppelin's Beefy-zap audit found a CRITICAL arbitrary-call drain in exactly that pattern). This build complies by having NO zap contract at all.

**The build:** Client-orchestrated zaps over existing audited endpoints only. Frontend: new `frontend/src/lib/zap/planner.ts` — composes a zap plan as an ordered call array: (1) meta-router swap via `frontend/src/lib/aggregator.ts`/`swapRouting.ts` (through `SwapFeeRouter` when routed natively), (2) `TegridyRouter.addLiquidityETH`, (3) `TegridyLPFarming.deposit`, or alternatively (2') `TegridyStaking` lock — each target a hardcoded deployed address from `frontend/src/lib/constants.ts`, never a user-supplied call. Execute atomically via EIP-5792 `wallet_sendCalls` (`frontend/src/lib/eip5792.ts` exists; `stakeBatch.ts` is the precedent — extend both), with a sequential-tx fallback and a resumable progress UI for non-5792 wallets. New `frontend/src/components/swap/ZapPanel.tsx`; surface entry points in `LiquidityTab.tsx`, `frontend/src/components/farm/LPFarmingSection.tsx`, and every vault deposit card this wave ships (61, 85). Slippage compounds across legs — show the composed worst-case, computed in `planner.ts`. Backend: none. Data: zap receipts stitched client-side from tx hashes; indexer `swap` + `pairEvent` tables verify completion.

**Fee wiring:** No new fee. The swap leg pays the existing `SwapFeeRouter` `feeBps` (0.1–0.3%) → `ReferralSplitter` → `RevenueDistributor`/`POLAccumulator`/treasury per the live timelocked split; downstream positions feed farming/staking fee lines. A 5bps zap-convenience skim waits for F3's fee-on-top leg and is out of scope here.

**Gates:** Complies fully — the avoid-note is honored, not amended; zero new attack surface. No audit wave needed (no contract). Honesty: quote each leg's real minOut; if any leg's quote source is down, the zap self-gates to manual steps.

**Done when:** ETH → LP → staked-in-farm completes in one 5792 batch on mainnet; fallback path resumes after a mid-sequence failure; composed slippage shown pre-sign matches receipts within tolerance.

### #68 — Crypto checkout widget

**Preconditions:** F3 (fee-on-top transfer leg — this is its first merchant consumer), F5 for keys/webhooks at scale (interim: catchall + Upstash), F2 optional (merchant SIWE login).

**The build:** Coinbase-Commerce pattern, settlement through the meta-router. Contracts: none new — a payment is a routed swap with `recipient = merchant` plus F3's fee-on-top leg; direct same-asset payments are plain transfers verified by watching the chain. Backend: new `?resource=checkout` in `frontend/api/v1/index.js` via lazy-import module `frontend/api/_lib/checkout.js` (the `heat.js` pattern — no new function, cap stays at 11): `create-invoice` (merchant key, amount, settlement asset, expiry), `invoice-status` (poll chain via existing `frontend/api/_lib/ethcall.js`/`record-evm.js` observation code), `webhook` registration with HMAC-signed delivery and the F4 retry/receipt discipline. Invoices in Supabase behind `frontend/api/supabase-proxy.js` with RLS. Env: `CHECKOUT_WEBHOOK_SECRET`. Frontend: embeddable widget as a separate Vite lib build — new `frontend/src/checkout/` (entry `widget.tsx`, own build target in `vite.config`), consuming `frontend/src/lib/aggregator.ts` quotes; merchant dashboard page `frontend/src/pages/MerchantPage.tsx` (invoices, payouts, webhook logs). Data: settlement receipts recorded via the indexer `swap` table where routed natively.

**Fee wiring:** 1% per transaction (Coinbase Commerce's exact rate), paid by the merchant (deducted from settlement). Path: F3 fee-on-top leg → `ReferralSplitter` → `RevenueDistributor` per the live staker/POL/treasury split. The swap leg's normal `SwapFeeRouter` fee is waived-by-routing to keep the all-in cost at 1%.

**Gates:** Complies: no custody (funds go buyer → merchant in one route), no new contract until F3's leg is audited in its own wave. Honesty: invoice states are chain-observed only — "paid" renders exclusively on confirmed settlement, never on webhook optimism; quote-source outage gates checkout to "unavailable". Stablecoin settlement is holding a third-party asset, not issuing — no stablecoin-law amendment needed.

**Done when:** a merchant invoice paid in an arbitrary token settles in the chosen asset with 1% skimmed to the fee path; webhook delivers signed, retries on failure; a paid invoice can be independently verified from chain data alone.

### #69 — Subscription billing rails

**Preconditions:** F4 (keeper executes recurring charges), F7; rank 68 useful but not required. F5 for merchant API keys.

**The build:** Generalize the venue's own audited subscription contract. Contracts: fork `contracts/src/PremiumAccess.sol` — the repo's in-house, multiply-audited pattern (R014 min-holding, PA-M-02 escrow-refund fixes) — into `contracts/src/TegridyBillingRails.sol`: replace the single hardcoded plan with merchant-registered plans (`token, amountPerPeriod, period, treasury`), keep the subscribe/cancel/pro-rata-escrow-refund machinery VERBATIM (fork-own-code discipline: vendor the exact source lines, F7 diff-guard against PremiumAccess), add `charge(subscriber, planId)` callable by anyone but paying out strictly per elapsed periods — keeper-agnostic, MakerDAO-style permissionless crank so F4 executes but never gatekeeps. ERC-20 only, pull-from-escrow (no open-ended approvals drained later — subscriber tops up escrow, DELETE the infinite-approval pattern before adding it). Script `contracts/script/DeployBillingRails.s.sol`. Backend: `?resource=billing` module `frontend/api/_lib/billing.js` in the v1 catchall — plan registry mirror, charge receipts, merchant webhooks (rank 68 infra). Frontend: `frontend/src/pages/BillingPage.tsx` (merchant plan builder + subscriber management); `PremiumPage.tsx` untouched — PremiumAccess coexists and folds in only after rails run 90 clean days. Data: indexer `billingCharge` table; F9 alerts for "escrow low".

**Fee wiring:** 0.75% of each successful charge, merchant pays (deducted from payout). TOWELI/WETH charges route fee → `ReferralSplitter` → `RevenueDistributor` per live split; other-token fees convert via the `SwapFeeRouterConvertLib` pattern before forwarding.

**Gates:** Complies: fork of own battle-tested code, escrow model minimizes approval attack surface, real yield (fees on real charges only). One F7 audit wave. Honesty: merchants see charge success/failure truthfully; a failed charge never renders as "active subscriber".

**Done when:** third-party merchant plan charges three consecutive periods via permissionless crank; cancellation refunds pro-rata escrow exactly like PremiumAccess; 0.75% lands in the fee path; echidna holds the escrow-conservation invariant.

### #70 — Treasury management network

**Preconditions:** F1 (public reporting needs the indexer), F7 (vendored fork intake), rank 69 (mandate-fee billing), rank 85 helpful (a strategy to mandate into). Operator: venue Safe signs mandate templates.

**The build:** karpatkey structure, non-custodial. Contracts: fork Zodiac Roles Modifier VERBATIM (gnosisguild/zodiac-modifier-roles, exact audited release vendored via F7 — battle-tested by karpatkey/ENS/Gnosis; deploy the canonical singleton if not already on-chain, else reuse). Zero custom Solidity: a community treasury Safe enables the Roles module scoped by venue-published role configs permitting ONLY: `TegridyStaking` stake/claim, `TegridyLPFarming` deposit/withdraw/getReward, `TegridyRouter` add/removeLiquidity on whitelisted pairs, rank-85 vault deposit/redeem, and rank-69 fee payments. The venue's ops key gets execution rights within the mandate; the community Safe retains full ownership and instant revocation. Backend: `?resource=treasury-network` module `frontend/api/_lib/treasury-network.js` in the v1 catchall — mandate registry, role-config JSON hashes, AUM snapshots from F1. Frontend: `frontend/src/pages/TreasuryNetworkPage.tsx` — public per-treasury reporting (positions, realized yield, fees paid) rendered exclusively from indexer reads; onboarding wizard that generates the role-config transaction bundle for the community Safe to sign. Data: indexer watches mandated Safes' positions via existing `stakingPosition`/`pairEvent` handlers plus a `managedTreasury` registry table.

**Fee wiring:** 1% AUM annualized, billed monthly through rank 69's rails (merchant = venue treasury), plus 15% performance on realized yield, skimmed at harvest execution and sent to `ReferralSplitter` → `RevenueDistributor` per live split. Community pays; strategies' own fee lines (swap/farm) accrue normally on top.

**Gates:** Complies: verbatim fork, non-custodial (client Safe owns everything — venue "may not spend capital it has not earned" is structural), real yield reporting only. No new audit wave for the unmodified fork; F7 reviews each role-config template instead. Honesty: performance shown realized-only; unverifiable positions render "no data".

**Done when:** a pilot community Safe executes a full deposit→harvest→report cycle with the venue key unable to move funds outside the mandate; revocation works instantly; public page matches on-chain state; first monthly AUM invoice settles.

### #71 — Built-in tax reports

**Preconditions:** F1 HARD (complete indexed history is the product); F5 (report generation is compute-heavy and paid — needs the serverless-budget escape); F2 (SIWE ties reports to a verified wallet).

**The build:** CoinLedger-pattern reports from the venue's own data. Backend (F5 host, not the Vercel catchall): `reports` service — ingest a wallet's full activity from the F1 GraphQL API (`swap`, `stakingAction`, `revenueClaim`, `pairEvent`, `polEvent` tables, plus Solana leg) merged with the existing client-side normalizers ported server-side from `frontend/src/lib/txHistory.ts` and `frontend/api/_lib/record-evm.js`/`record-solana.js`; compute lots FIFO and HIFO in a new shared `frontend/src/lib/tax/lots.ts` (pure, unit-tested, used by both preview UI and server); price basis from recorded execution prices where the venue routed the trade, external price API otherwise — every externally-priced lot labeled with its source. Export: IRS Form 8949-formatted CSV + PDF, plus a raw lots CSV (reuse `frontend/src/nakamigos/lib/csv.js` conventions). Frontend: `frontend/src/pages/TaxReportsPage.tsx` — year selector, lot-method toggle, gap report, paywall. Payment: $49/$99/$199 tier ladder per tax year through rank 69 rails or PremiumAccess entitlement check. Env (F5): `PRICE_API_KEY`, `REPORTS_SIGNING_KEY`. Data: no new indexer tables; add a `reportJob` row in Supabase (RLS: owner-only).

**Fee wiring:** Flat per-year purchase, user pays in TOWELI/WETH via rank 69 billing; revenue → `ReferralSplitter` → `RevenueDistributor` per live split. No AUM, no percentage.

**Gates:** Complies: no contract, no capital. Honesty is the whole product: unknown cost basis renders as "unknown basis — you must supply" and is EXCLUDED from computed gains, never zero-basis-assumed silently; off-venue activity gaps produce an explicit completeness warning; ship with a "not tax advice" disclosure. No audit wave; F7-style test harness on `lots.ts` (property tests: lots conserve quantity).

**Done when:** a wallet with 500+ mixed EVM/Solana venue events yields an 8949 CSV whose totals reconcile against hand-computed lots; unknown-basis and gap warnings render; report generation is paywalled and rate-limited; FIFO/HIFO switch changes only method-dependent figures.

### #72 — Governance-as-a-service

**Preconditions:** F2 HARD (SIWE + Supabase RLS power off-chain voting); F1 (voting-power snapshots); F7 (factory audit); rank 70 (the cross-sell). Operator: light the dark contracts — `GaugeController`, `VoteIncentives`, `CommunityGrants` are deployed and idle; wiring them for TOWELI governance is the dogfood reference deployment.

**The build:** Complete the launch lifecycle so graduated communities never leave. Contracts: `contracts/src/TegridyGovernorFactory.sol` — minimal clone factory (mirror the `TegridyNFTPoolFactory` clone pattern already in-repo) deploying OpenZeppelin Governor + TimelockController VERBATIM (exact OZ release vendored via F7, zero modification — the delta is only the thin factory + immutable initializer) for any graduated token; optional Safe treasury per community via the canonical Safe factory. Script `contracts/script/DeployGovernorFactory.s.sol`. Off-chain tier (free): Snapshot-style votes — new `?resource=governance` module `frontend/api/_lib/governance.js` in the v1 catchall: proposals + SIWE-signed votes stored in Supabase (RLS), voting power read from an F1 block-height token-balance snapshot, results independently recomputable from the signed-vote dump (publish it). Frontend: `frontend/src/pages/GovernancePage.tsx` — per-token space: proposal list, vote UI, on-chain execution queue for Governor tier; "create your space" wizard on graduation in the launcher flow (`frontend/src/lib/launcher/`). Data: indexer handlers for GovernorClone events (`govProposal`, `govVote` tables).

**Fee wiring:** SaaS ladder, community treasury pays via rank 69 rails: free off-chain space; ~0.5 ETH/yr Governor tier (on-chain execution + hosted timelock ops); revenue → `ReferralSplitter` → `RevenueDistributor` per live split. Cross-sell rank 70 mandates from the same dashboard.

**Gates:** Complies: verbatim OZ fork, fixed-supply TOWELI untouched (this governs OTHER tokens; TOWELI's own no-governance-token posture unchanged). One F7 audit wave on the factory only. Honesty: off-chain tallies always link the recomputable signed-vote dump; snapshot height displayed; no quorum theater.

**Done when:** a graduated token deploys a Governor space and executes a timelocked proposal on-chain; an off-chain vote's published dump recomputes to the displayed tally; TOWELI's own gauge voting runs on the lit GaugeController; first paid tier invoice settles.

### #85 — Liquidity-as-a-service vaults

**Preconditions:** F1 (per-pool fee attribution), F7; rank 67 (zap is the deposit path); year-plan's Yearn V3/Beefy vendoring (shared with rank 61 and the harvest-vault line — vendor ONCE). Operator: pick 2–3 pilot graduated tokens.

**The build:** Community market-making vaults for graduated tokens' own-AMM pools. Contracts: `contracts/src/TegridyLaaSVault.sol` — ERC-4626 vault forked VERBATIM from the same vendored Yearn V3 base (exact commit, F7 diff-guard), one fixed strategy compiled in (no pluggable strategies — DELETE the strategy-registry surface before adding it): accept WETH, pair 50/50 into the token/WETH `TegridyPair` via `TegridyRouter.addLiquidityETH` with `TegridyTWAP`-gated minOuts (copy the exact R015 slippage discipline from `contracts/src/POLAccumulator.sol` — TWAP floor inside the harvest call, keeper retries on stale observations), stake LP into `TegridyLPFarming`, compound rewards on a permissionless `harvest()`. Per-token vault instances via a factory clone (NFTPoolFactory pattern). Script `contracts/script/DeployLaaSVault.s.sol`. Frontend: vault cards in `frontend/src/pages/FarmPage.tsx` via a new `frontend/src/components/farm/LaaSVaultCard.tsx`; MANDATORY IL disclosure using the existing `frontend/src/components/farm/ILCalculator.tsx` before first deposit; zap-in via rank 67's `ZapPanel`. Data: indexer `laasVault` table (deposits, harvests, realized fees); per-pool depth improvement charted from `pairEvent`.

**Fee wiring:** 15% performance fee on harvested LP fees + farm rewards (within the doc's 10–20% band), taken in-kind at `harvest()`, converted WETH-side → `ReferralSplitter` → `RevenueDistributor` per live split. Depositors keep 85%. No management fee, no deposit fee.

**Gates:** Complies: verbatim fork + own audited slippage pattern; depositor capital is user capital; real yield (fees on realized harvests only). One F7 audit wave (bundle with rank 61's vault). Honesty: headline number is realized-fee APY net of measured IL — never emissions-inflated; a vault with <30 days history renders "insufficient history", not a projection.

**Done when:** pilot vault deposit→harvest→withdraw round-trips with 15% skim verified at RevenueDistributor; pool depth measurably deeper (indexer chart); IL-net APY matches independent recomputation; TWAP-stale condition blocks harvest in a fork test.

### #100 — DeFi cover marketplace

**Preconditions:** Deposit surfaces exist (ranks 61, 85, staking, LP farming); no foundation hard-blocks — external allowlist plumbing in `frontend/api/_lib/url-allowlist.js` is the only backend touch. Operator: register the venue as a Nexus Mutual distributor (commission destination address = venue treasury Safe) and confirm current CoverBroker terms; evaluate OpenCover as the aggregation fallback.

**The build:** Broker, never underwriter. Contracts: none custom — purchases call Nexus Mutual's canonical `CoverBroker` (their deployed, audited contract) directly from the user's wallet with the venue's `commissionDestination` and ratio in the buy params; the venue never holds premiums or capital. Backend: `?resource=cover` module `frontend/api/_lib/cover.js` in the v1 catchall — quote proxy to the Nexus quote API (add the API origin to `url-allowlist.js`), product-id mapping table (which Nexus listed products correspond to which venue surfaces — note the OWN contracts are not Nexus-listed at launch: only third-party legs like Aave-fork deposits or partner protocols will quote; do not pretend otherwise). Env: `NEXUS_QUOTE_API_BASE`. Frontend: new `frontend/src/components/CoverOffer.tsx` rendered at point-of-deposit in `LaaSVaultCard.tsx`, `NFTLendingSection.tsx`, `frontend/src/components/farm/StakingCard.tsx`, and `LendingPage.tsx`; a "My cover" panel on `DashboardPage.tsx` reading the user's active cover NFTs on-chain. Data: no indexer changes; cover positions read live from Nexus contracts.

**Fee wiring:** Broker commission (Nexus supports up to ~15%; set 10%) paid from the premium by the buyer, flowing on-chain from CoverBroker to the venue treasury Safe; operator sweeps treasury → `RevenueDistributor` per the standing revenue policy. No premium ever transits venue contracts.

**Gates:** Complies: zero custody, zero underwriting — "may not spend capital it has not earned" is structural; no law amendment (cover is brokerage, not insurance issuance by the venue). No audit wave (no contract). Honesty is the crux: quotes render live-only (API down → "cover unavailable", never cached premiums); every offer states "third-party cover; claims assessed by Nexus Mutual members, payout not guaranteed by Tegridy"; surfaces without a listed product show nothing rather than a lookalike.

**Done when:** a user buys cover from a deposit flow with 10% commission verifiably received by the treasury Safe; active cover renders from chain reads; quote-API outage gates the CTA off; unlisted surfaces show no cover offer.


## Wave 8 — Frontier & the flagged wing

Wave 8 is the frontier wing: every item here either bends a written house law (no perps, no stablecoin, no RWA), touches gambling, or takes underwriting risk the venue has never carried — so every build plan opens with its decision gate, a signed amendment or risk acceptance recorded in docs/ before a line of code. The wave is ordered by defensibility: the parimutuel launch-outcome markets (15) come first because they settle from the venue's own on-chain facts with zero house capital, and only their clean operation unlocks full optimistic-oracle prediction markets (12). The niche-yield trio (86 Alchemix-fork self-repaying loans, 87 own PT/YT, 88 covered calls) plus looped leverage (99) extend the real-yield stack with mostly-verbatim forks and honest small-revenue expectations. Heat credit lines (95) is the differentiated bet — the one product only this venue can price — and depends hard on F8. The conflict heavyweights (89 basis vault, 90 Liquity-V2 CDP, 91 sTOWEL, 92 native perps) are design-gated XL programs in escalating order of law-breakage: the CDP is the best-aligned (immutable, governance-free), the synthetic dollar and perps carry custody, oracle, and decay risks that must be owned in writing and sequenced behind proven ops from 89. Gambling (93, 94) ships only over the operator's signature on the ethics line, structurally zero-house-capital, with EV honesty rendered on the bet ticket. The weak-economics pair (96 RWA, 97 managed RPC) build last or never, and say so in their own gates. Shared risks across the wave: keeper reliability (F4) becomes safety-critical rather than convenience, the F7 audit pipeline must absorb bespoke code for the first time (parimutuel, PT/YT AMM, credit underwriting), and every fee line lands on the same SwapFeeRouter three-way split so the flagged wing pays the same stakers it puts at reputational risk.

### #12 — Prediction markets

**Preconditions:** DECISION GATE FIRST — operator signs a written regulatory-risk acceptance in docs/YEAR_PLAN_2026_2027.md §"Not on the menu" amendment block (prediction markets are event-contract territory; Kalshi/Polymarket enforcement history named explicitly) plus a geo-blocking policy. Item 15 live for two months with clean settlements. F1 (resolution data), F3 (fee legs), F4 (keeper for resolution bumps), F7 (audit wave).

**The build:** Vendor VERBATIM at exact commit: Gnosis ConditionalTokens (gnosis/conditional-tokens-contracts) into contracts/src/predict/vendor/, plus UMA's OptimisticOracleV3 adapter pattern for open-ended crypto-price/venue-event resolution. Minimal delta: PredictMarketFactory.sol (creates condition + FPMM-style pool, hardcodes fee recipient) and PredictFeeRouter.sol built on base/OwnableNoRenounce.sol. Deploy via contracts/script/DeployPredictionMarkets.s.sol through the F7 Safe ceremony. Backend: `?resource=predict` in the aggregator catchall, lazy-import handler api/_lib/predict.js (market list, resolution status), rate-limited via api/_lib/ratelimit.js. Frontend: new frontend/src/pages/PredictPage.tsx + frontend/src/lib/predict/ (client, odds math, resolution display); gate rendering through isDeployed() in frontend/src/lib/constants.ts. Data: new indexer tables in indexer/ponder.schema.ts — `predictMarket`, `predictPosition`, `predictResolution`.

**Fee wiring:** 1.5% taker fee on fills, paid by the taker in the collateral token, collected by PredictFeeRouter → converted to ETH → RevenueDistributor/treasury/POLAccumulator on the SwapFeeRouter three-way convention (stakers ≥50%, POL ≤25%, remainder treasury).

**Gates:** Written regulatory amendment before any code; geo-block enforced server-side in api/_lib/predict.js; honesty-gating — resolution source and dispute window rendered on every market, "unresolved" never rendered as a price; full F7 adversarial audit wave; venue-event markets flag-gated until UMA-adapter markets prove out.

**Done when:** (1) a crypto-price market completes create→trade→optimistic-resolve→redeem on mainnet; (2) a disputed resolution round-trips the UMA escalation path on a fork test; (3) fees land in RevenueDistributor with the split event emitted; (4) geo-block verified from a blocked jurisdiction IP.

### #15 — Launch-outcome prediction markets (parimutuel)

**Preconditions:** DECISION GATE FIRST — same written regulatory acceptance as #12, recorded before code; this is the deliberately-defensible first step (parimutuel, no house capital, venue-verifiable settlement). F1 deployed (graduation/outcome events indexed — semantics already exist in frontend/src/lib/launcher/outcomes.ts), F3, F7.

**The build:** There is no battle-tested verbatim parimutuel fork, so this consciously amends the verbatim-fork law: ParimutuelPot.sol is a deliberately tiny (~250 LoC) bespoke contract — bet YES/NO into two pots, pro-rata payout, no oracle token, no AMM — with echidna invariants (pot conservation, no payout before settlement) mandatory in CI per F7. Settlement is trust-minimized: a PotSettler adapter reads on-chain facts directly where possible (Doppler Airlock migration state for "will it graduate", TegridyTWAP for "holds $X FDV at T"); anything only the indexer can see settles via operator-signed attestation with a 24h dispute window that refunds all pots on challenge. Deploy contracts/script/DeployParimutuel.s.sol. Backend: `?resource=parimutuel` catchall leg, api/_lib/parimutuel.js. Frontend: frontend/src/lib/predict/parimutuel.ts + a panel on the launch pages (extend frontend/src/pages/LaunchPage.tsx and the token dossier via frontend/src/lib/launcher/tokenDossier.ts). Data: indexer tables `potMarket`, `potBet`, `potSettlement`.

**Fee wiring:** 2% of winning payouts only (losers pay nothing extra), skimmed at claim inside ParimutuelPot → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter split convention.

**Gates:** Regulatory amendment signed; house never seeds pots ("may not spend capital it has not earned" — fully compliant, zero house capital); honesty-gating — implied odds shown live, settlement source labeled on-chain vs attested; attested-settlement markets stay flag-gated until three clean on-chain-settled cycles.

**Done when:** (1) a graduate/not pot settles purely from on-chain state on mainnet; (2) echidna pot-conservation invariant green in CI; (3) 2% claim fee arrives at RevenueDistributor; (4) dispute path refunds a challenged attested market on fork test.

### #86 — Self-repaying loans (Alchemix fork)

**Preconditions:** No law amendment needed if scoped to alETH only (ETH-denominated synthetic — the no-stablecoin law is untouched; state this scoping in writing in the item's design note; alUSD would trigger #90/#91's gate). F1, F3, F7; a live yield source with a harvestable adapter — TegridyLPFarming positions and, once deployed, TegridyRestaking.

**The build:** Vendor Alchemix v2 VERBATIM at exact commit (alchemix-finance/v2-foundry: AlchemistV2, AlchemicTokenV2, TransmuterV2) into contracts/src/alchemix/vendor/ with F7 diff-guard CI. Minimal delta: two YieldTokenAdapter implementations — WstETHAdapter (verbatim from Alchemix's own adapters) and a new TegridyFarmAdapter wrapping TegridyLPFarming receipt positions as ERC4626 (this adapter is the only new code; fork-test it against mainnet farm state). Cap alETH mintable at 50% LTV exactly as upstream. Deploy contracts/script/DeployAlchemists.s.sol via Safe ceremony. Backend: `?resource=alchemix` catchall leg, api/_lib/alchemix.js for position/health reads. Frontend: extend frontend/src/pages/LendingPage.tsx with a "Self-repaying" tab; new lib frontend/src/lib/alchemix/client.ts; isDeployed()-gated. Data: indexer tables `alchemistPosition`, `alchemistHarvest`.

**Fee wiring:** 10% of every harvested collateral yield, taken in the harvest call by the Alchemist's protocolFee (upstream mechanism, just set the bps and recipient) → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter split convention. Borrowers pay nothing else; no liquidations exist.

**Gates:** Verbatim-fork law satisfied except the one adapter (flagged for adversarial review); real-yield law satisfied — debt repays only from actually-harvested yield; honesty-gating — repayment ETA computed from trailing realized yield, never projected APR; TegridyFarmAdapter collateral stays flag-gated behind wstETH-only launch.

**Done when:** (1) deposit wstETH → mint alETH → harvest reduces debt on mainnet; (2) Transmuter redeems alETH 1:1 over time on fork test; (3) 10% harvest fee lands in RevenueDistributor.

### #87 — Native fixed-yield market (own PT/YT)

**Preconditions:** DECISION GATE FIRST — Pendle v2's AMM math is not verbatim-forkable (license + bespoke logit-normal curve), so this item opens with a written amendment to the verbatim-fork law in docs/YEAR_PLAN_2026_2027.md: "bespoke AMM permitted for PT/YT only, contingent on halmos formal-verification coverage of the invariants and a dedicated audit wave." Operator signs before code. F1, F3, F7 (halmos in CI is load-bearing here), and at least two live venue yield streams (RevenueDistributor staker ETH yield via a wrapper, TegridyLPFarming; later TegridyRestaking).

**The build:** Contracts in contracts/src/fixedyield/: SY wrappers first — ERC4626 StandardizedYield adapters over farm receipts and a staked-position yield wrapper (these ARE verbatim-pattern, model on Pendle's SY interface); then PrincipalToken.sol/YieldToken.sol split with expiry; then the AMM — either negotiate Pendle license for a true verbatim vendor (preferred; record outcome in the amendment) or implement the logit-normal curve bespoke with halmos proofs of no-arbitrage-at-expiry and PT+YT=SY conservation. Deploy contracts/script/DeployFixedYield.s.sol per-expiry via Safe ceremony. Backend: `?resource=fixedyield` catchall leg, api/_lib/fixedyield.js. Frontend: new frontend/src/pages/YieldPage.tsx + frontend/src/lib/fixedyield/; implied-APY math with tests alongside frontend/src/lib/lpEmissions.ts. Data: indexer tables `syDeposit`, `ptYtMint`, `yieldAmmSwap`.

**Fee wiring:** 5% of all YT-claimed yield (skimmed in YieldToken.claim) + 10% of AMM swap fees, both → ETH → the SwapFeeRouter three-way split, with the staker leg ≥50% flowing to RevenueDistributor — mirroring vePENDLE's alignment onto veTOWELI.

**Gates:** Amendment signed; honesty-gating — fixed APY shown is the tradeable market rate, labeled "market-implied, not guaranteed"; single short-dated expiry flag-gated pilot first; full adversarial audit wave on the AMM.

**Done when:** (1) SY→PT/YT split and merge conserve value in halmos; (2) one expiry completes mint→trade→mature→redeem on mainnet; (3) YT yield fee reaches RevenueDistributor; (4) implied-APY display matches on-chain curve within tolerance in tests.

### #88 — Covered-call vaults

**Preconditions:** No law amendment — options sold against fully-held collateral, no leverage, no house capital; record the risk note (capped upside, drawdown weeks) in the fact sheet. F1, F3, F4 (weekly roll keeper), F7. EVM/ETH first; SOL leg deferred until the Solana program redeploy question (closed program IDs) is settled elsewhere.

**The build:** Vendor VERBATIM at exact commit: Ribbon v2 ThetaVault stack (ribbon-finance/ribbon-v2: RibbonThetaVault, VaultLifecycle, the oToken/Opyn Gamma dependency) into contracts/src/options/vendor/, plus Gnosis EasyAuction (gnosis/ido-contracts) VERBATIM for the weekly market-maker auction — both are battle-tested, both diff-guarded in CI. Minimal delta: OptionsFeeRecipient.sol redirecting management/performance fees, and strike-selection parameters (10-delta weekly calls on wstETH, cash-secured puts in a second vault). Deploy contracts/script/DeployThetaVaults.s.sol via Safe ceremony. Keeper: F4 job that commits the weekly roll (settle expired → select strike → mint oTokens → start auction) with receipt discipline. Backend: `?resource=options` catchall leg, api/_lib/options.js (vault state, auction status). Frontend: extend frontend/src/pages/FarmPage.tsx with a Vaults section or new frontend/src/pages/VaultsPage.tsx; lib frontend/src/lib/options/client.ts; isDeployed()-gated. Data: indexer tables `optionRound`, `vaultDeposit`, `auctionFill`.

**Fee wiring:** 2% annualized management (weekly pro-rata) + 10% performance on premium earned, charged in-round by the upstream fee mechanism, recipient = OptionsFeeRecipient → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter split convention. Depositors pay; MMs pay auction gas.

**Gates:** Honesty-gating is the hard requirement — render realized round-by-round P&L including losing rounds, never headline APY from best weeks; category-economics warning (Derive $3.5M) stays in the fact sheet; auction-fill data self-gates to "no data" until the first round completes.

**Done when:** (1) one full weekly round (deposit→auction→expiry→settlement) completes on mainnet with a real MM fill; (2) fees land in RevenueDistributor; (3) UI shows realized round history from indexer data only.

### #89 — Basis yield vault

**Preconditions:** DECISION GATE FIRST — this is a design-gated XL program. Before any code: a signed design doc in docs/ (pattern: docs/CAPITAL_REQUIREMENTS_2026_08_15.md) in which the operator explicitly accepts (a) the perp leg touches the no-perps law — amendment: "venue may HOLD hedging shorts on external venues; it still does not OFFER perps"; (b) custody: choose on-chain-only (Hyperliquid via builder-code API) explicitly to avoid CEX custody, or sign a separate custody-risk acceptance for Ceffu/Copper; (c) negative-funding regimes produce losses that users eat — front-of-fact-sheet. F1, F4 (hedge-rebalance keeper is the core), F5 (exchange API ops), F7.

**The build:** Contracts: BasisVault.sol as ERC4626 in contracts/src/basis/ — deposits wstETH/USDC, mints shares against a NAV oracle; the short leg lives off-vault on Hyperliquid under a venue-operated account, so the contract itself is small: deposit queue, withdrawal queue with epoch delay, NAV attestation posted by a keeper with staleness bounds and a deviation circuit-breaker (PauseGuardian from contracts/src/base/). No verbatim fork exists for the whole; vault shell forks a plain ERC4626 (solmate/OZ) verbatim, the delta is the NAV/queue logic — flagged for its own audit wave. Keeper: F4 job maintaining delta-neutrality within bands, with signed hedge-state receipts published. Backend: `?resource=basis` catchall leg, api/_lib/basis.js exposing live hedge state, funding capture, and drift. Frontend: frontend/src/pages/VaultsPage.tsx section + frontend/src/lib/basis/client.ts. Data: indexer tables `basisEpoch`, `basisNav`, `basisFlow`.

**Fee wiring:** 15% of positive funding actually harvested per epoch (nothing on negative epochs), skimmed at NAV update → ETH → RevenueDistributor/treasury/POL split convention.

**Gates:** Both written acceptances signed; honesty-gating — real-time hedge drift and trailing realized (not projected) yield rendered, negative epochs shown in red, NAV staleness self-gates deposits closed; hard TVL cap flag-gated at pilot size until two full negative-funding episodes are survived publicly.

**Done when:** (1) deposit→hedge→epoch NAV→withdrawal round-trips at pilot cap; (2) circuit-breaker halts deposits on a simulated NAV deviation in fork test; (3) fee only accrues on positive-funding epochs, verified from indexer data.

### #90 — CDP borrowing (Liquity V2 fork)

**Preconditions:** DECISION GATE FIRST — written amendment to the no-stablecoin line in docs/YEAR_PLAN_2026_2027.md: "an immutable, governance-free, overcollateralized CDP dollar is permitted; a custodial/synthetic dollar remains banned unless #91's separate gate is passed." Operator signs. F1, F3, F7. Item 86 NOT required; this supersedes nothing live.

**The build:** Fork Liquity V2 (liquity/bold) VERBATIM at exact commit into contracts/src/cdp/vendor/ — it is explicitly built to be forked: immutable, no admin keys, user-set interest rates, per-collateral branches. This is the best-aligned build in the flagged wing because it satisfies the immutable-contracts law natively. Minimal delta: branch configuration only — launch with a single wstETH branch using the stock PriceFeed pattern; the differentiated second branch (staked venue positions as collateral) requires a bespoke collateral adapter + VotePowerOracle-style pricing (contracts/src/lib/VotePowerOracle.sol as reference) and stays flag-gated behind its own audit wave. Name the dollar tUSD. Deploy contracts/script/DeployCDP.s.sol via Safe ceremony; verify with a VerifyCDP.s.sol mirroring script/VerifyMVP.s.sol. Backend: `?resource=cdp` catchall leg, api/_lib/cdp.js (trove health, redemption risk). Frontend: extend frontend/src/pages/LendingPage.tsx with a Borrow tab + frontend/src/lib/cdp/; isDeployed()-gated. Data: indexer tables `trove`, `troveEvent`, `stabilityDeposit`, `redemption`.

**Fee wiring:** 100% of user-set borrow interest accrues to the system exactly as upstream: split between the Stability Pool incentive and a protocol take — set the protocol leg's recipient to a CDPFeeRouter that converts to ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention.

**Gates:** Amendment signed; verbatim-fork law fully satisfied on branch one; honesty-gating — redemption risk ("lowest-rate troves get redeemed first") rendered on every trove, tUSD peg state shown from TWAP, never assumed $1; venue-collateral branch flag-gated indefinitely until audited.

**Done when:** (1) open trove→borrow tUSD→repay→close on mainnet; (2) liquidation and redemption paths exercised on fork test; (3) interest revenue reaches RevenueDistributor; (4) diff-guard CI proves zero drift from upstream commit.

### #91 — sTOWEL synthetic dollar

**Preconditions:** DECISION GATE FIRST — the biggest conflict in the list, so the gate is the build: a standalone docs/STOWEL_DECISION.md requiring (a) amendment of the no-stablecoin law specifically for a delta-neutral synthetic (separate from #90's CDP amendment), (b) custody-risk acceptance (even Hyperliquid-only, backing sits on an external venue — this violates minimal-attack-surface and the operator must own that in writing), (c) legal counsel sign-off on issuance structure, (d) #89 basis vault run publicly for ≥2 quarters including a negative-funding episode. If any leg fails, this item terminates and the doc records why. Also F1, F4, F5, F7.

**The build (only after the gate):** Fork Ethena's contract surface VERBATIM where published (ethena-labs: USDe token, EthenaMinting with signed-order mint/redeem, sUSDe as ERC4626 staking) into contracts/src/stowel/vendor/. Minimal delta: rename to sTOWEL/stTOWEL, restrict minting to whitelisted market-makers exactly as upstream, wire the reserve-fund address. The real build is operational: the F4 hedging keeper hardened from #89, a reserve fund that must be pre-funded ONLY from earned venue revenue ("may not spend capital it has not earned" — the reserve is retained earnings, never raised), and a daily proof-of-backing attestation published via `?resource=stowel` (api/_lib/stowel.js) and rendered on frontend/src/pages/TreasuryPage.tsx. Frontend: frontend/src/lib/stowel/ + mint/stake UI, isDeployed()-gated. Data: indexer tables `stowelMint`, `stowelBacking`, `stowelYield`.

**Fee wiring:** The spread — funding + staking yield on backing minus stTOWEL payout — flows to the reserve until a written reserve target is met, then to RevenueDistributor/treasury/POL per convention.

**Gates:** All four gate legs signed; honesty-gating — backing composition and hedge venue exposure published daily, staleness self-gates minting closed; mint caps flag-gated in small steps.

**Done when:** (1) gate doc fully executed; (2) MM mint→hedge→redeem cycle at pilot cap; (3) daily attestation live and consumed by TreasuryPage; (4) reserve target funded from spread before any distributor payout.

### #92 — Native perps DEX

**Preconditions:** DECISION GATE FIRST — full repeal-in-writing of the no-perps law (docs/YEAR_PLAN_2026_2027.md line-222 item), carrying the decay warning verbatim from docs/TOP_100_BUILDS.md #92 (GMX's collapse to $38M — sub-scale perps venues decay) and an explicit oracle-risk acceptance. Design-gated XL: a design doc choosing the pattern must be approved before code. Sequencing: only after #89 proves the team can run delta-exposure ops, and ideally after #90's revenue ships. F1, F4, F7; low-latency oracle contract (Chainlink Data Streams or Pyth pull) — a NEW external dependency the amendment must name.

**The build:** Fork GMX v2 (gmx-io/gmx-synthetics) VERBATIM at exact commit into contracts/src/perps/vendor/ — pool-as-counterparty (GM pools), no orderbook infrastructure needed, battle-tested. Minimal delta: market configuration (ETH/USD and TOWELI/USD only at launch — TOWELI market flag-gated pending TegridyTWAP manipulation analysis), fee-receiver wiring, and keeper roles bound to F4 executors for order execution/liquidations with retry/receipt discipline. Deploy contracts/script/DeployPerps.s.sol via Safe ceremony. Backend: `?resource=perps` catchall leg, api/_lib/perps.js (positions, funding, oracle status). Frontend: new frontend/src/pages/PerpsPage.tsx + frontend/src/lib/perps/; reuse frontend/src/components/swap/TokenSelectModal.tsx; isDeployed()-gated. Data: indexer tables `perpPosition`, `perpTrade`, `fundingRate`, `liquidation`.

**Fee wiring:** 5bps open/close + borrow/funding spread + liquidation fees, exactly the upstream fee router, recipient = PerpsFeeRouter → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention; GM-pool LPs earn their upstream share untouched.

**Gates:** Law repeal signed; honesty-gating — oracle staleness self-gates trading paused (SequencerCheck pattern in contracts/src/lib/SequencerCheck.sol), realized LP pool P&L rendered honestly including trader-win weeks; open-interest caps flag-gated at pilot size; dedicated adversarial audit wave on oracle integration.

**Done when:** (1) open→fund→close and a liquidation execute on mainnet via F4 keepers; (2) oracle-staleness pause verified on fork test; (3) fees reach RevenueDistributor; (4) OI caps enforced on-chain.

### #93 — PvP degen games

**Preconditions:** DECISION GATE FIRST — this ships ONLY if the operator signs the ethics line in writing: a docs/GAMBLING_DECISION.md stating the venue knowingly offers zero-sum-minus-rake games, with jurisdiction analysis, an age/geo-block policy, and a self-exclusion commitment. No signature, no build — and record the refusal in the doc if declined. F2 (identity for self-exclusion), F3, F7. EVM only (Solana program IDs are closed).

**The build:** Strictly PvP escrow, zero house bankroll — "may not spend capital it has not earned" is satisfied structurally. No battle-tested verbatim fork exists, so this consciously amends the verbatim-fork law with a deliberately tiny surface: contracts/src/games/PvPEscrow.sol (~300 LoC) — create challenge with stake, opponent matches, outcome from Chainlink VRF (coin flip) or commit-reveal (duels), winner pulls pot minus rake; echidna invariants (escrow conservation, no outcome before randomness, refund-on-timeout) mandatory per F7. Deploy contracts/script/DeployPvPGames.s.sol. Backend: `?resource=games` catchall leg, api/_lib/games.js (open challenges, geo-block enforcement server-side, self-exclusion list backed by the F2 Supabase profile). Frontend: new frontend/src/pages/GamesPage.tsx + frontend/src/lib/games/client.ts, kept OUT of primary nav (frontend/src/lib/navConfig.ts entry behind the flag); isDeployed()-gated. Data: indexer tables `gameChallenge`, `gameResult`.

**Fee wiring:** 3.5% rake on each pot, skimmed at settlement in PvPEscrow → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention. Players pay; no other fees.

**Gates:** Signed ethics doc is the gate; honesty-gating extends to EV honesty — the exact rake and "this is zero-sum minus 3.5%" rendered on the bet ticket, VRF proof linked per result; geo-block + self-exclusion enforced before any wager UI renders; flag-gated to coin flip only until VRF settlement proves clean.

**Done when:** (1) two wallets complete flip→VRF→payout on mainnet with proof rendered; (2) timeout refund path verified; (3) rake lands in RevenueDistributor; (4) self-excluded wallet is blocked at both API and UI.

### #94 — Daily jackpot

**Preconditions:** DECISION GATE FIRST — covered by the same signed docs/GAMBLING_DECISION.md as #93 (extend it with a lottery-specific section: negative-EV product, jurisdictional lottery laws are stricter than gaming laws). No signature, no build. #93 shipped first and clean (shared VRF plumbing and self-exclusion rails). F2, F3, F7.

**The build:** Megapot-pattern: third-party LPs supply the bankroll and carry actuarial risk — the venue never risks capital ("may not spend capital it has not earned" satisfied structurally; state this in the doc). Megapot's contracts are source-visible on Base: vendor VERBATIM at the exact deployed commit into contracts/src/games/vendor/ if the license permits; otherwise write a minimal Jackpot.sol (~400 LoC) under the same conscious verbatim-law amendment as #93 — $1-equivalent USDC tickets, daily VRF draw, LP pool underwrites the jackpot and earns the ticket margin share, echidna invariants (LP solvency ≥ max payout, ticket conservation). Deploy contracts/script/DeployJackpot.s.sol via Safe ceremony. Backend: extend `?resource=games` in api/_lib/games.js with jackpot state + draw history; reuse #93's geo-block and self-exclusion enforcement. Frontend: jackpot section on frontend/src/pages/GamesPage.tsx + frontend/src/lib/games/jackpot.ts; behind the same nav flag. Data: indexer tables `jackpotDraw`, `jackpotTicket`, `jackpotLp`.

**Fee wiring:** Ticket-fee margin only — of each $1 ticket, ~70% to prize pool, ~23% to bankroll LPs, 7% venue fee; the prize pool is never touched. Venue leg → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention.

**Gates:** Signed gambling doc extended and re-signed; EV honesty mandatory — expected value per ticket and odds rendered on the purchase button itself; LP risk disclosure on the deposit side; flag-gated at a small max jackpot until three clean draws; VRF draw proofs linked per draw.

**Done when:** (1) full day-cycle ticket→draw→payout on mainnet with VRF proof; (2) LP solvency invariant green in echidna; (3) venue margin lands in RevenueDistributor; (4) EV disclosure renders on the ticket UI.

### #95 — Heat credit lines

**Preconditions:** DECISION GATE FIRST — written default-risk acceptance: undercollateralized lending WILL take defaults; the doc must cap the pilot book and name whose capital eats losses (third-party lender pool — never venue treasury, preserving "may not spend capital it has not earned"). F8 is the hard dependency (Heat + deployer-reputation + wallet-exposure as signed attestations — this item is why F8 exists), plus F1, F2 (SIWE-bound identity), F7. Heat tiers come from the Jungle Bay oracle via frontend/src/lib/heat/heatClient.ts — the venue reads, never computes.

**The build:** The most differentiated and least proven bet — build small. Contracts: contracts/src/credit/HeatCreditPool.sol — Maple-style single lender pool (fork Maple's pool shell VERBATIM where it fits; the underwriting delta is necessarily bespoke and flagged) — lenders deposit USDC/ETH; borrowers draw against a CreditLine sized by an F8 signed attestation verified on-chain (attestation carries tier, deployer score, exposure; Elder tier caps highest, floor at Resident). Default enforcement is reputational-first: default slashes the borrower's venue standing permanently (on-chain registry consumed by frontend/src/lib/heat/launchGate.ts — a defaulted wallet can never pass the launch gate again) plus optional partial veTOWELI collateral. Deploy contracts/script/DeployHeatCredit.s.sol. Backend: `?resource=credit` catchall leg, api/_lib/credit.js (attestation issuance via F8, line status). Frontend: new frontend/src/pages/CreditPage.tsx + frontend/src/lib/credit/; extend frontend/src/lib/heat/attestation.ts for the credit attestation shape. Data: indexer tables `creditLine`, `creditDraw`, `creditDefault`.

**Fee wiring:** 1% origination on each draw + a venue spread of 15% of interest paid; both → ETH → RevenueDistributor/treasury/POLAccumulator per convention. Lender pool keeps 85% of interest and carries defaults.

**Gates:** Signed default-risk doc; honesty-gating — pool page renders realized default rate from day one, self-gates to "no history" honestly; pilot flag-gated: $50k pool cap, $500 max line, Resident+ only.

**Done when:** (1) attestation→draw→repay cycle on mainnet; (2) a test default correctly slashes launch-gate standing; (3) realized default rate renders from indexer data; (4) caps enforced on-chain.

### #96 — T-bill RWA vault

**Preconditions:** DECISION GATE FIRST — written amendment of the no-RWA law naming: the chosen issuer (Ondo USDY-class), the KYC provider, securities-law counsel sign-off, and an honest statement of the economics (Ondo's USDY earned ~$54K/month on billions AUM — this is a retention feature, not a revenue line; the doc must say so). Marked build-last-or-never: if the amendment stalls, close the item. F2 (KYC-bound identity via SIWE), F5 (partner API ops), F7.

**The build:** Deliberately minimal — the venue is a distribution front-end, not an issuer, keeping attack surface near zero. Contracts: at most one thin contract, contracts/src/rwa/RWAGateway.sol — a KYC-allowlisted deposit forwarder that routes USDC to the issuer's mint contract and holds nothing overnight; if the issuer supports direct wallet flows, ship ZERO contracts and integrate purely client-side (preferred; DELETE before ADD). Backend: `?resource=rwa` catchall leg, api/_lib/rwa.js — KYC status proxy, issuer yield/NAV data passthrough with the source labeled; Upstash rate-limited. Frontend: a "Safe yield" section on frontend/src/pages/DashboardPage.tsx or LendingPage.tsx + frontend/src/lib/rwa/client.ts; the KYC flow gated through the F2 profile; non-KYC'd users see the product with an honest "requires verification" state, never a fake balance. Data: indexer table `rwaFlow` only if the gateway contract exists; otherwise issuer-API data clearly labeled third-party.

**Fee wiring:** 15–25bps AUM via the issuer's distribution-partner agreement — paid BY the issuer to the venue off-chain or via fee-share token flows; landed revenue converted to ETH → RevenueDistributor/treasury/POLAccumulator per convention. Users pay nothing extra.

**Gates:** Amendment + counsel sign-off are absolute blockers; honesty-gating — yields shown are the issuer's published net yield with issuer named, custody/counterparty risk in the fact sheet; entire surface flag-gated until the partner agreement is executed.

**Done when:** (1) a KYC'd wallet completes deposit→yield accrual→redemption through the issuer; (2) first fee-share payment received and distributed; (3) non-KYC state renders honestly with no fake data.

### #97 — Managed RPC + enriched data

**Preconditions:** DECISION GATE FIRST — written risk acceptance that raw RPC is a commodity race to the bottom (Alchemy publishes no revenue; the doc must state the venue only sells the enriched layer and treats RPC as bundled convenience). Build last: F5 is a hard prerequisite (API keys, metering, billing, and the serverless-budget escape — this cannot live inside the 12-function Vercel cap), plus F1 (decoded swap/launch data) and F8 (reputation scores as sellable data).

**The build:** No contracts — pure F5 platform surface. Backend, all on the F5 dedicated api host (NOT the Vercel catchall): (1) an RPC proxy pool over upstream providers (reuse the failover pattern in api/_lib/alchemy-failover.js as the reference implementation), metered per F5 key; (2) the defensible layer — enriched endpoints serving what nobody else has: decoded venue swaps and launch lifecycle from the F1 Ponder tables (`swap`, `indexedPair`, plus the launcher outcome tables), launch fact-sheets (frontend/src/lib/launcher/factSheet.ts logic promoted server-side), Heat-tier and deployer-reputation reads via F8 signed attestations; (3) plan tiers (free/dev/pro) enforced by F5 metering with Upstash-style rate limits per key. Frontend: extend the developer docs surface — add a Developers section to frontend/src/pages/ContractsPage.tsx or a new frontend/src/pages/DevelopersPage.tsx with key management UI bound to the F2 SIWE session. Data: F5 metering tables (per-key usage) in the F5 store; no new indexer tables.

**Fee wiring:** Metered subscription revenue (Stripe or on-chain per F5's billing choice), paid by developers; net revenue converted to ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention — API revenue is real yield and flows like all other fees.

**Gates:** Risk-acceptance doc signed; honesty-gating — enriched endpoints self-gate to "no data" rather than padding responses, and third-party-sourced fields are labeled; free tier flag-gated open first to validate demand before billing ships.

**Done when:** (1) a metered key fetches decoded venue swaps from the F5 host; (2) rate tiers enforce correctly at the limit; (3) first paid subscription revenue lands and routes to the distributor path.

### #99 — Looped leverage tokens

**Preconditions:** DECISION GATE FIRST — written risk acceptance covering volatility decay (rebalancing 2–3× products bleed in chop; Toros-style decay disclosure is mandatory, not optional) and liquidation-cascade risk in thin markets. Requires a live lending market: either rank 14's Morpho-Blue-fork isolated pairs or a decision to finally deploy the audited contracts/src/TegridyLending.sol — name which in the doc. F1, F4 (rebalance keeper), F3, F7.

**The build:** Contracts: contracts/src/leverage/LoopToken.sol — ERC4626 vault per product (ETH2X, ETH3X first; TOWELI2X flag-gated pending liquidity-depth analysis against TegridyTWAP) that loops deposit→borrow→swap→re-deposit through the lending market and swaps via TegridyRouter (own DEX flow is part of the point). Fork the vault shell VERBATIM from a battle-tested ERC4626 base (solmate) plus Toros/Index-Coop's flash-loan rebalance pattern where source-licensed; the loop math delta is small and gets echidna invariants (leverage stays within [target−band, target+band]; vault never liquidatable above band floor). Keeper: F4 job triggers rebalance when leverage drifts past bands, with retry/receipt discipline; keeper failure self-gates minting paused via PauseGuardian (contracts/src/base/PauseGuardian.sol). Deploy contracts/script/DeployLoopTokens.s.sol via Safe ceremony. Backend: `?resource=leverage` catchall leg, api/_lib/leverage.js (live leverage ratio, decay stats). Frontend: section on frontend/src/pages/VaultsPage.tsx (or FarmPage.tsx) + frontend/src/lib/leverage/client.ts; isDeployed()-gated. Data: indexer tables `loopTokenState`, `loopRebalance`.

**Fee wiring:** 1% annualized AUM streamed at rebalance + all loop swap flow routed through TegridyRouter/SwapFeeRouter (second-order fee capture); AUM fee → ETH → RevenueDistributor/treasury/POLAccumulator per the SwapFeeRouter convention.

**Gates:** Risk doc signed; honesty-gating — realized vs target leverage and a trailing decay-vs-spot chart rendered from indexer data, never a naive "3× ETH" promise; supply caps flag-gated at pilot size; no perps involved, so the no-perps law is untouched — state this explicitly.

**Done when:** (1) mint→drift→keeper rebalance→redeem completes on mainnet within bands; (2) keeper-down condition pauses minting on fork test; (3) AUM fee reaches RevenueDistributor; (4) decay chart renders from real rebalance history.

---

# Part III — The Tradermigos annex

A dedicated three-agent sweep (2026-08-18) walked the marketplace sub-app (`frontend/src/nakamigos`, ~177 files) file-by-file — the surface the repo's own inventory admitted nobody had looked at — plus a rest-of-app coverage pass. What follows corrects and extends every wave item that touches NFTs, social, or the marketplace. **Read this before starting any item in Waves 6 or 7.**

## What Tradermigos actually is

A genuine two-rail, three-collection (Nakamigos, GNSS Art, Jungle Bay) NFT marketplace mounted at `/nakamigos/*`:

- **Native rail:** Seaport v1.5 signed orders stored in Supabase `native_orders` via `/api/orderbook`, fulfilled directly on Seaport with no marketplace dependency. The money paths are unusually hardened — server-side EIP-712 + EIP-1271 verification, on-chain `ownerOf` checks, order-shape pinning (FULL_OPEN / zero-zone / canonical conduit / ERC-721 / ETH-only), canonical `seaport_order_hash` re-derivation, receipt-verified fills that fail closed, refuse-don't-soft-cancel relist policy.
- **OpenSea rail:** listings feed, item/collection/trait offers, and fulfillment through the `/api/opensea` proxy.
- **P2P trades:** a full Seaport swap implementation — NFTs-for-NFTs with WETH sweetener/ETH top-up, Dutch cash legs, wildcard criteria for an open trade board, EIP-5792 atomic approve+fill, real on-chain cancel, push notifications.
- **Social half:** real Supabase community chat (per-collection rooms, presence, reactions, holder-gated posting), a complete RLS-scoped DM system with inline trade cards (accept a Seaport trade from inside a DM), holder analytics, a unit-tested SVG depth chart, PWA install prompt, 42 test files.

## Where the money leaks (fix these before building anything new here)

| Flow | Venue fee today | The fix |
|---|---|---|
| Native listings (single) | ✅ 1% to the treasury Safe `0x7D26…Bd7d`, trustless consideration item | — (this is the template; `lib/orderbook.js:365-381`) |
| Single-item offers via UI | ✅ 1% WETH item rides the OpenSea order | — |
| Buys of OpenSea listings in-app | ❌ zero — OpenSea + creator get paid, venue gets nothing (most of today's inventory) | Aggregator-fee strategies per #63; long-term: grow native-book share |
| Collection & trait offers | ❌ zero — OpenSea `partialParameters` used verbatim | Append the 1% consideration item + bump `totalOriginalConsiderationItems`, mirroring `api-offers.js:283-292` |
| All P2P trades | ❌ zero by design (`lib/trades.js:227-244`) | Add an optional flat/percent fee leg to `buildTradeOrderParameters` |
| Bundle listings | 💤 fully built, dark behind `BUNDLE_LISTING_ENABLED=false` (client `constants.js:206` + server env) | Money-path re-audit, then flip both flags (migration 012 already applied) |
| Creator royalties on native rail | ❌ none — consideration is exactly `[sellerReceives, platformFee]` | Business decision: add ERC-2981 lookup as a third consideration item, or document the no-royalty stance honestly |

## The single highest-leverage file on this surface

> ✅ **shipped 2026-08-18** — `frontend/scripts/compute-rarity.mjs` written (checkpointed, resume-capable) and the full 20,000-token `data/rarity.json` generated (186 distinct traits, 754 KB; scoring mirrors the runtime fallback exactly, so precomputed and runtime ranks agree in method). The consumer activated with zero code changes. Watch: the JSON is statically imported by `api.js`, so it inlines into the lazy nakamigos bundle — check bundle size on the next build.

`scripts/compute-rarity.mjs` **did not exist** and `data/rarity.json` was an empty stub — so 0 of 20,000 Nakamigos tokens have precomputed rarity. Writing this one generator (emit `{generatedAt, totalTokens: 20000, traitCount, rarity: {"<tokenId>": {rank, score}}}`; the consumer at `api.js:839-856` needs zero changes) simultaneously fixes the RaritySniper-empty defect, Analytics trait distribution, RarityPriceScatter joins, Deals rank drift, and removes TraitExplorer's need to hammer the API loading all 20K tokens. **Do this first, before any Wave 7 item.**

## Standing corrections to wave items

- **#61 (NFT pool lending):** the integration seam exists — `NFT_LOAN_DESK_LIVE` gates CTAs keyed off the live lending address. Use the *sanitized native floor* from `/api/orderbook` (price-capped, ETH-only, bundles excluded) for valuations, never raw OpenSea. Never reuse the Seaport conduit approval for collateral escrow — a listing approval must never double as a collateral approval. `createNativeListing` is the ready-made liquidation rail (1% fee back to treasury); bundles (once live) fit basket liquidations.
- **#62 (BNPL):** `assertSameWallet` forces payer === connected wallet on every buy path — an escrow-pays flow needs its own path, never a bypass flag. Follow the `BUNDLE_LISTING_ENABLED` dark-flag pattern: off until migration + env + money-path re-audit.
- **#63 (aggregator):** the app already IS a two-venue aggregator (native + OpenSea merged rows, venue badges, per-venue fulfill routing, EIP-5792 batch sweep). Extend the `useListings`/`fetchListings` merge with new sources using the same pattern: pinned per-venue target allowlist + venue-tagged rows. **Hard constraint:** the venue's own proxies already 429 under normal browsing — server-side caching/batching must land before any Blur/Reservoir fan-out or the aggregator DoSes itself.
- **#75/#76/#77 (paid DMs, tipping, clubs):** do NOT build new messaging. DMs (`lib/dm.js` + migration 007 + `DirectMessages.jsx`) and multi-room chat (rooms are just `messages.slug` partitions) are reusable wholesale; the `trade_id`-column pattern is exactly how a payment receipt attaches to a message. **The one genuinely new piece:** today's holder gate is client-side only — a signed-in non-holder can post via a direct proxy call. Move the holding/payment gate server-side (supabase-proxy INSERT path or RLS) before charging anyone for access.
- **All social items:** one SIWE sign-in covers the main app and all nakamigos writes (shared cookie). New tables go into `ALLOWED_TABLES` in `frontend/api/supabase-proxy.js`; migrations follow the 007 pattern. Ship the suite's convention: a pure-lib unit test plus an "honesty" test asserting the feature discloses when its migration/env isn't live.
- **Never break:** the order-shape pin (`validateOrderShape`), the 409 refuse-don't-soft-cancel relist policy, the `seaport_order_hash` requirement on every new order-creating path, the client/server `MAX_BUNDLE_ITEMS=15` lockstep, and the two separate allowlists (client `COLLECTIONS` map + server `ALLOWED_CONTRACTS`) that must both change to add a collection. Everything assumes mainnet (`chainId === 1` in ~10 guards and the signed message formats) — multi-chain items must not assume this generalizes.

## Known debt to fix opportunistically (don't worsen it)

Wrong-brand PWA manifest (installing from inside Tradermigos yields a "Tegridy Farms" app opening on `/` — both `manifest.json` and `manifest.webmanifest`); the nakamigos `ThemeContext` clobbers the main app's theme with no unmount cleanup (F531); dead splash enter-gate on deep links (F513); hardcoded `eth.llamarpc.com` in WhaleIntelligence/OnChainProfile; ~~the shared-AbortController retry bug in `fetchNativeListings`~~ (✅ fixed 2026-08-18 `1d17e4ce` — per-attempt controllers); ~~BidManager/MyListings passing hardcoded `SEAPORT_ADDRESS` into cancels~~ (✅ fixed 2026-08-18 `1d17e4ce` — cancels now use the order's own protocol address, fail-closed at the sink); collection-offer prices not normalized per item (depth hidden, not fixed); sweep/deals buys skipping the cart's 3-layer pre-flight; wallet inventory truncated at 100 NFTs; zero component tests on the social surfaces.

## Rest-of-app corrections (from the coverage pass)

- **The hub-page architecture is real:** 13 page files (Leaderboard, Premium, History, Tokenomics, Treasury, Contracts, etc.) are reachable only via relative lazy imports inside three hub pages (`ActivityPage`, `LearnPage`, `InfoPage`) — dead-code tooling false-positives on them; new surfaces get either a real route or a hub tab, never a third convention.
- **`frontend/plan/g01–g14` + `plan_input/`** is a pre-existing, verified-against-HEAD remediation corpus (including five nakamigos groups). Reconcile before writing new tasks on those surfaces — it has effort/risk/batch hints already.
- **`lib/detection/*`** (deployer reputation, wallet exposure, shared detection core) powers four routed pages, the launch simulator, and the OG-card middleware — the largest still-unmapped lib surface; map it before battle-plan items touch trust surfaces (#39, #40).
- **NFT drop work builds on V2 only:** `TegridyDropV2` + `components/launchpad/wizard/` + `useNFTDropV2`/`useIrysUpload`; the V1 factory is deprecated. Mint `feeRecipient` is already `REVENUE_DISTRIBUTOR_ADDRESS` (wizard `Step4_FundUpload.tsx:123`) — keep it.
- **Fix inline when touched:** `AMMSection.tsx` hardcodes the "0.5%" protocol-fee label instead of reading on-chain (LendingSection shows the right pattern).
- **Housekeeping item:** delete root `nul`, stale `idx.html`, `tegridy_100_findings_unpacked/`, ~35 loose media files; relocate/document `tl.so` (it's the real 2026-08-08 mainnet sBPF build of the closed tegridy-launch program — a historical artifact, not live code).
- **Copy law:** all new surfaces must match the post-honesty-pass fee claim — "stakers + liquidity engine + operations", never "100% to stakers" — the `revenueClaimHonesty`/`deployClaimHonesty` tests will fail dishonest copy.

---

*Assembled 2026-08-18 from a nine-agent drafting fleet (one foundations agent, eight wave agents), each grounded in direct repo exploration. Items covered: 100/100 (#1–#100 minus none expected). If a rank is missing here, the drafting agent for its wave dropped it — re-run that wave before trusting the plan complete.*
