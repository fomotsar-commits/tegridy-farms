# Frontend Changelog — 30-Day UX Push

One paragraph per shipped item. Newest first.

---

## P2-8 — Telegram notification bot scaffold (2026-05-14)

New service at `services/telegram-bot/` — a single long-running Node
process that polls the Ponder indexer for events touching bound
wallets and DMs the Telegram chats that bound them. Architecture
follows the brief verbatim: "dumb cron job that sends strings."

Surfaces:

- **Wallet binding** via `viem.verifyMessage` signature challenge —
  `/bind` issues a one-shot challenge with a 16-byte nonce, user
  signs in their wallet, `/bind 0x… 0x…` completes. No SIWE machinery
  because the bot only sends notifications — there's no privileged
  action to gate.
- **Five watchers** in `src/watchers.ts`:
  1. lending offers filled (notifies the lender),
  2. loans ≤24h from default (notifies the borrower),
  3. drops the user minted reaching sellout (cursor-tracked per
     collection; sellout detection is a TODO once `maxSupply` is
     indexed),
  4. gauge votes counted via `gaugeVoteRevealed`,
  5. restake claims above a per-user threshold (set via
     `/threshold 0.1`).
- **State** persists to a single JSON file (`.state.json`) — bindings,
  pending challenges, per-user thresholds, per-watcher cursors.
  Survives restarts; trivial to back up.

Commands: `/start /bind /status /unbind /threshold /help`. Bot only
replies in DMs; group chats ignored. Build / run / deploy notes in
`services/telegram-bot/README.md`.

Repo root gets `npm run telegram-bot:install / :dev / :start`
shortcuts mirroring the indexer pattern.
`FRONTEND_BLOCKERS.md` B-4 updated — bot is structurally complete;
operations needs to pick a host and a Telegram token. Hard
dependency on B-1 (indexer host) — the bot is pointless without an
indexer to query.

Deps inside the service (NOT in the frontend bundle):
`node-telegram-bot-api`, `viem`, `tsx`, `typescript`.

---

## P2-7 — ETH yield shown in dollars; APR sourced from chain (2026-05-14)

ETH-denominated amounts now carry a USD subtitle driven by the
Chainlink ETH/USD feed (already wired into `PriceContext.ethUsd` via
`useToweliPrice`). Applied at:

  • DashboardPage `ETHRevenueClaim` — pending ETH gains a
    `{usd} USD` line under the ETH counter. Hidden when the oracle
    is stale to avoid contradicting the live feed.
  • LaunchpadHomePage hero stats — "ETH Distributed" stat appends
    the USD figure inline ("0.0421 ETH · $135"), only when the
    oracle is fresh.

YieldCalculator's hardcoded `BASELINE_APR_PCT = 12` constant
replaced with `usePoolData().apr` — the chain-derived emission rate
computed from `rewardRate × 31,536,000 / totalBoostedStake`. When
chain returns 0 (day 0 / pre-emissions), falls back to a clearly
labelled "Reference 12% APR" placeholder. The chip in the calculator
header switches between "Live 18.42% APR" and "Reference 12% APR"
based on `usingChainData`; bottom-of-card disclaimer flips accordingly.

Brief sub-clause "annualized projections use boosted share of recent
RevenueDistributor inflow": partially addressed — the chain emission
rate IS used. ETH-revenue-share projections (separate from emission
APR) need indexer `revenueEpoch` aggregates; logged as a follow-up.
No new dependencies.

---

## P2-6 — Tooltips on every action button (foundation + top buttons) (2026-05-14)

New centralized copy library
[`frontend/src/lib/tooltips.ts`](frontend/src/lib/tooltips.ts) — typed
`TooltipKey` union covers 40+ action surfaces (swap, stake, restake,
revenue, launchpad mint/refund, NFT lending, NFT AMM, gauge vote,
bribes, grants, bounties, premium). Each entry is one sentence
following the brief's pattern: **what it does, what it costs, whether
it's reversible**. Applied via native `title=` to the highest-leverage
action buttons: TradePage swap/approve, StakingCard
claim/withdraw/earlyWithdraw/autoMaxLock/stake, FarmPage
restake/claimAll/unrestake, DashboardPage claim-rewards + claim-ETH,
CollectionDetailV2 mint (allowlist/dutch/public branches) + refund.
Native `title` chosen over a custom hover component because the
existing `InfoTooltip` "?" pattern is for inline definitions next to
labels — `title=` is the right primitive for "hover the button to see
its tx contract." Remaining buttons (lending offers, NFT AMM, gauge
vote, bounties, grants, bribes, premium) keep the existing UX and
their tooltip keys are already in the lib — incremental wiring is a
one-line-per-button diff. No contract changes. No new dependencies.

---

## P1-5 — Real top-N leaderboards (2026-05-14)

New cross-wallet rankings on LeaderboardPage sourced from the
indexer client built in P0-2. New
[`useLeaderboards`](frontend/src/hooks/useLeaderboards.ts) hook fans
out into a single GraphQL request for `stakingPositions`,
`gaugeVotes` (filtered to the chain's current epoch via
`GaugeController.currentEpoch()`), and `dropCollections` —
aggregates client-side per user, sorts, slices to top 100 / top 20 /
top 20. New
[`LeaderboardTables`](frontend/src/components/leaderboards/LeaderboardTables.tsx)
renders three tables (top stakers by boosted voting power, top voters
this epoch by power applied, top creators by drops launched) with
ENS resolution per row (`wagmi/useEnsName` with 24h staleTime) and
a tinted highlight + "You" ribbon on the connected wallet's row.
Component returns `null` when the indexer is unavailable so the
existing personal-stats card on LeaderboardPage stays the page's
sole content — silent fallback per the P0-2 policy. Two leaderboards
from the brief deferred and logged as B-6 in `FRONTEND_BLOCKERS.md`:
top LPs (needs a new `lpBalance` aggregate table) and top creators
by ETH raised (needs a contract change to add `MintPaid` event with
`msg.value`). No contract changes. No new dependencies.

---

## P1-4 — Removed localStorage limit orders / DCA (2026-05-14)

Default option (b) from the 30-day brief — pull the "Recurring Swap"
/ "Price Alert" tabs that triggered only while the user had the tab
open. `'dca'` and `'limit'` removed from `VALID_TABS` /
`TAB_LABELS` in [TradePage.tsx:18-34](frontend/src/pages/TradePage.tsx:18);
two corresponding render blocks deleted; stale `?tab=dca` / `?tab=limit`
URLs silently normalise to `?tab=swap` via a new `PAUSED_TABS` guard in
`resolveInitialTab` so old bookmarks don't 404. Dashboard alerts ("N
DCA swaps due", "N active price alerts") removed
([DashboardPage.tsx:300-329](frontend/src/pages/DashboardPage.tsx:300));
`useDCA` and `useLimitOrders` imports dropped from that page. Component
files (`DCATab.tsx`, `LimitOrderTab.tsx`) and hook files (`useDCA.ts`,
`useLimitOrders.ts`) stay on disk for the eventual rebuild — the
keeper-backed version of these features will reuse most of the UI
shells. New
[`docs/adr/001-keeper-choice.md`](docs/adr/001-keeper-choice.md)
(status: PROPOSED) compares Gelato vs Chainlink Automation vs
self-hosted bot vs leave-off, with a clear recommendation hook for
the operator who picks the path. `FRONTEND_BLOCKERS.md` gains entry
**B-5** linking to the ADR. No contract changes. No new dependencies.

---

## P0-3 — WebSockets instead of polling, foundation + top 5 hooks (2026-05-14)

WS transport added to wagmi (`viem.webSocket(VITE_WS_RPC_URL)`, default
`wss://ethereum-rpc.publicnode.com`) as the first entry in the existing
`fallback([...])` chain in [lib/wagmi.ts:13-36](frontend/src/lib/wagmi.ts:13).
viem auto-selects WS for subscriptions and HTTP for one-shot reads, so
existing read flows stay on HTTP — purely additive. New shared helper
`useBlockRefresh(refetch, { enabled })` in
[hooks/useBlockRefresh.ts](frontend/src/hooks/useBlockRefresh.ts) wraps
`useWatchBlockNumber` and fires `refetch()` on each new block, replacing
wagmi v1's dropped `watch: true` flag. Applied to the five highest-
leverage chain reads: `useUserPosition` (was 30s × 2 multicalls),
`useNFTDropV2` (60s × 12-call mint state), `useFarmStats` (60s × 2
reads), `useToweliPrice.getReserves` (60s — every swap moves these),
`useSwap` (ethBalance + fromToken/toToken balanceOf, all 30s polls
gone). Indexer-derived hooks get matching treatment via
`useIndexerBlockInvalidator` (new) in
[lib/indexer.ts:189-208](frontend/src/lib/indexer.ts:189) — invalidates
every `['indexer', ...]` React Query entry on each new block; mounted
once at [AppLayout:96](frontend/src/components/layout/AppLayout.tsx:96).
The 30s `staleTime` inside `useIndexerQuery` caps re-fetch frequency
during busy minutes. Chainlink ETH/USD price stays at 90s polling
(heartbeat update model — per-block subscription is wasteful), and the
TWAP consult stays at 60s (smooths over 30-min window regardless).
`VITE_WS_RPC_URL` documented in `.env.example`. No new dependencies.
26 polling sites unchanged for now; pattern is established for an
incremental sweep when needed.

---

## P0-2 — Wire Ponder indexer to frontend (2026-05-14)

New foundation: `frontend/src/lib/indexer.ts` exposes a tiny GraphQL
client (plain `fetch`, no new deps) with `useIndexerQuery` and
`useIndexerAvailability` React Query hooks. URL resolution checks
`import.meta.env.VITE_INDEXER_URL` first then falls through to the new
`/api/indexer` Vercel serverless proxy (`frontend/api/indexer.js`),
which reads `INDEXER_URL` server-side. Vite dev gets a matching proxy
that 503s cleanly when `INDEXER_URL` is unset, so the client cleanly
flips `isAvailable: false` and call-sites silently fall back to
existing RPC/Etherscan paths (the chosen UX). First wired surface:
`HistoryPage` gains an "indexer-augmented activity strip" above the
existing Etherscan tx-list, sourced via the new `useUserHistory` hook
that fans out across `stakingActions`, `revenueClaims`,
`restakingClaims`, `swaps`, `lpFarmActions`, and `bribeClaims` in a
single GraphQL request. Indexer schema gains `dropCollection` +
`dropMint` tables (P0-1 follow-up — will back-fill the moment V2
broadcasts) with `event.log.id` PKs per the `INDEXER-H2` audit
finding, and `ponder.config.ts` registers `TegridyLaunchpadV2`
(currently zero-addr no-op via `process.env`) plus a `factory()`
subscription to per-clone Transfer events. Repo root gains
`npm run indexer:dev` / `:serve` / `:codegen` shortcuts and
`DEVELOPING.md` documents the local wire-up. New
`FRONTEND_BLOCKERS.md` captures the four currently-known blockers
(indexer host, V2 launchpad broadcast, V2 Drop countdown timestamps,
Telegram bot delivery surface). No new frontend dependencies.

---

## P0-1 — Launchpad-first landing page (2026-05-14)

`/` now renders the new `LaunchpadHomePage`, a drop-discovery gallery
with Live / Upcoming / Recently Closed sections, one CTA per card
(Mint or View), ENS-resolved creator addresses, and an empty-state
hero that points creators to the launch wizard when no V2 drops exist
yet. The original marketing-style home is preserved verbatim — file
renamed `frontend/src/pages/HomePage.tsx` →
`frontend/src/pages/ClassicHomePage.tsx`, routed at `/classic`, and
linked from both the new home's footer and the "More → About" nav
section in `frontend/src/lib/navConfig.ts`. The `/launchpad` URL now
aliases `/` (was a redirect to `/nft-finance`) so anyone typing the
word "launchpad" lands on the gallery. New surfaces: `LaunchpadHomePage`,
`DropCard` (`frontend/src/components/launchpad/DropCard.tsx`), and
`useLaunchpadList` (`frontend/src/hooks/useLaunchpadList.ts`) — the
last fetches the most-recent 24 V2 collections in two multicalls and
categorises by `mintPhase` + `totalSupply` + `maxSupply` + `paused`.
No new dependencies; reuses `wagmi/useEnsName`, `framer-motion`, and
the existing `useNFTDropV2` URI resolvers. P0-2 will swap drop
discovery from per-visitor RPC reads to indexer queries; P0-3 will
replace the 60s `refetchInterval` with WS subscriptions on
`CollectionCreated`.
