# Fix Status — 2026-04-17 Session

Work landed this session in response to the 35-detective audit. See `AUDIT_FINDINGS.md` for
the full finding list and `REVENUE_ANALYSIS.md` for the greed-vs-generosity calibration.

## ✅ Done this session

### Contracts (need rebuild + redeploy to take effect)
- `contracts/src/TegridyLPFarming.sol` — added `exit()` convenience function so the
  frontend's existing `useLPFarming.exit()` call no longer reverts. Stake now auto-refreshes
  the caller's boost against the latest TegridyStaking NFT (JBAC holders no longer need a
  separate `refreshBoost` step).
- `contracts/src/TegridyNFTLending.sol` — added `GRACE_PERIOD = 1 hours` and gated
  `repayLoan` (`deadline + GRACE_PERIOD`) and `claimDefault` (`deadline + GRACE_PERIOD`) so
  NFT borrowers get the same safety buffer as ERC-20 borrowers.
- `contracts/src/TegridyDrop.sol` — added `MintPhase.CANCELLED`, `paidPerWallet` tracking,
  `cancelSale()` (irreversible, owner-only), `refund()` (pull-pattern, nonReentrant),
  events `SaleCancelledEvent` + `Refunded`. `withdraw()` blocked when CANCELLED;
  `setMintPhase()` cannot transition in OR out of CANCELLED.
- `contracts/script/DeployGaugeController.s.sol`,
  `contracts/script/DeployTokenURIReader.s.sol`,
  `contracts/script/DeployV3Features.s.sol`,
  `contracts/script/WireV2.s.sol` — replaced stale staking address
  `0x65D8...` with the new `0x6266...` (Gap A sed).

### Deleted dead code
- `contracts/src/LPFarming.sol` (was the duplicate non-boosted farm — `TegridyLPFarming` is
  the only one deployed).
- `contracts/script/DeployLPFarming.s.sol`, `contracts/test/LPFarming.t.sol` — orphaned
  after the above.
- `frontend/src/assets/hero.png`, `react.svg`, `vite.svg` — Vite starter leftovers.
- `frontend/src/components/PageTransition.tsx` — imported nowhere.
- Empty dirs: `frontend/src/components/characters/`, `frontend/src/components/dashboard/`,
  `frontend/src/assets/textures/`.

### Frontend fixes (hot-reloadable)
- `frontend/src/lib/constants.ts` — `TEGRIDY_STAKING_ADDRESS` swapped to new `0x6266...`.
  Dated comment explaining the C-01 migration. `TOWELI_TOTAL_SUPPLY` comment explains why
  the hardcode is safe.
- `frontend/src/pages/SecurityPage.tsx` — removed the inflated "5 Critical / 13 High / 26
  Medium / 38 Low — all resolved" block. Replaced with a neutral "read the audit files"
  card with three links.
- `frontend/src/pages/ChangelogPage.tsx` — softened "Fixed all v4 audit findings" →
  "Applied fixes for several v4 audit findings" with pointer to the audit file.
- `frontend/src/hooks/useLPFarming.ts` — added `chainId` guard + proactive allowance check
  in `stake()`; imports `CHAIN_ID`. (parseEther is correct for Uniswap V2 LP tokens; added
  comment explaining.)
- `frontend/src/hooks/useSwapQuote.ts` — wired `useChainId()` into the master `pairsEnabled`
  flag so quotes don't fire on non-mainnet (prevents silent garbage reads).
- `frontend/src/components/nftfinance/LendingSection.tsx`,
  `frontend/src/components/nftfinance/AMMSection.tsx` — converted `<a href="/security">` to
  `<Link to="/security">` so clicks stay in SPA routing.
- `frontend/src/pages/HistoryPage.tsx` — fetch cap raised from 50 → 500, added 25/row
  pagination with Prev/Next + page indicator, resets to page 0 when the wallet changes.

### Supabase migrations
- `frontend/supabase/migrations/002_native_orders_trades_push.sql` — creates the three
  tables referenced by API endpoints / RLS policies but never backed by a CREATE TABLE:
  `native_orders`, `trade_offers`, `push_subscriptions`. Also backfills explicit SELECT
  policies on `messages`, `user_profiles`, `user_favorites`, `user_watchlist`, `votes`.

### Env / docs
- `contracts/.env.example` — added `TEGRIDY_STAKING`, `TEGRIDY_LP`, `LP_TOKEN`.
- `frontend/.env.example` — added `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `ALLOWED_ORIGIN`.
- `REVENUE_ANALYSIS.md` — full fee-lever map, peer benchmarks, calibration recommendations,
  revenue-quick-win decision tree.

### What I did NOT touch per your instructions
- `.env` files — you said "private key is scrubbed, API keys whatever". Left as-is.
  They were never committed to git (verified via `git log --all --full-history`). Rotate
  at your pace.

## 🟡 Deferred / needs a focused second session

Each of these is non-trivial and was cut out of this session to avoid shipping half-done:

1. **Commit-reveal gauge voting UI** — contracts already have `commitVote` + `revealVote`,
   but `GaugeVoting.tsx` still calls legacy `vote()`. Need: regenerate ABIs, add 2-step UI
   (commit button → countdown → reveal button), pending-reveal dashboard row. The
   bribe-arbitrage vulnerability H-2 fixes is currently **not actually mitigated from the
   UI**.
2. **Launchpad admin UI** — `reveal()` button (contract supports it, no UI) + new
   `cancelSale` / `refund` flow built this session (contract patched, no UI yet). Also,
   the mock `mockMints[]` array in `launchpadShared.tsx:137-174` — replace with indexer
   data once #5 lands.
3. **Rewire ghost hooks into UI** — `useBribes`, `useReferralRewards`, `useAddLiquidity`
   are all feature-complete, just unimported. The existing `VoteIncentivesSection.tsx`
   reimplements bribe logic inline, so the cleanest path is refactor → use the hook.
   `useAddLiquidity` has a consumer shell in `TradePage` that uses a different inline
   implementation.
4. **Indexer expansion** — register `GaugeController` (not listed at all), add
   `EpochAdvanced` handler, add `MemeBountyBoard` submission/vote/dispute handlers, add
   `CommunityGrants` lapse/cancel/refund handlers. Fix `restaking_position` tombstone
   pattern (depositTime=0 on Unrestaked breaks "active positions" queries).
5. **Wire Leaderboard + History to Ponder** — currently Etherscan proxy. Indexer is orphan
   until the frontend actually queries it.
6. **Wire `TegridyTWAP.consult()` into `useToweliPrice`** — contract deployed at
   `0x1394A256...`, unused. Currently we rely on GeckoTerminal + Chainlink.
7. **`TegridyFeeHook` deploy** — requires CREATE2 salt-mining for the 0x0044 address
   prefix. Write a salt-mining script + integration into a V4 pool.
8. **Regenerate `frontend/src/generated.ts`** via `wagmi generate` so it includes the 8
   missing contracts (POLAccumulator, TegridyDrop, TegridyFeeHook, TegridyLPFarming,
   TegridyNFTPool, TegridyPair, TegridyTWAP, TegridyTokenURIReader) + the new Drop refund
   functions. Requires `forge build` first.
9. **Test backfill** — 29 hooks with no tests, 0/19 pages with E2E, one stub test
   (`RedTeam_POLPremium.t.sol` = `assertTrue(true)`). Whole day of work by itself.
10. **Silent `.catch(() => {})` in nakamigos components** — `MakeOfferModal.jsx:64,73`,
    `MyCollection.jsx:461,474`, `Listings.jsx:112`, `OnChainProfile.jsx:144`,
    `useToweliPrice.ts:75`. Low-risk mechanical fix.
11. **isPending guards** on `AMMSection.tsx:1223,1253,1717` and
    `NFTLendingSection.tsx:370`.

## 🔴 Needs YOU (not something I can do)

- Rotate the committed API keys + private key out of `.env` working files.
- After rebuilding contracts: `forge script DeployTegridyLPFarming` / redeploy
  `TegridyNFTLending` / redeploy `TegridyDrop` template. Update `constants.ts` with the
  new addresses. Current on-chain versions do **not** have the exit/grace/refund patches.
- Apply Supabase migration 002 in the SQL editor.
- Decide on the revenue calibration moves in `REVENUE_ANALYSIS.md` §4 — each one is a
  24–48 h timelock proposal and you need to pick the numbers.
