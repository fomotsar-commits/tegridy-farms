# Frontend Changelog — 30-Day UX Push

One paragraph per shipped item. Newest first.

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
