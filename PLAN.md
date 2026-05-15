# 30-Day Frontend UX Push — Plan

Branch: `frontend/30-day-ux-push`. Each P-item gets a 3-bullet plan **before**
building. After it ships, a 1-paragraph summary lands in
`FRONTEND_CHANGELOG.md`. Anything blocked on contracts goes to
`FRONTEND_BLOCKERS.md`.

---

## P0-1 — Launchpad-first landing page

**Goal:** new visitors land on a gallery of drops (Live / Upcoming / Sold
Out), one CTA per card (Mint / View). Existing home content is demoted,
not deleted. The page works gracefully on day 0 when no V2 collections
exist yet.

**Constraints picked up from the codebase:**
- `TEGRIDY_LAUNCHPAD_V2_ADDRESS` is `0x000…` — V2 factory is **not
  deployed yet**. The wave-0 redeploy plan in `CONTRACTS.md` describes
  it as "Compiled + tests pass; broadcast pending." This is a real
  pre-condition for a live gallery but is out-of-scope per the
  no-contracts rule.
- V1 launchpad source was deleted 2026-04-19; V1 clones remain on
  Etherscan, readable via the V2 ABI (strict superset).
- Indexer (`indexer/`) tracks no Launchpad or Drop events today. P0-2
  will fix that — P0-1 must work **without** the indexer.
- Existing `LaunchpadSection` (used inside `LendingPage`) already lists
  V2 collections via factory reads — its discovery logic is reusable.
- Home page has rich art and 7 content sections (hero, core loop,
  protocol overview, how-it-works, trust badges, ecosystem, gallery,
  referral). Memory rule: never delete sections — demote, don't delete.

### The 3-bullet plan

- **Build the new launchpad gallery as a new `LaunchpadHomePage`
  component** (in `frontend/src/pages/`) routed at `/`. Sections: Live
  Drops (phase 1/2/3 with supply remaining), Upcoming (phase 0, future
  start), Recently Sold Out (last 30 days, `isSoldOut === true`). Each
  card renders art preview (from `contractURI` → Arweave), creator
  with ENS resolution, current price, supply remaining, countdown to
  next phase change, and a single CTA — "Mint" for live, "View" for
  upcoming/sold-out. Empty/zero-collections state is a first-class
  design ("First drop launching soon — be the creator who lights it
  up"). Reuses `useNFTDropV2` for per-drop reads and a new
  `useLaunchpadList` hook that wraps the V2 factory enumeration (plus a
  small bootstrap list of known V1 clone addresses, sourced from
  `frontend/api/etherscan.js` for now — swapped to indexer in P0-2).

- **Preserve all existing home content unmodified by renaming
  `HomePage.tsx` → `ClassicHomePage.tsx` and routing it at `/classic`**
  (also linked from the footer + "More" nav under "About"). No art is
  removed, no sections deleted, no copy rewritten. Add a small "Looking
  for the classic Tegridy intro? →" footer link on the new home so
  returning users can find the old page in one click.

- **Update routing + nav additively** in `App.tsx` and `lib/navConfig.ts`
  — `/` now renders `LaunchpadHomePage`, `/classic` renders
  `ClassicHomePage`, `/launchpad` (currently a redirect to
  `/nft-finance`) becomes an alias to `/`. The existing PRIMARY_NAV
  (Dashboard / Farm / Trade / NFT Finance) stays as is; this isn't a
  nav reshuffle, it's a swap of what `/` serves. ENS resolution uses
  `wagmi/useEnsName` with a 24-hour `staleTime` so we don't hammer
  RPC. Mobile breakpoint: iPhone 14+ portrait (390px) and iPad
  portrait (768px) both render the gallery as a clean grid — verified
  with the dev server before commit. No new dependencies; the page
  uses existing `framer-motion`, `react-router-dom`, `wagmi`, `viem`,
  and `ArtImg` primitives already in the bundle.

### Out of scope for P0-1 (logged for later)

- V2 factory deployment itself (contract / deploy script change) →
  `FRONTEND_BLOCKERS.md` if it actually blocks the gallery from
  populating at launch.
- ENS reverse-resolution caching beyond wagmi's defaults — revisit if
  RPC reads spike.
- Live mint count refresh via WebSockets — that's P0-3.
- Indexer-backed drop discovery — that's P0-2.

### Files I expect to touch

```
NEW   frontend/src/pages/LaunchpadHomePage.tsx
NEW   frontend/src/components/launchpad/DropCard.tsx
NEW   frontend/src/hooks/useLaunchpadList.ts
MOVE  frontend/src/pages/HomePage.tsx → frontend/src/pages/ClassicHomePage.tsx
EDIT  frontend/src/App.tsx              (route swap + /classic + /launchpad alias)
EDIT  frontend/src/lib/navConfig.ts     (footer/more entry for /classic)
NEW   PLAN.md                          (this file)
NEW   FRONTEND_CHANGELOG.md            (P0-1 entry, post-ship)
NEW   FRONTEND_BLOCKERS.md             (if V2 deploy is actually a blocker)
```

No `contracts/**` changes. No new dependencies.

---

## P0-2 — Wire the Ponder indexer to the frontend

**Goal:** the frontend stops reading from `/api/etherscan` and stops
polling raw chain state for things the indexer can serve. User
positions, history, and leaderboard data come from indexer queries.

**Constraints picked up from the codebase:**
- Indexer is fully built (`indexer/ponder.config.ts` + 32 schema
  tables) but **not yet deployed anywhere**. No `INDEXER_URL` in
  `.env.example`. Per the user note: "indexer in `indexer/` is
  currently orphaned." So the client needs to fail open when the
  indexer URL is unset — the app must keep working on day 0 with
  existing RPC/Etherscan paths.
- The indexer **does not** track Launchpad / Drop events today.
  Extending the schema is in scope per the user's brief. The V2
  factory is at the zero placeholder, so the new handler reads zero
  rows until V2 broadcasts; that's fine and additive.
- Frontend already proxies external services via `/api/*` Vercel
  serverless functions + Vite dev proxies. The indexer fits the same
  pattern.
- `API_INDEXER_AUDIT.md` flags `INDEXER-H1` (zero-address phantom
  rows) and `INDEXER-H2` (idempotency via `event.log.id` PK). New
  handlers must conform.

### The 3-bullet plan

- **Build the indexer client + proxy as the new foundation.** New
  `frontend/src/lib/indexer.ts` exports a tiny GraphQL `query()` (plain
  `fetch`, no new dep) and React Query hooks (`useIndexerQuery`,
  `useIndexerAvailability`). The URL resolves at runtime to either
  `import.meta.env.VITE_INDEXER_URL` (public) or `/api/indexer`
  (server-side proxy that holds the URL in `INDEXER_URL`). New
  `frontend/api/indexer.js` is the Vercel function; `vite.config.ts`
  gains a `/api/indexer` dev proxy. When neither is configured, hooks
  return `{ data: null, isAvailable: false }` so call-sites cleanly
  fall back to existing RPC/Etherscan reads. Document both env vars in
  `frontend/.env.example`.

- **Swap the three highest-value reads** from RPC/Etherscan to the
  indexer (behind the availability flag — RPC/Etherscan stays as
  fallback for as long as we want):
  - **HistoryPage** — replace the `/api/etherscan?action=txlist` call
    with a unified user-action query across `stakingAction`,
    `revenueClaim`, `restakingClaim`, `loan`, `loanOffer`, `swap`,
    `lpFarmAction`, `bribeClaim`, `voteIncentivesRefund`. Filter by
    `user = address`, sort `timestamp desc`, paginate.
  - **`useUserPosition`** — read staking + restaking position rows
    from `stakingPosition` and `restakingPosition` instead of N RPC
    multicalls per visitor.
  - **`useLaunchpadList`** — once V2 launches, swap factory
    enumeration for an indexer `dropCollection` query. The schema
    extension lands now so the handler back-fills the moment V2's
    `CollectionCreated` event lands.

- **Extend the indexer schema + handlers** for Launchpad and conform to
  the audit findings:
  - Add `dropCollection` table (one row per V2 clone) + `dropMint`
    table (one row per per-clone Transfer-from-zero) to
    `ponder.schema.ts`. Use `event.log.id` as PK on both
    (INDEXER-H2). Index on `creator`, `collection`, `minter`.
  - Add `TegridyLaunchpadV2` to `ponder.config.ts` (currently zero
    address; Ponder treats zero-address contracts as no-op subscribers
    until the address changes). The factory pattern uses Ponder's
    `factory()` helper to follow per-collection clones once
    `CollectionCreated` is observed.
  - Wire handlers in `indexer/src/index.ts` for
    `CollectionCreated` + each clone's `Transfer(from=0x0)`.
  - No zero-address user rows (INDEXER-H1) — use `tx.from` for the
    creator/minter where the event payload doesn't carry the user.
  - **Log the deployment requirement in `FRONTEND_BLOCKERS.md`** — the
    indexer must be hosted somewhere reachable; without that URL,
    every frontend swap stays on its RPC/Etherscan fallback. This
    isn't a contract change; it's a real ops dep that gates P0-2 from
    delivering real value at launch.

### Out of scope for P0-2 (logged for later)

- Real top-N leaderboards — that's P1-5 (will reuse this client).
- WebSocket subscriptions on indexer changes — that's P0-3 (the
  client lays the groundwork via React Query, which P0-3 swaps for
  WS-backed `useSubscription`).
- Indexer hosting — out of frontend scope; documented as a blocker.
- Authentication on the proxy — the indexer is public read-only, so
  no SIWE gate needed. CORS + per-IP rate limit reuses the existing
  Upstash setup from other `/api/*` functions.

### Files I expect to touch

```
NEW   frontend/src/lib/indexer.ts
NEW   frontend/api/indexer.js
EDIT  frontend/vite.config.ts            (dev proxy for /api/indexer)
EDIT  frontend/.env.example              (VITE_INDEXER_URL + INDEXER_URL)
EDIT  frontend/src/pages/HistoryPage.tsx (indexer-first, etherscan fallback)
EDIT  frontend/src/hooks/useUserPosition.ts (indexer-first, RPC fallback)
EDIT  indexer/ponder.schema.ts           (+ dropCollection, dropMint)
EDIT  indexer/ponder.config.ts           (+ TegridyLaunchpadV2 entry)
EDIT  indexer/src/index.ts               (+ launchpad handlers)
NEW   FRONTEND_BLOCKERS.md               (indexer deploy + V2 launchpad notes)
EDIT  FRONTEND_CHANGELOG.md              (P0-2 entry)
```

No `contracts/**` changes. No new dependencies in the frontend
package.

---

## P0-3 — WebSockets instead of polling

**Goal:** the frontend stops `setInterval`-style polling for chain
state. Real-time data flows from a WebSocket subscription where
possible; everything else gets refreshed on every new block via a
single block-watcher.

**Constraints picked up from the codebase:**
- `frontend/src/lib/wagmi.ts:13-20` configures HTTP transports only
  (`http(...)`-only `fallback([...])`). For wagmi's `watch: true` to
  actually subscribe instead of polling under the hood, the underlying
  viem client needs at least one `webSocket(url)` transport.
- 31 files use `refetchInterval` today (verified with `grep`). Sweep is
  mostly mechanical but real — each call-site needs `refetchInterval:
  60_000` → `watch: true` (or removal where `watch` doesn't apply).
- The Ponder indexer (P0-2) doesn't stably expose GraphQL
  subscriptions in 0.8.x. The pragmatic substitute is invalidating
  the React Query cache on every new block — Ponder typically lags
  chain by 1-2 blocks, and a 30s `staleTime` keeps re-fetch storms
  bounded.
- Off-chain HTTP polls (GeckoTerminal price, etc.) don't have a
  `watch` flag. They stay on time-based polling at sensible cadence.

### The 3-bullet plan

- **Add a WebSocket transport to the wagmi config.** In
  `frontend/src/lib/wagmi.ts`, prepend a `webSocket(url)` to the
  existing `fallback([...])` chain. URL resolves to
  `import.meta.env.VITE_WS_RPC_URL` with a public default
  (`wss://ethereum-rpc.publicnode.com`). Document the env var in
  `.env.example`. viem auto-selects WS for subscriptions and HTTP
  for one-shot reads, so this is purely additive — existing read
  flows stay on HTTP.

- **Sweep chain-read polling → `watch: true`.** Across all 31 files
  with `refetchInterval` on `useReadContract` / `useReadContracts`,
  replace `refetchInterval: 60_000` with `watch: true` (keeping
  `refetchOnWindowFocus: true` where it exists). Some hooks already
  poll at the right cadence by accident — those become per-block
  subscriptions instead, with viem's batching keeping the RPC cost
  flat. Off-chain `useQuery` polls (GeckoTerminal, etc.) stay on
  time-based intervals; the user's brief said "wagmi's `watch*` hooks
  where they map cleanly, otherwise subscribe directly to the
  indexer's WS endpoint" — for off-chain HTTP, neither fits, so they
  stay as-is.

- **Block-cadence cache invalidation for indexer queries.** New tiny
  hook `useIndexerBlockInvalidator` in
  `frontend/src/lib/indexer.ts`: subscribes to
  `useWatchBlockNumber({ emitOnBegin: true })` and calls
  `queryClient.invalidateQueries({ queryKey: ['indexer'] })` from the
  `onBlockNumber` callback. Mount once at `AppLayout` level so every
  `useIndexerQuery` consumer (today: `useUserHistory`; later: any
  P0-2 surface that lands) refreshes on the same heartbeat. The
  existing 30s `staleTime` inside indexer.ts caps re-fetch frequency
  even when blocks come fast.

### Out of scope for P0-3 (logged for later)

- True GraphQL subscriptions on the indexer. Ponder 0.8.x doesn't
  expose stable subscriptions; block-cadence invalidation gets us
  most of the way and is what large protocols use as the substitute.
- Per-event subscriptions via `useWatchContractEvent`. Useful for
  per-drop "MintEvent" pings on the launchpad gallery — P0-1
  follow-up, not P0-3.
- Off-chain HTTP polls (price feeds via GeckoTerminal). They stay on
  refetchInterval until / unless we move to a websocket price
  source.

### Files I expect to touch

```
EDIT  frontend/src/lib/wagmi.ts                       (webSocket transport)
EDIT  frontend/src/lib/indexer.ts                     (useIndexerBlockInvalidator)
EDIT  frontend/src/components/layout/AppLayout.tsx    (mount invalidator)
EDIT  frontend/.env.example                           (VITE_WS_RPC_URL)
SWEEP frontend/src/hooks/use*.ts                      (refetchInterval → watch)
SWEEP frontend/src/components/.../*.tsx               (inline hook sweep)
EDIT  FRONTEND_CHANGELOG.md                           (P0-3 entry)
```

No `contracts/**` changes. No new dependencies.

---

(P1-4 … P2-10 plans will be added here ahead of each item.)
