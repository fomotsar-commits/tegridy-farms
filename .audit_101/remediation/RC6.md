# RC6 — Recovery pass: re-apply reverted frontend patches

**Date:** 2026-04-26
**Verification:** `cd frontend && npx tsc --noEmit` → exit 0.

## Files re-patched

### Pages
- `frontend/src/pages/DashboardPage.tsx` (R047) — `nudgeKey = round(pendingTotal*100)` dep, `useChainId()` + `chainId: CHAIN_ID` + `enabled: chainId===CHAIN_ID` on `ETHRevenueClaim.useReadContract`, `useRef<Set<string>>` toast-fire gates keyed on tx hash for both staking-claim and ETH-claim toasts.
- `frontend/src/pages/TreasuryPage.tsx` (R070) — added `paused()` and `treasury()` reads, amber/red banners, `useBlockNumber({watch:true})` "as-of block" line, `oracleStale` purple banner, `SourceLink` component, chain-aware explorer URLs.
- `frontend/src/pages/HistoryPage.tsx` (R040) — zod `TxRecordSchema` (regex-validated `hash`/`to`/`value`/`timeStamp`); `parseTxRecords()` runs `safeParse` per record; cache + proxy-response paths both validated.
- `frontend/src/pages/AdminPage.tsx` (R069) — owner refetch 30s→10s, `refetchOwner()` forced before pause/unpause write, shared `<TypedConfirmation>` replaces inline typed-input flow.

### Components
- `TransactionReceipt.tsx` (R040) — `useWaitForTransactionReceipt({hash, confirmations:2})`, tri-state badge (pending/confirmed/failed), `getChainLabel(chainId)` from `lib/explorer.ts`, share-to-X gated (failed disabled / pending warns via alert modal with Wait/Share-anyway).
- `community/BountiesSection.tsx` + `community/GrantsSection.tsx` (R069+R053) — `isAllowedSubmissionUri` gates submission URIs (https/ipfs/ar only), `sanitizeUserText` on description writes, `<SafeText>` rendering, char-counter UI.
- `chart/PriceChart.tsx` (R072) — `useMemo` chart options on `[isDark]`, iframe sandbox tightened to drop `allow-same-origin`.
- `GalleryPage.tsx` + `ArtImg.tsx` + `ui/ArtLightbox.tsx` (R041+R072) — `safeUrl()` + `PLACEHOLDER_NFT`, width/height attrs + `decoding="async"` + `onError` fallback.
- `launchpad/CollectionDetailV2.tsx` (R071) — `external_link` via `resolveSafeUrl` allowlist; rejected schemes render inert label.
- `launchpad/OwnerAdminPanelV2.tsx` (R071) — Dutch invariants `useMemo` + inline `<p role="alert">`; `PHASE_LABELS.slice(0,4)` for grid.
- `launchpad/launchpadConstants.ts` — `PHASE_LABELS = ['Closed','Allowlist','Public','Dutch Auction','Cancelled']`.
- `PulseDot.tsx` — `useReducedMotion` gates pulse ring.
- `Sparkline.tsx` — single-pass min/max loop (no spread).
- `TowelieAssistant.tsx` — `consume(currentApiId.current)` before bubble overwrite.
- `PageSkeleton.tsx`, `PageSkeletons.tsx`, `ui/Skeleton.tsx` — `role="status" aria-busy aria-live` on every skeleton wrapper.
- `SeasonalEvent.tsx` — wallet-scoped dismiss key `tegridy-event-dismissed-${address ?? 'guest'}-${eventId}`.
- `ReferralWidget.tsx` — `usePublicClient().getCode()` EOA verification + warning before linking referrer.
- `layout/AppLayout.tsx` — wrong-network banner top respects `env(safe-area-inset-top)`. ConsentBanner already mounted.
- `layout/BottomNav.tsx` — `md:hidden`→`sm:hidden`, `safe-area-inset-bottom` padding, `min-w-[44px]` tap targets.
- `layout/TopNav.tsx` — `md:flex`→`sm:flex` / `md:hidden`→`sm:hidden` on primary nav, theme toggle, hamburger, drawer.
- `layout/Footer.tsx` — `min-h-[44px] flex items-center` on link rows.
- `ui/Modal.tsx` — `getFocusableDescendants` + Tab/Shift+Tab cycle, `previouslyFocusedRef` restoration, `dismissOnBackdrop?: boolean` prop.
- `ui/OnboardingModal.tsx` — refactored onto base `Modal` with `dismissOnBackdrop={false}`; 44px tap targets on Back/Next/CTA buttons.

### Lib helpers
- `lib/explorer.ts` — added `getChainLabel(chainId)` + expanded `EXPLORERS`/`CHAIN_LABELS` to cover OP Sepolia, Polygon Amoy, zkSync Era, Linea, Scroll, Mantle, Blast (matches existing `explorer.test.ts`).
- `lib/imageSafety.ts` — added `safeUrl()` thin alias of `resolveSafeUrl`.
- `lib/contracts.ts` — added `paused()` + `treasury()` view fns to `SWAP_FEE_ROUTER_ABI`.

## Constraints honoured
- No removed art / page sections (per `feedback_preserve_art.md`).
- No `.env` / secret leakage.
- No new top-level deps (`zod`, `framer-motion`, `viem` already in tree).
- All shared UI primitives (`<TypedConfirmation>`, `<SafeText>`, `<Modal>`) reused — no copies.
