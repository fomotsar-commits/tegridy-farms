# 101-Agent Forensic Audit — MASTER REPORT
**Date:** 2026-04-25  
**Methodology:** 101 specialized hacker agents, each with a narrow battle station, no overlap. AUDIT-ONLY (no code edits). Per-agent findings are in `.audit_101/NNN_*.md`. This file consolidates the global picture.

---

## TL;DR — TOP-25 BLEEDING WOUNDS (rough impact order)

| # | Severity | Where | One-liner | Agent |
|---|---|---|---|---|
| 1 | CRITICAL | `frontend/.env:3` | Real `VITE_ETHERSCAN_API_KEY` ships in client bundle (VITE_ prefix defeats the proxy that exists for this exact purpose) | 073 |
| 2 | CRITICAL | `App.tsx:115` + `vite.config.ts:14-67` | `/art-studio` route + dev save handler ship to prod; LAN/DNS-rebind attacker can rewrite `artOverrides.ts` | 052 |
| 3 | HIGH | `TegridyPair.sol:280-312` | `kLast=0` short-circuit silently forfeits ALL pre-feeOn swap fees; `harvest()` cannot recover | 001 |
| 4 | HIGH | `TegridyTWAP.sol` | Bootstrap deviation gap (count<2): observation #2 is admitted unguarded, attacker can poison baseline; reverse-direction unguarded | 013 |
| 5 | HIGH | `TegridyLending.sol:715` | `_positionETHValue` reads raw `getReserves()` spot — sandwich/flash-loan PROVEN to succeed by existing test `TegridyLending_ETHFloor.t.sol:211` | 006, 031, 032 |
| 6 | HIGH | `TegridyFeeHook.sol:189-249` | Exact-output swaps: fee credited against unspecified currency, V4 PoolManager applies the int128 to the OTHER currency → permanent currency-bucket drift | 004 |
| 7 | HIGH | `RevenueDistributor.sol` | (a) flash-deflation race lets attacker sweep up to 100% of an epoch; (b) restaker fallback can double-credit; (c) `executeForfeitReclaim` rug vector | 024 |
| 8 | HIGH | `CommunityGrants.sol:420 + 564` | `retryExecution`, `cancelProposal`, `lapseProposal` lack `whenNotPaused`; pause + cancel-all + emergencyRecoverETH = drain treasury | 019 |
| 9 | HIGH | `POLAccumulator.sol:238-307, 450-486` | `accumulate()` and `executeHarvestLP()` accept caller-supplied minOut bounded only by 5% floor (or NONE on harvest); ~5 ETH/call MEV at 100 ETH cap. Defense relies on Flashbots Protect off-chain | 021, 031 |
| 10 | HIGH | `TimelockAdmin.sol` | Pending-VALUE not bound into the timelock key; only the timer is locked. Highest-blast-radius example: RevenueDistributor `pendingSweepTo`. Plus `TegridyFactory.acceptFeeToSetter` writes `_executeAfter` directly, bypassing `_cancel`/event | 027 |
| 11 | HIGH | `TegridyNFTPool.sol` | (a) Rarity sniping: bonding curve keys on `numItems` but buyer picks `tokenIds` (Sudoswap V1 flaw); (b) `swapNFTsForETH` CEI violation; (c) `syncNFTs` rugpull surface | 008 |
| 12 | HIGH | `TegridyStaking.sol` | (a) `_claimUnsettledInternal` partial-payout breaks `totalUnsettledRewards == sum(...)` invariant — same residual flows into `rewardPerTokenStored` AND gets re-claimed; (b) cap-shortfall users permanently forfeit reward | 005 |
| 13 | HIGH | `TegridyLPFarming.sol` | Owner mid-period rate-cut + leftover-rounding drift from `totalRewardsFunded`; boost-mid-period via `refreshBoost`; FoT reward-token under-pay (asymmetric vs notify) | 010 |
| 14 | HIGH | `VoteIncentives.sol` | (a) `refundOrphanedBribe` permanently bricks bribes for zero-vote epochs (no admin recovery); (b) commit-reveal disabled by default → arbitrage; (c) ERC20 dust-deposit DoS (no per-token min set) | 017 |
| 15 | HIGH | `GaugeController.sol` | Mid-epoch `executeRemoveGauge` does NOT decrement `totalWeightByEpoch` → emissions under-distributed; commit-reveal grief via NFT transfer; commit-time lock-window check too lax | 018 |
| 16 | HIGH | `PremiumAccess.sol` | Extension branch keeps original `startedAt` → systematic refund under-pay on extend-then-cancel; `withdrawToTreasury` fund-lock for naturally-expired subs | 022 |
| 17 | HIGH | `TegridyDropV2.sol` | `setMerkleRoot` callable any time with no phase/pause/timelock — root rotation race; `_safeMint` CEI violation in mint loop | 011 |
| 18 | HIGH | `MemeBountyBoard.sol:442-461` | `emergencyForceCancel` lets owner refund creator 7 days post-deadline if votes < 2× quorum — owner-judge-override rug for low-engagement bounties | 020 |
| 19 | HIGH | `SwapFeeRouter.sol:1089-1155` | Triple FoT bug: legacy swap accounts on actualReceived but transfers amountAfterFee (double FoT haircut); convertTokenFeesToETHFoT zeroes full amount; withdrawTokenFees lacks on-hand reservation | 025 |
| 20 | HIGH | `TegridyRestaking.sol` | (a) `claimPendingUnsettled` doesn't subtract `totalUnforwardedBase`/`totalActivePrincipal` → cross-user drain; (b) bonus double-claim via auto-refresh; (c) `decayExpiredRestaker` accrues bonus before decay | 015 |
| 21 | HIGH | `TegridyRouter.sol` | `to == router` not blocked → tokens stuck (no sweep); `_validatePathNoCycles` only catches same-pair-twice (3-hop A→B→C→A drains ~0.9%); factory `emergencyDisablePair` mid-tx leaves user tokens skimmable from pair_1 | 002 |
| 22 | HIGH | `TegridyFactory.sol:346-374` | `setGuardian` has NO timelock; compromised feeToSetter installs hostile guardian in 1 tx, guardian instantly disables every pair via `emergencyDisablePair` | 003 |
| 23 | HIGH | Deploy scripts | feeToSetter never proposed to multisig; `envOr("MULTISIG", 0)` silently skips transferOwnership in 3 scripts; ConfigureFeePolicy queues 2 proposals against 1-slot pending queue (overwrites); DeploySwapFeeRouterV2 forgets ReferralSplitter rewiring | 037 |
| 24 | HIGH | `TegridyNFTLending.sol:237-244` | Constructor unconditionally writes 3 mainnet collection literals (JBAC, Nakamigos, GNSS) into `whitelistedCollections` with no codehash check — non-mainnet deploys auto-trust whatever lives at those slots | 038 |
| 25 | HIGH | `useNFTBoost.ts:23` + `useNFTDrop*.ts` + `useNFTLending` lending-page LTV | (a) JBAC mainnet boost leaks across chain switches (no chainId in queryKey); (b) divergent v1/v2 enum mapping silently triggers refund UI; (c) **LendingSection labels `position[0]` (TOWELI amount) as ETH and feeds it into `computeLTV` — every Borrow-tab risk number is wrong** | 049, 062 |

> Critical-class items (1–2) need **today**. Items 3–25 cluster into release-blockers vs runway items below.

---

## SEVERITY TOTALS BY DIVISION (84 of 101 reports in)

| Division | Agents | HIGH / CRITICAL | MEDIUM | LOW | INFO |
|---|---|---|---|---|---|
| Smart contracts core | 001-028 | 27 | 87 | 102 | 101 |
| Cross-cutting Solidity | 029-045 | 14 | 48 | 41 | 65 |
| Frontend pages | 046-060 | 23 | 54 | 50 | 36 |
| Frontend hooks/lib/components | 061-075 | 22 | 51 | 43 | 32 |
| API + auth + indexer + CI | 076-090 | 17 | 26 | 23 | 28 |
| Cross-cutting forensics | 091-101 | (in flight) | | | |
| **TOTALS (so far)** | **84** | **103+** | **266+** | **259+** | **262+** |

---

## CROSS-CUTTING PATTERNS (the systemic stuff)

### A. Owner-can-rug-during-pause
Multiple contracts have `whenNotPaused` on user actions but admin recovery functions are NOT `whenNotPaused` — owner can pause to lock users out, then drain.
- `TegridyNFTPool` — `withdrawETH/withdrawNFTs` no `whenPaused` modifier (HIGH, agent 044)
- `CommunityGrants` — `cancelProposal/lapseProposal/retryExecution` ungated → drain via emergency-recover (HIGH, agent 019)
- `RevenueDistributor` — claim double-gated by pause AND staking pause (HIGH, agent 044)

### B. Spot-reserve as oracle
Multiple contracts use raw `getReserves()` for pricing decisions:
- `TegridyLending._positionETHValue` (HIGH, agent 006/032 — exploit literally proven by existing test)
- `POLAccumulator.accumulate` slippage min derived from post-attack output (HIGH, agent 021/031)
- `useAddLiquidity` UI shows spot-reserve paired amount (MEDIUM, agent 064)
- **TegridyTWAP exists but has ZERO production consumers** (agent 032)

### C. Wave-0 deploy still partially incomplete
Per memory: VoteIncentives, V3Features, FeeHook-patch pending. Plus 3 contracts still on EOA pending multisig acceptOwnership. While that's true, the deployer EOA can rug (agent 043 blast-radius matrix).

### D. Decorative tests
- ~120 bare `vm.expectRevert()` — function bodies could be `revert();` and tests pass (agent 035)
- `MockUniRouter` returns 1:1 fixed output → MEV/sandwich/slippage assertions unreachable (agent 035)
- `Audit195_Restaking.t.sol.bak` shipped in tree
- Only **3 stateful invariants** in entire repo, all guarding `TegridyPair`; **21/25 contracts have ZERO invariants** (agent 036)
- `foundry.toml` has no `[fuzz]`/`[invariant]` profile → defaults to runs=256, depth=500, fail_on_revert=false (silent reverts pass)

### E. Frontend ↔ on-chain drift
- `LendingSection` displays "30% LTV" on positions actually 200%+ (HIGH, agent 049)
- `getRepaymentAmount` cached → repay reverts InsufficientPayment (HIGH, agent 049)
- TegridyScore page banner says "on-chain verified" but score weights/breakpoints/reductions all run in browser; same page line 185 admits "local and unverified" (HIGH, agent 054)
- `SecurityPage.tsx:10/14` — staking address points to deprecated v1 (paused), NFTLending address simply WRONG (HIGH, agent 055)
- `TermsPage §7` says "0.3% fee on all token swaps" — actual `SWAP_FEE_BPS=50` = 0.50% (HIGH, agent 055)
- `TokenomicsPage` pie chart 65/20/10/5 vs TOKENOMICS.md authoritative 30/10/10/5/45 (HIGH, agent 055)

### F. Missing event subscriptions
Indexer covers 9/24 contracts and 23/263 events. The DEX (`TegridyPair Swap/Mint/Burn`), entire `GaugeController`, `VoteIncentives` commit-reveal, and 13 `Paused/Unpaused` are all unindexed (agent 039 + agent 084).

### G. L2 readiness
- **No Chainlink sequencer-uptime gating anywhere**; TWAP, POL accumulate, lending grace (1h, shorter than typical sequencer outages), drop dutch-auction, bounty cancel all get hostile prices on resume (HIGH, agent 045)
- 22/25 timestamp-dependent contracts have NO L2 test coverage

### H. Type safety / responsive
- iPad mini 744px portrait below md=768px breakpoint → cramped phone BottomNav (HIGH, agent 074)
- 14 `100vh` uses, 0 `100dvh` (HIGH, iOS Safari URL-bar crop)
- `.nav-link` ~30px tall vs Apple HIG 44px minimum (HIGH)
- Page wrappers lack `overflow-x-hidden` → long addresses trigger horizontal scroll (HIGH)

### I. Approvals/allowance posture
**Exceptionally clean.** Zero `.approve()`, 16 `forceApprove()` all paired with reset-to-0, zero `permit(` sinks, zero `setApprovalForAll`, zero `type(uint256).max`. (agent 030 — passing grade)

### J. Signature replay surface
**Clean.** Only 4 contracts have signature surface (Toweli ERC20Permit, GaugeController commit-reveal, VoteIncentives commit-reveal, DropV2 Merkle). All bind chainid + contract address. Zero exploitable vectors. (agent 042 — passing grade)

### K. WETH library
Library trusts deploy-time WETH; `WETHFallbackLib` calls `IWETH(weth).deposit{value:...}()` on this immutable. Per agent 038: **14 contracts accept `_weth` with only `!= address(0)` check** — a malicious `IWETH` re-enters protocol contracts forever. SwapFeeRouter:268 derives WETH from `router.WETH()` — rogue router → rogue WETH → unrecoverable.

### L. Rate-limit / API hygiene
- Vercel `request.ip` not used; `XFF[0]` is attacker-controllable, all 20/min and 10/min throttles bypassable (HIGH, agent 077)
- `/api/v1/index.js` has NO real rate limit (cosmetic header only) (HIGH, agent 078)
- Alchemy key sits in path segment, Etherscan key in querystring → leak risk via observability (HIGH, agent 078)
- No body-size cap on supabase-proxy → 4.5 MB DoS surface (HIGH, agent 077)
- `eth_getLogs` unbounded block range → gzip-bomb OOM + Alchemy quota burn (HIGH, agent 078)

---

## EXPECTED-GOOD AREAS (positive findings to preserve)

- `Toweli.sol` — fixed-supply, no admin surface (agent 016)
- Approval/allowance posture (agent 030)
- Signature replay surface (agent 042)
- Gas griefing / unbounded loops — explicit caps everywhere (agent 041)
- `TimelockAdmin` is payload-free (no arbitrary call ABI confusion / self-transferOwnership / fund sweep)
- SIWE atomic nonce-claim, address lowercased, alg=["HS256"] pinned, all cookie flags correct (agent 076)
- `ParticleBackground` exemplary — pauses on tab hide, reduced-motion responsive (agent 070)
- Fee-on-transfer codebase mostly defensive; only 2 outliers in Staking + LPFarming.stake (agent 033)
- No webhook surface = nothing to forget (agent 083)
- CORS allowlists fail-closed in prod (agent 081)

---

## RELEASE-BLOCKER PRIORITIZATION

**P0 — TODAY (do not ship without):**
1. Pull `VITE_ETHERSCAN_API_KEY` out of `.env` (#1) — already-shipped key MUST be rotated
2. Gate `/art-studio` route + dev save handler behind `import.meta.env.DEV` (#2)
3. Wire TegridyTWAP into `TegridyLending._positionETHValue` (#5)
4. Add `whenNotPaused` to all admin recovery paths in CommunityGrants/RevenueDistributor/NFTPool (#7, #8)
5. **Indexer doesn't compile** — `ponder.config.ts:354` uses `chains` key, Ponder type expects `networks`, 102 cascading TS errors. Indexer ships broken (agent 096).
6. **Frontend lint fails: 127 errors, 35 warnings** — 25 real `react-hooks/rules-of-hooks` violations, 16 `set-state-in-effect` cascading-render bugs. Pre-commit script is broken so these slipped through (agent 096).
7. **Doc misrepresentation:** FAQ.md claims "10% burn/buyback" (no `burn()` exists) and "4-of-7 Gnosis Safe" (still single EOA). REVENUE_ANALYSIS.md cites a constant `SWAP_FEE_BPS = 50` that doesn't exist. SECURITY.md publishes Immunefi bounty tiers against a 404 page. README points to a deleted script `redeploy-patched-3.sh`. (agent 095)
8. **DeploySwapFeeRouterV2.s.sol:12-13** hardcodes wrong addresses for `REFERRAL_SPLITTER` and `PREMIUM_ACCESS` — re-running the script wires stale dependencies (agent 094).
9. **ABI drift — runtime revert in admin UI** (agent 093):
   - `totalPenaltiesRedistributed` is declared in `frontend/src/lib/contracts.ts:30` and `generated.ts:2100` with a wagmi hook that does NOT exist in `TegridyStaking.sol` source. The hook will revert when called.
   - `tegridyStakingAbi` exposes only 30 of 143 forge-artifact functions — the entire timelock/admin surface (`acceptOwnership`, `propose/execute*Change`, `requestEmergencyExit`, `pendingOwner`, `hasPendingProposal`) is unreachable from frontend.
   - `TegridyPair.harvest()` missing from all three frontend ABIs (source + artifact have it).
   - `TWAP_ABI` ships 8 of 24 functions despite header claiming auto-extraction.
   - Indexer drops `CommunityGrants.ProposalCreated(bytes32 key,...)` overload — TimelockAdmin proposal events silently un-indexed across Grants/Staking/Lending.
   - `frontend/src/generated.ts` (6661 LOC) has ZERO imports anywhere in frontend — fully dead code.
10. ~~ReferralSplitter `\\` vs `//` syntax flag~~ — **REFUTED by agents 096 + 101**. `forge build` runs clean; agent 039 over-reported. Not a blocker.

**P1 — THIS RELEASE:**
- TimelockAdmin pending-value binding (#10) — touches every importer
- Pair kLast pre-feeOn fee-leak (#3)
- POLAccumulator MEV protection (#9)
- Restaking cross-user drain + bonus double-claim (#20)
- LendingSection LTV mislabel + getRepaymentAmount staleness (#25)
- TegridyFactory `setGuardian` timelock (#22)
- Deploy script ownership-handoff fixes (#23)
- TWAP bootstrap deviation gap + reverse-direction guard (#4)
- VoteIncentives orphaned-bribe recovery + min-token setter (#14)

**P2 — NEXT RELEASE:**
- Full invariant suite (agent 036's missing 5 categories)
- L2 sequencer-uptime gating (agent 045)
- Indexer coverage gaps (agents 039 + 084)
- Static doc drift (agent 055): SecurityPage addresses, Terms swap fee, Tokenomics chart, FAQ lock-range
- Frontend type safety + chainId in every queryKey (multiple hooks)
- iOS responsive: `100dvh`, safe-area-inset, BottomNav clearance, .nav-link 44px

---

## NEXT STEPS

1. Per-finding remediation lives in the individual `.audit_101/NNN_*.md` files (file:line references included).
2. Per agent 100 cross-check: 20 cross-agent severity disagreements logged for adjudication; dominant pattern = MED↔HIGH on POLAccumulator/NFTPool/FeeHook (root cause is the same spot-reserves-as-oracle anti-pattern in pattern B above).
3. Per agent 101: full surface coverage achieved across 152 source files; no orphan modules.
4. Recommend triaging P0 immediately, scoping P1 into the next batch under the bulletproof mandate, and creating background follow-up tasks for P2.

— **End of master report — 101 agents, 100% coverage.**
