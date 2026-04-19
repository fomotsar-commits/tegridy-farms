# Launchpad V2 — Frontend Integration Notes

Short-form handoff for the session that flips V2 live. The frontend already
lists, fetches and mints V2 clones — it just needs the real factory address.

## Addresses to update after V2 deploy

Every address below is defined in `frontend/src/lib/constants.ts`. Update in
place (swap the literal, keep the `as const`) — no other grep-and-replace is
needed.

- `TEGRIDY_LAUNCHPAD_V2_ADDRESS`  
  Currently `0x0000000000000000000000000000000000000000` (placeholder). Swap
  to the broadcast address from `DeployLaunchpadV2.s.sol`. The frontend
  `isDeployed(...)` guard in `LaunchpadSection.tsx` and `useNFTDropV2.ts`
  flips everything live once this is non-zero — no other code change needed.

- `TEGRIDY_FEE_HOOK_ADDRESS`  
  Currently `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` (Arachnid CREATE2
  proxy owned — admin functions stranded). Update after the ownership-fixed
  redeploy so `pause` / `setFee` / `setDistributor` become callable from the
  admin UI.

## V2 UI surface (what's wired now)

- `frontend/src/hooks/useNFTDropV2.ts` — V2 clone reads + `mint` + `refund`,
  plus off-chain contractURI JSON fetch with 8s timeout and graceful fallback.
- `frontend/src/components/launchpad/CollectionDetailV2.tsx` — detail view;
  banner hero from contractURI, mint panel, owner-only `OwnerAdminPanelV2`.
- `frontend/src/components/nftfinance/LaunchpadSection.tsx` — lists V1 + V2
  collections together with a version chip, routes detail view by tag.

No V2-specific hardcoded addresses live outside `constants.ts`.

## Verification checklist post-deploy

1. `cd frontend && npx tsc --noEmit` — clean.
2. Load the NFT Finance page — V2 factory contract chip appears; deployed
   V2 collections render with the emerald `V2` tag.
3. Click a V2 collection — banner (if contractURI set), mint panel, owner
   admin panel (if connected as owner).
4. Mint on an allowlist-phase V2 clone — proof field renders, total cost
   previews, receipt toasts.
