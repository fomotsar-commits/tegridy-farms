# Frontend Changelog — 30-Day UX Push

One paragraph per shipped item. Newest first.

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
