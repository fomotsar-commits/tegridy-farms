# Tegridy Farms — Parallel Detective Audit

35 detectives dispatched across frontend, contracts, indexer, API, deploy pipeline, env config, tests.

Findings grouped by severity.

---

## 🔴 BLOCKERS (ship-stopping)

### B1. Deploy pipeline: Gap A sed fix never applied
Four deploy scripts still point to the **old** staking address `0x65D8b87917c59a0B33009493fB236bCccF1Ea421`, not the new `0x626644523d34B84818df602c991B4a06789C4819`:
- `contracts/script/DeployGaugeController.s.sol:8`
- `contracts/script/DeployV3Features.s.sol:18`
- `contracts/script/DeployTokenURIReader.s.sol:8`
- `contracts/script/WireV2.s.sol:35`

Steps 3–7 of the runbook will revert. `DEPLOY_CHEAT_SHEET.md` marks this as "SELECTED: A1" but the sed was never executed.

### B2. Frontend `constants.ts` points to old staking contract
- `TEGRIDY_STAKING_ADDRESS` (constants.ts:5) → `0x65D8...` (stale)
- `TEGRIDY_RESTAKING_ADDRESS` (constants.ts:6) → `0xfba4...` but `DeployRemaining.s.sol:20` expects `0xfE2E...` (mismatch)
- `LP_FARMING_ADDRESS` (constants.ts:19) → `0xa5AB...` — not in any broadcast JSON (orphan)

App calls dead contracts. Users see stale data or revert on write.

### B3. TegridyLPFarming missing `exit()` — frontend will revert
`useLPFarming.ts:121-127` calls `exit()`, but `TegridyLPFarming.sol` has no such function (only `LPFarming.sol`, the dead duplicate, has it). **Frontend LP exit button is broken in production.**

### B4. Committed secrets
- `frontend/.env` and `contracts/.env` contain real API keys and a hardcoded `PRIVATE_KEY=0xc00d...`.
- **Rotate immediately.** Key exposure is immediate compromise risk.

### B5. Supabase API endpoints reference tables that don't exist
- `frontend/api/orderbook.js:42-79` INSERTs into `native_orders` — no `CREATE TABLE` migration exists; first call 500s.
- `supabase/migrations/001_siwe_auth_rls.sql:115,140` defines RLS policies for `trade_offers` and `push_subscriptions` — tables never created.

### B6. SecurityPage & Changelog lie about audit status
- `ChangelogPage.tsx:39` claims audit findings (C-02…M-04) are "Fixed", but `SECURITY_AUDIT_300_AGENT.md` still lists them as open blockers.
- `SecurityPage.tsx:126` claims "5 Critical, 13 High, 26 Medium, 38 Low — all resolved". Audit totals are actually 5/35/55/57. **Public-facing false security claims.**

### B7. TegridyFeeHook has no deploy script
`contracts/src/TegridyFeeHook.sol` exists, `DeployFinal.s.sol:18` comments "is NOT deployed here — requires CREATE2 salt mining." **No deploy script anywhere.** V4 fee hook is unreachable in production.

---

## 🟠 HIGH

### H1. Frontend blind to 8 contracts
`frontend/src/generated.ts` + `wagmi.config.ts` missing: POLAccumulator, TegridyDrop, TegridyFeeHook, **TegridyLPFarming** (see B3), TegridyNFTPool, TegridyPair, TegridyTWAP, TegridyTokenURIReader.

### H2. Commit-reveal gauge voting (H-2) not wired in UI
Contracts implement `commitVote` + `revealVote` correctly (detective #15). But the frontend `GaugeVoting.tsx:110-113` still calls the legacy one-step `vote()`, and `GAUGE_CONTROLLER_ABI` (contracts.ts:341-354) has no `commitVote`/`revealVote` entries.  
**The bribe-arbitrage vulnerability H-2 supposedly fixes is still exploitable from the frontend.**

### H3. TegridyNFTLending missing 1h grace period
- `TegridyLending.sol:92,425` has `GRACE_PERIOD = 1 hour`.
- `TegridyNFTLending.sol:361,416` has zero grace — borrower cannot repay past deadline; lender can claim NFT immediately.
- `LendingSection.tsx:1404-1458` UI advertises grace semantics to both. **NFT borrowers lose collateral earlier than UI implies.**

### H4. Indexer is orphan infrastructure
Frontend never queries Ponder (no `/api/proposal`, no GraphQL call anywhere). Indexer runs but nothing consumes it. Plus:
- `GaugeController` not registered in `ponder.config.ts` at all (blind spot).
- `EpochAdvanced` event in VoteIncentives has no handler.
- `MemeBountyBoard` submissions/votes/disputes not indexed.
- `CommunityGrants` lapse/cancel/refund events not handled.
- `restaking_position` table uses tombstones (depositTime=0 on Unrestaked) — breaks "active positions" queries.

### H5. DCA + LimitOrders require browser tab open
Both write onchain correctly, **but execution is a 15/30 s `setInterval` in the user's tab.** No keeper, no bot. Close the tab → orders never fire. UI disclosures exist but users will still miss executions.

### H6. PriceAlerts are localStorage-only
Notifications only fire while the tab is open; zero backend. It's a toy.

### H7. Frontend never calls `refreshBoost()` on TegridyLPFarming
Users who acquire JBAC NFTs don't get automatic boost recalc; stale boost until they manually restake.

### H8. `TegridyTWAP` deployed but never consulted
Frontend gets price from GeckoTerminal + Chainlink. The onchain TWAP oracle (`0x1394A256...`) is live but unused. Either wire it up or drop the contract.

### H9. `useLPFarming` uses `parseEther` for LP tokens
`useLPFarming.ts:91,100` hardcodes 18-decimal assumption. If LP token has different decimals, user stakes/approves the wrong amount.

### H10. Launchpad has no refund or reveal UI
- `TegridyDrop` has no `claim()` or refund — if a sale undersells, buyers can't recover funds.
- `TegridyDrop.reveal()` exists but no button in `OwnerAdminPanel.tsx` or `CollectionDetail.tsx`. Owners must call the contract directly.

### H11. Admin panel: live mint feed is 100% mock
`launchpadShared.tsx:137-174` renders `mockMints[]` hardcoded array.

---

## 🟡 MEDIUM

### M1. Ghost hooks — dead code
Never imported anywhere:
- `frontend/src/hooks/useBribes.ts`
- `frontend/src/hooks/useReferralRewards.ts`
- `frontend/src/hooks/useAddLiquidity.ts` ← note: TradePage has an AddLiquidity tab but uses different wiring
- `frontend/src/components/PageTransition.tsx`

### M2. Dead contract source
`contracts/src/LPFarming.sol` is the duplicate; `TegridyLPFarming` is the selected deployment. Delete or mark deprecated.

### M3. `components/dashboard/` and `components/characters/` folders exist but are empty.

### M4. Orphan Vite starter assets in `frontend/src/assets/`
`hero.png` (44 KB), `react.svg`, `vite.svg` — unused, from Vite template.

### M5. History page silently truncates at 50 tx (HistoryPage.tsx:156)
No pagination UI. Older transactions invisible.

### M6. Tokenomics total supply is hardcoded
`TOWELI_TOTAL_SUPPLY = 1_000_000_000` (constants.ts:62) — never read from token contract. OK only if supply is truly immutable.

### M7. ABI gaps in `generated.ts`
- `updateReferrer()` (ReferralSplitter) missing.
- `VoteIncentives`/`GaugeController` missing commit/reveal/sweep functions added in batch 21.
- `CommunityGrants` missing `executeProposal` / `cancelProposal` / `lapseProposal`.

### M8. Silent error swallowing
Multiple `.catch(() => {})` in `nakamigos/components/` (MakeOfferModal, MyCollection, Listings, OnChainProfile) and `useToweliPrice.ts:75`. Users see stale/empty data with no warning.

### M9. Loading states declared but never rendered
- `useAddLiquidity.ts:54` — `isLoadingPool`
- `NFTLendingSection.tsx:54` — `isLoadingPool`

### M10. Double-submit risk on LP/AMM operations
- `AMMSection.tsx:1223,1253` buttons only check `isConfirming`, not `isPending`.
- `NFTLendingSection.tsx:370` lend button clickable during signing.

### M11. Rate limiter fails open
`api/_lib/ratelimit.js:45-56` — if Upstash env vars missing, rate limiting silently disables. DoS vector during config outages.

### M12. RLS policies default-permit
Several Supabase tables have RLS enabled but no explicit SELECT policy — all rows publicly readable.

### M13. Missing env vars in `.env.example`
Deploy scripts reference `TEGRIDY_LP`, `TEGRIDY_STAKING`, `LP_TOKEN`. None documented. Next dev will silently deploy with empty address.

### M14. LP stake path has no proactive approval guard
`useLPFarming.stake()` lets users click without approval check; reverts after gas spent. Farm actions path has the guard — LP does not.

### M15. Two `<a href>` links should be `<Link to>`
`LendingSection.tsx:1734` and `AMMSection.tsx:1981` → `/security`. Causes full-page reload instead of SPA navigation.

### M16. No differentiated error handling for `UserRejectedRequestError` / `ConnectorNotFoundError`
User can't tell "wallet rejected" from "contract reverted". All errors go to the same toast.

---

## 🟢 LOW / NOISE

- Three skeleton files (`ui/Skeleton.tsx`, `PageSkeleton.tsx`, `PageSkeletons.tsx`) could be consolidated.
- `BigInt → Number` casts on `subscription[0]` timestamps in `usePremiumAccess.ts:59,64,69` — fine for realistic timestamps, not future-proof.
- `points` system has deprecated streak/daily-visit logic retained as dead code.
- `setFeeTo()` and other deprecated setters revert with helpful messages (good pattern, not a bug).
- Token list is hardcoded with no external refresh.
- `TegridyNFTLending` pausable policy differs from `TegridyLending` — intentional but undocumented.
- `RedTeam_POLPremium.t.sol` is a stub `assertTrue(true)` masquerading as coverage.
- **Test coverage is very thin**: 29 hooks untested, 0/19 pages have E2E.
- Two UI "Coming Soon" chips (`DashboardPage.tsx:244`, `launchpadShared.tsx:128`).

---

## ✅ Clean areas

- Swap quote + approve + slippage flow (detective #4).
- Home/Gallery/Lore pages (#1).
- Farm page & StakingCard (#3, minor LP approval guard aside).
- Dashboard page (#2).
- CommunityGrants / MemeBountyBoard / ReferralSplitter contracts (#16) — reentrancy-safe, CEI, timelocked.
- GaugeController / VoteIncentives / RevenueDistributor contracts (#15) — commit-reveal, snapshot, double-claim protection all correct onchain.
- SwapFeeRouter / POLAccumulator / TegridyTWAP (#17) — logic sound (except fee-hook is detached, B7/H8).
- TegridyRestaking + base/ + lib/ (#18) — no ghost code.
- TegridyFactory / Pair / Router (#11) — production-ready.
- NFT/Drop/Premium contracts (#14) — Merkle domain-separated, reentrancy-safe.
- Contexts, lib, App wiring (#24).
- Layout / nav / a11y / responsive (#25).
- Routing integrity (#30).

---

## Top-priority fix order

1. **Rotate committed secrets** (B4) — now.
2. Fix deploy scripts + frontend addresses (B1, B2) — before any further deploys.
3. Ship `exit()` on TegridyLPFarming OR change frontend to `withdraw()+getReward()` (B3).
4. Create missing Supabase tables (B5) or disable those endpoints.
5. Correct the false audit-status claims on SecurityPage & Changelog (B6).
6. Wire commit-reveal UI for gauges (H2).
7. Add 1h grace to TegridyNFTLending or UI warning (H3).
8. Decide: keeper for DCA/LimitOrders or rename to "manual" features (H5).
9. Regenerate wagmi ABIs to include missing contracts/functions (H1, M7).
10. Delete the dead `LPFarming.sol`, ghost hooks, orphan assets (M1–M4).
