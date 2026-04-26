# Detailed Findings — 101-Agent Forensic Audit
Date: 2026-04-25 · Mode: AUDIT-ONLY · Coverage: 100% (152 source files)

## Reading guide

This document consolidates every finding from the 101 individual agent reports in `.audit_101/NNN_*.md`. It is the long-form companion to `MASTER_REPORT.md` (executive view). Findings are presented per source agent in numerical order, then grouped by systemic patterns in Section 7. Severity nomenclature mirrors each agent's own (HIGH / MEDIUM / LOW / INFO). Where agents disagree on severity, both readings are recorded and noted in Section 8 (false-alarm refutation) or Section 7 (cross-agent reconciliation). Every file:line reference is preserved verbatim from the source agent so that grepping the master file recovers the original locator.

---

## Section 1 — Smart Contracts (agents 001-028)

### 001 — TegridyPair.sol
- Source: agent 001
- Counts: HIGH 3 / MED 7 / LOW 7 / INFO 3 / Test gaps 12
- HIGH:
  - **[H-1]** `harvest()` exits the `feeOn==false` branch with `kLast==0` but never resets path that re-enters `feeOn==true`, double-counting fees on next mint — TegridyPair.sol:280-286 + _mintFee :307-325. Pre-feeTo K growth silently captured by next mint as kLast = currentK; protocol never claims historical fee share.
  - **[H-2]** Reserves drift permanently when `IERC20.balanceOf` returns less than `postBalance` for non-FoT reasons (token pause, blocklist) — TegridyPair.sol:228-244. The FoT-output revert at :243-244 reverts AFTER `_update()` already wrote new reserves; cross-pair callback on ERC-777 hook can read post-update getReserves() while parent tx still reverts.
  - **[H-3]** `harvest()` lacks check for `disabledPairs` / `blockedTokens` — TegridyPair.sol:280-286. Once a pair is disabled, harvest keeps minting LP to feeTo based on prior K growth; LP is then ERC20-transferable out of the quarantine.
- MEDIUM:
  - **[M-1]** mint() reads disabled/blocked gates but burn() does not — TegridyPair.sol:101-102 vs :150-176; documentation drift only.
  - **[M-2]** `_mintFee` does not update `kLast` when liquidity==0 (rounding to 0); harvest griefing — TegridyPair.sol:280-286, :316-319.
  - **[M-3]** `_update()` writes `blockTimestampLast = uint32(block.timestamp)` but does NOT compute priceCumulative deltas — TegridyPair.sol:294-300; off-chain TWAP integrators get manipulable median.
  - **[M-4]** `skim(to)` permissionless, runs through `nonReentrant`, but does not check disabledPairs/blockedTokens — TegridyPair.sol:255-265.
  - **[M-5]** mint/burn use `IERC20(token0).balanceOf(this)` (line 114, 153); upgradeable token blacklisting pair bricks LPs.
  - **[M-6]** First-depositor inflation defense `rawLiquidity > MINIMUM_LIQUIDITY * 1000` (line 126) ineffective on 6-decimal tokens (USDC) — line 121, 126.
  - **[M-7]** `_mintFee` reads `factory.feeTo()` on every call — malicious feeToSetter can flip feeTo mid-flow via 48h timelock to capture historical K growth.
- LOW / INFO:
  - L-1 swap() line 200 `to != token0 && to != token1` after :192 to-validation; consolidate.
  - L-2 `_update()` uint112 cast redundant; `uint32(block.timestamp)` overflows in 2106.
  - L-3 MINIMUM_LIQUIDITY=1000 with imbalanced reserves: amount1 can round to 0, blocking burn forever.
  - L-4 `event Skim` :264 fires but Sync :299 fires from `_update`; reserves and balances diverge until next op.
  - L-5 `ITegridyFactory` interface (332-336) lacks feeToSetter/pendingFeeTo introspection.
  - L-6 swap() line 188 hard-bans flash swaps; `bytes calldata data` is dead weight in ABI.
  - L-7 harvest() emits no event :280; off-chain indexers cannot distinguish harvest-LP-mint from regular mint.
  - I-1 `_mintFee` formula numerator/denominator is battle-tested U-V2; sound.
  - I-2 `nonReentrant` on every external state-changing function.
  - I-3 Initialize event line 67 lacks factory address.

### 002 — TegridyRouter.sol
- Source: agent 002
- Counts: HIGH 0 / MED 3 / LOW 6 / INFO 5 / Test gaps 13
- MEDIUM:
  - **[M-1]** `to == address(this)` (router) is not blocked on any swap or removeLiquidity path — TegridyRouter.sol:164,181,199,232,249,269,299,316,337,137. Tokens deposited to router become permanently stuck.
  - **[M-2]** `swapExactTokensForTokens` does not enforce `path[0] != path[path.length-1]` — TegridyRouter.sol:161-177, 229-244. Indirect cycles via 3 distinct pairs silently work.
  - **[M-3]** `_pairFor` performs two STATICCALLs to factory per hop — gas griefing on long path swaps + governance race window — TegridyRouter.sol:452-456, 168, 174, 186, 192, 204, 208, 236, 241, 254, 259, 274, 280, 303, 305, 321, 325, 342, 344, 362, 374, 395, 408. Pair disabled mid-tx leaves user tokens skim-able.
- LOW:
  - L-1 swapExactETHForTokens does not refund excess ETH (TegridyRouter.sol:179-194).
  - L-2 MAX_DEADLINE = 2 hours may still be aggressive for L2 reorgs / cross-chain (line 40, 47-50).
  - L-3 `_getAmountIn` +1 rounding bias compounds N times across hops (475-482).
  - L-4 `removeLiquidity` (non-ETH variant) does not validate `to != address(0)` (115-130).
  - L-5 WETHFallbackLib 10000-gas stipend rejects most contract recipients (lib :46; used at 111, 156, 212, 263, 288, 350).
  - L-6 `getAmountsOut`/`getAmountsIn` allocate arrays before reverting on path>10 (356-378).
- INFO: I-1..I-5 nonReentrant correctness, FoT exact-output incompatibility documented, receive() restricted to WETH.

### 003 — TegridyFactory.sol
- Source: agent 003
- Counts: HIGH 1 / MED 4 / LOW 5 / INFO 6 / Test gaps 7
- HIGH:
  - **[H-01]** `setGuardian` is instant, no timelock; bypasses governance for instant-disable role — TegridyFactory.sol:346-351 interacting with 358-374. feeToSetter can install hostile guardian in one tx, halting every pool.
- MEDIUM:
  - **[M-01]** CREATE2 salt collides across chains (replay across L2s with same factory addr) — TegridyFactory.sol:113. Salt does not include `block.chainid` or `address(this)`.
  - **[M-02]** `_rejectERC777` ERC-1820 hashes computed every call and grow gas linearly — TegridyFactory.sol:249-265. Three external staticcalls + three keccak256 per createPair.
  - **[M-03]** Stealth ERC-777 bypasses `_rejectERC777`; INIT and createPair still succeed — 222-266. Documented but unblocked at runtime.
  - **[M-04]** `proposePairDisabled` accepts arbitrary addresses (no factory-membership check) — 306-313.
- LOW: L-01 createPair does not check getPair[token1][token0] separately; L-02 No public INIT_CODE_PAIR_HASH; L-03 proposeFeeToChange accepts current feeTo; L-04 token blocklist allows blocking address(0); L-05 cancelPairDisabled does not emit a typed event.
- INFO: I-01 allPairs unbounded; I-02 acceptFeeToSetter clears any pending feeTo change; I-03 token0/token1 ordering correct; I-04 zero-address checks present; I-05 EOA rejection via code.length>0; I-06 No reentrancy on createPair.

### 004 — TegridyFeeHook.sol
- Source: agent 004
- Counts: HIGH 2 / MED 4 / LOW 4 / INFO 4 / Test gaps 8
- HIGH:
  - **[H-1]** Fee credited to wrong currency on exact-output swaps (accounting drift vs PoolManager) — TegridyFeeHook.sol:189-244. `creditCurrency` formula correct only for exact-input; for exact-output flips meaning relative to amount0/amount1 signs.
  - **[H-2]** Hook-fee return value is `int128`, but PoolManager expects unspecified-currency delta with sign-convention mismatch on exact-output — TegridyFeeHook.sol:249. Either double-charges user or settlement underflows.
- MEDIUM:
  - **[M-1]** Reentrancy in `claimFees` is permissionless and pulls into `revenueDistributor` — 275-282.
  - **[M-2]** Permissionless `claimFees` enables griefing via dust claims (gas-DoS on accounting) — 275-282.
  - **[M-3]** `executeSyncAccruedFees` cooldown check uses `lastSyncExecuted[currency]` set AFTER state mutation — 300-312. First sync bypasses cooldown.
  - **[M-4]** `setFee` / `setRevenueDistributor` retained as `pure` revert stubs — 331-333, 353-355; bytecode/ABI bloat.
- LOW: L-1 minimum-fee floor leaks on tiny dust swaps (220-232); L-2 int128 overflow check repeated 4× (196,201,209,214); L-3 `sweepETH` unrate-limited (411-417); L-4 `feeBps==0` test gap (220).
- INFO: I-1..I-4 lifecycle hooks no-ops correctly, basis-points scale matches SwapFeeRouter, slot-7 mapping hard-coded in tests, no multi-hop double-charge in this contract alone.

### 005 — TegridyStaking.sol
- Source: agent 005
- Counts: HIGH 2 / MED 4 / LOW 5 / INFO 4 / Test gaps 5
- HIGH:
  - **[H-005-01]** `_accumulateRewards` rewardPerToken drift via `_reserved` shadow when `claimUnsettled` partially pays — TegridyStaking.sol:463-481, 1054-1072. Residual unsettled tokens silently double-credited.
  - **[H-005-02]** `_settleUnsettled` cap bypass leaks reward to active stakers, but `_getReward`'s rewardDebt advance still consumes user's stake — TegridyStaking.sol:941-985, 1431-1451. Affected user permanently transfers their already-earned reward to other stakers.
- MEDIUM:
  - **[M-005-01]** `notifyRewardAmount` allows whitelisted notifier to time fund-then-claim "windfall" within same block — 1199-1210.
  - **[M-005-02]** `votingPowerOf` skips expired positions but `aggregateActiveBoostBps` shares same logic — flash-stake-then-vote possible within MIN_LOCK_DURATION — 356-375, 397-414, 509-545, 705-722.
  - **[M-005-03]** `_decayIfExpired` writes a checkpoint but `getReward` doesn't, leaving stale voting power across reward claims — 311-317, 758-769.
  - **[M-005-04]** `earlyWithdraw` and `executeEmergencyExit` use `_clearPosition` which always sets `userTokenId[msg.sender] = 0`, even if caller owns multiple positions — 1419-1429, 727-754, 1142-1177.
- LOW: L-005-01 `extendLock` UX inconsistency (642-665); L-005-02 `_returnJbacIfDeposited` pre-transfer write 1372-1390; L-005-03 MAX_REWARD_RATE not capped on penalty recycle 149,1215-1228,1526-1530; L-005-04 `claimUnsettledFor` owner force-claim annoyance 1048-1052; L-005-05 default tokenURI returns "" 1465.
- INFO: I-005-01 votingPowerOf returns 0 for restakingContract; I-005-02 `_writeCheckpoint` skips push when power unchanged; I-005-03 `_safeInt256` overflow comment correct under MAX_REWARD_RATE; I-005-04 MAX_POSITIONS_PER_HOLDER=100 with ~260k worst-case gas.

### 006 — TegridyLending.sol
- Source: agent 006
- Counts: HIGH 3 / MED 6 / LOW 6 / INFO 6 / Test gaps 10
- HIGH:
  - **[H-006-1]** ETH-floor oracle uses raw spot reserves; flash-loan / sandwich manipulable — `_positionETHValue` L715-724, used in `acceptOffer` L429-432. Already proven by `test_sandwich_sameBlockManipulation_succeeds`.
  - **[H-006-2]** `repayLoan` callable while collateral source paused but borrower repays cash and gets nothing back — repayLoan L488-554, NFT return at L534. Silent coupling to TegridyStaking._update.
  - **[H-006-3]** `originationFee` collected before `acceptOffer`, opening free-money path for malicious lenders — createLoanOffer L327-375, originationFee L346-351; lender pays fee even when offer never accepted.
- MEDIUM:
  - **[M-006-1]** Interest rounding (Math.Rounding.Ceil) over-charges by 1 wei per bucket — L660-678. UX trap: `getRepaymentAmount` quote stale by 1s causes InsufficientRepayment revert.
  - **[M-006-2]** `claimDefaultedCollateral` is `whenNotPaused` while `repayLoan` is NOT — admin pause races with grace expiry can grief lenders — L560 vs L488.
  - **[M-006-3]** `proposeMinDuration` allows lowering minDuration to 1 hour (vs 2-hour security comment) — L860-866, MIN_DURATION_FLOOR L87.
  - **[M-006-4]** `_positionETHValue` reverts silently to 0 when toweliReserve==0 — L722.
  - **[M-006-5]** `lockEnd == 0` rejected, but lockEnd mutability creates same-block-acceptOffer-then-extendLock window — acceptOffer L438-439.
  - **[M-006-6]** `acceptOffer` performs `ITegridyStaking.getPosition` external call before CEI boundary — L422-431. Lender can supply malicious staking contract for self-rug fee farming.
- LOW: L-006-1 `getRepaymentAmount` view-mode interest stale (L683-688); L-006-2 `proposeProtocolFeeChange` accepts 0; L-006-3 `cancelOffer` not paused-gated (L379); L-006-4 `_positionETHValue` ignores `blockTimestampLast` (L716); L-006-5 No `loanCount`/`offerCount` upper bound; L-006-6 `proposeMinApr` can brick createLoanOffer if set above maxAprBps (L947-954).
- INFO: I-006-1 several threat-list items N/A (no liquidation engine, no health factor, no LTV, no Chainlink, no repay-on-behalf griefing); I-006-2 reentrancy posture sound; I-006-3 weth/pair/toweli immutable; I-006-4 MAX_PROTOCOL_FEE_BPS = 1000 hard-coded; I-006-5 leap-year drift sub-bps; I-006-6 pause/unpause owner-direct.

### 007 — TegridyNFTLending.sol
- Source: agent 007
- Counts: HIGH 0 / MED 0 / LOW 6 / INFO 12 / Test gaps 16
- HIGH/MED: All candidates downgraded after review (design choices documented & sound).
- LOW: L-1 `LoanTooRecent` check at line 423 yields free 1-block flash loan via NFT collateral; L-2 `cancelOffer` no `whenNotPaused` (line 312-326); L-3 Whitelist removal proposal can sit indefinitely until active loans clear; L-4 `proposeRemoveCollection` does not block new createOffer for the same collection during timelock; L-5 `getRepaymentAmount` callable for already-repaid loans (line 555-560); L-6 `isDefaulted` (line 563) inconsistent with `claimDefault` grace window (line 486).
- INFO: I-1 _ceilDiv safe by construction; I-2 WETHFallbackLib 10k stipend; I-3 No EIP-712 signed offers; I-4 No royalty payment logic; I-5 No partial liquidation; I-6 No onERC721Received handler; I-7 No ERC-1155; I-8 Offer.principal is effective; I-9 Initial whitelist hardcoded; I-10 MAX_PRINCIPAL=1000 ether caps single loan; I-11 nonReentrant + CEI; I-12 Pausable surface asymmetry intentional.

### 008 — TegridyNFTPool.sol
- Source: agent 008
- Counts: HIGH 3 / MED 6 / LOW 5 / INFO 4 / Test gaps 7
- HIGH:
  - **[H-1]** Rarity sniping via buyer-chosen tokenIds at uniform bonding-curve price — swapETHForNFTs L184-224. LP loses rare items at floor price.
  - **[H-2]** `swapNFTsForETH`: spotPrice updates BEFORE NFT transfers — L247-253. Cross-contract reentrancy via skim() while spot is committed before transfers complete.
  - **[H-3]** `syncNFTs` exploitable for "donation attack" replacement — L436-451. Owner reclaims NFT mistakenly transferred to pool.
- MEDIUM:
  - **[M-1]** Owner sandwich via timelocked spotPrice change is mitigated, BUT `pendingSpotPriceExecuteAfter` check on `proposeSpotPrice` is missing (L309-314).
  - **[M-2]** Sandwich on swapNFTsForETH: payout uses pre-update spotPrice but spotPrice update applies to all N items (L631 + L248). Combined fees can equal 100%.
  - **[M-3]** `_getSellPrice` view function reverts on insolvent pool (L647-650).
  - **[M-4]** `getSellQuote` math underflow potential when accumulatedProtocolFees > balance (L647-649).
  - **[M-5]** Owner can grief swappers via `pause()` (no factory override) — L455-457.
  - **[M-6]** `swapETHForNFTs` accepts duplicate tokenIds in calldata, charges for N but transfers fewer — L204-209.
- LOW: L-1 feeBps + protocolFeeBps can sum to 100% (L55-56); L-2 MAX_DELTA=10 ether comment inconsistency (L58-63); L-3 receive() naked but accumulatedFees deducts first; L-4 claimProtocolFees returns silently if 0; L-5 nftCollection not validated as ERC721 at init (L149, L164).
- INFO: I-1 No fungible LP shares; I-2 No lazy-mint surface; I-3 No bad randomness; I-4 No royalties.

### 009 — TegridyNFTPoolFactory.sol
- Source: agent 009
- Counts: HIGH 0 / MED 5 / LOW 8 / INFO 7 / Test gaps 15
- MEDIUM:
  - **[M-1]** Cross-chain salt collision via squatter — predictable salt — createPool() lines 144-147.
  - **[M-2]** Unbounded enumeration in `getBestBuyPool` / `getBestSellPool` — gas-DoS via pool spam — lines 232-287.
  - **[M-3]** `claimPoolFeesBatch` swallows all errors silently — observability gap; no membership check — lines 379-383.
  - **[M-4]** No collection contract-type check beyond `code.length > 0` — line 130; non-ERC721 contract acceptable.
  - **[M-5]** ETH initial-deposit forwarded via `.call` with full gas — reentrancy surface — lines 170-173.
- LOW: L-1 NFT initial-deposit loop has no allowlist of tokenIds length cap (176-181); L-2 `pool.call{value:msg.value}("")` doesn't pass an ABI selector (171); L-3 Constructor does not validate `_owner != address(0)` (87-92); L-4 MAX_PROTOCOL_FEE_BPS=1000 timelocked propose path allows fee==0 (30, 294); L-5 `_allPools.length` as salt component is gameable across reverting calls (145); L-6 No event on `withdrawProtocolFees` (389-393); L-7 `claimPoolFees`/`claimPoolFeesBatch` emit no factory-level event (373-383); L-8 MIN_DEPOSIT (0.01 ETH) magic number not constant (131).
- INFO: I-1 cloneDeterministic revert opaque; I-2 getAllPools returns full array unbounded; I-3 No de-duplication; I-4 Initial protocolFeeRecipient set without timelock; I-5 withdrawProtocolFees uses WETHFallbackLib; I-6 Pool implementation deploys inline; I-7 receive() accepts arbitrary ETH.

### 010 — TegridyLPFarming.sol
- Source: agent 010
- Counts: HIGH 3 / MED 7 / LOW 5 / INFO 11 / Test gaps 17
- HIGH:
  - **[H-1]** Boost manipulation via `aggregateActiveBoostBps` and ratio drift on `refreshBoost` — `_getEffectiveBalance` 204-221, `refreshBoost` 224-234. Stake low-boost LP, bolt on max boost late, retroactive amplification.
  - **[H-2]** `try/catch` fallback path in `_getEffectiveBalance` skips lock-end check via revert — 206-219. Asymmetric trust model: try branch relies on TegridyStaking honoring active-boost semantics; catch checks lockEnd.
  - **[H-3]** `notifyRewardAmount` leftover formula propagates rounding loss & enables owner front-run dilution — 386-410. Two vectors: rounding drift, owner rate-cut sandwiches user claims.
- MEDIUM:
  - **[M-1]** Reward token with transfer fee — partial mitigation only on funding (390-392, 319, 354).
  - **[M-2]** `forfeitedRewards` accounting drift if rewardToken supply changes (335-356, 362-377).
  - **[M-3]** `proposeRewardsDurationChange` requires `block.timestamp >= periodFinish` but executeRewardsDurationChange does not (418 vs 424-430).
  - **[M-4]** `recoverERC20` sends to current `treasury` — front-run during treasury timelock (462-467).
  - **[M-5]** `notifyRewardAmount` does NOT verify rewardToken == address(stakingToken) (144-145+391).
  - **[M-6]** Pause does not block `getReward` / `withdraw` / `emergencyWithdraw` (243).
  - **[M-7]** No mass-update; gas grief via mass-update N/A — INFO not finding (175-180).
- LOW: L-1 MAX_REWARD_RATE = 100e18 (line 60) ≈ 8.64M TOWELI/day; L-2 getRewardForDuration stale mid-period (473-475); L-3 BoostUpdated event silent on first-stake (254); L-4 userRewardPerTokenPaid set after emergencyWithdraw rewards=0 (346-347); L-5 reclaimForfeitedRewards reads rewardToken.balanceOf with rebase risk (369).
- INFO: 11 informational items including MAX_BOOST_BPS_CEILING immutable, math overflow safety, OwnableNoRenounce, period-end overflow, claim DoS via emergencyWithdraw.

### 011 — TegridyDropV2.sol
- Source: agent 011
- Counts: HIGH 1 / MED 3 / LOW 4 / INFO 4
- HIGH:
  - **[H-01]** Merkle root rotation race against in-flight allowlist claimers — setMerkleRoot() L346-349 + mint() ALLOWLIST branch L285-297. Front-run pending allowlist mint txs by rotating root mid-block.
- MEDIUM:
  - **[M-01]** `maxPerWallet` bypass via fresh address per drop (sybil) is unmitigated (L277-279, L114).
  - **[M-02]** `_safeMint` invokes `onERC721Received` BEFORE state updates (L300-303). Cross-function reentrancy surface to other contracts that read this drop's state.
  - **[M-03]** `pause()` does NOT block `withdraw()` or `cancelSale()` — only `mint()` — L418, L448.
- LOW: L-01 setMintPrice(0) when CLOSED grief (L351-355); L-02 dutchStartPrice <= dutchEndPrice validated but dutchStartPrice == dutchEndPrice means flat price labeled "auction" (L388, L210); L-03 tokenURI returns empty when revealed && _revealURI == "" (L239-247); L-04 No OwnershipTransferred event (L467-470, L472-476).
- INFO: I-01 hunt-checklist verification table (mostly mitigated except H-01 and M-01); I-02 Allowlist proof param ignored in PUBLIC phase (L264, L285); I-03 currentPrice() returns mintPrice for CLOSED/CANCELLED (L314-319, L321-328); I-04 No mint deadline / sale-end timestamp.

### 012 — TegridyLaunchpadV2.sol
- Source: agent 012
- Counts: HIGH 0 / MED 3 / LOW 5 / INFO 6 / Test gaps 10
- MEDIUM:
  - **[M1]** `dropTemplate` clone implementation is uninitialized but never locked, so anyone can call `initialize()` directly on the template — L115. Depends on `TegridyDropV2._disableInitializers()` in its constructor.
  - **[M2]** Fee-change timelock has no upper bound on `pendingProtocolFeeBps` storage time (L202-222). Stale proposals persist indefinitely.
  - **[M3]** `cancelProtocolFeeRecipient` does not emit an event (L239-242). Off-chain dashboards see "pending recipient" while in reality wiped on-chain.
- LOW: L1 MAX_PROTOCOL_FEE_BPS=1000 (10%) (L56); L2 getCollection reverts but auto-mapping getter returns default zero struct for OOB (L77 vs L188); L3 Fee-change requires `newFeeBps != protocolFeeBps`, but recipient proposal does NOT (L224); L4 getAllCollections returns entire array unbounded (L197-199); L5 pause() blocks createCollection but not fee proposals/executions (L244-245 vs L201-242).
- INFO: I1 Slither encode-packed fix dated 2026-04-19 verified (L134); I2 weth immutable but unused post-construction; I3 Constructor relies on OwnableNoRenounce for zero-owner check; I4 CollectionInfo.id redundant; I5 Salt includes allCollections.length; I6 Two events emitted for one logical action.

### 013 — TegridyTWAP.sol
- Source: agent 013
- Counts: HIGH 3 / MED 5 / LOW 4 / INFO 3 / Test gaps 10
- HIGH:
  - **[H-1]** Deviation guard reads CUMULATIVE-derived prevSpot but compares to SPOT — first 2 observations have zero deviation gate — update() lines 164-188. Bootstrap window poisonable.
  - **[H-2]** `prevSpot0` reconstructed only from `price0` cumulatives — `price1`-direction deviation is unguarded — lines 176-184.
  - **[H-3]** Staleness check uses raw `block.timestamp - latest.timestamp` (uint32-truncated) — wrap-around at year 2106 produces negative diff that underflows revert and serves stale prices as fresh — line 318.
- MEDIUM:
  - **[M-1]** Observation buffer overwrite during `_getCumulativePricesOverPeriod` search; only freshness signal is `obs.timestamp == 0` — lines 325-341.
  - **[M-2]** `_getCumulativePricesOverPeriod` falls back to `oldestIdx` of `0` when count < MAX_OBSERVATIONS — lines 343-352. Self-bricking on dormant pair revival.
  - **[M-3]** `update()` accepts msg.value == 0 path; cosmetic require-string mismatch (lines 119-131).
  - **[M-4]** `setUpdateFee` allows owner to front-run an `update()` raising fee from 0 to MAX_UPDATE_FEE in same block, griefing legitimate updaters (lines 278-283).
  - **[M-5]** Refund path uses raw `.call{value:excess}` to msg.sender with no reentrancy guard; state inconsistency on reentrancy — buffer poisoning.
- LOW: L-1 MAX_OBSERVATIONS=48 × MIN_PERIOD=15min mismatch with MAX_STALENESS=2h (8 unreachable buffer slots); L-2 withdrawFees() callable by anyone, locked if feeRecipient reverts; L-3 Observation.timestamp uint32; L-4 getObservationCount returns min(count,MAX), but auto-getter unbounded.
- INFO: I-1 Unchecked accumulation matches U-V2; I-2 MAX_DEVIATION_BPS=5000 (50%) generous; I-3 Abstract TWAPAdmin organizational only.

### 014 — TegridyTokenURIReader.sol
- Source: agent 014
- Counts: HIGH 0 / MED 2 / LOW 4 / INFO 5 / Test gaps 10
- MEDIUM:
  - **[MEDIUM-1]** `tokenURI()` is unbounded view; ~7-10kB output may exceed cross-contract gas limit if any on-chain consumer ever calls it — L41-52, _buildSVG L86-110, _buildSVGBody L112-137, _buildJSON L139-157.
  - **[MEDIUM-2]** Reader does not verify token existence; renders synthetic zeros for any tokenId — L41-52 + staking.positions(tokenId) returns zero-struct on missing. EIP-721 spec violation (MUST throw).
- LOW: LOW-1 _formatAmount truncates to 2 decimals (L54-60); LOW-2 test-side Base64Dec returns 0 for non-base64 (L278-286); LOW-3 _lockStatus shows "0h left" when remaining<1h (L75-84); LOW-4 lockDuration/86400 integer-truncation (L151).
- INFO: I-1 SVG ~1.5kB unencoded XSS-safe by typed inputs; I-2 JSON-injection closed; I-3 Reader decoupled from staking ownership/transfer; I-4 block.timestamp non-deterministic across calls; I-5 Constructor accepts address(0) for staking.

### 015 — TegridyRestaking.sol
- Source: agent 015
- Counts: HIGH 3 / MED 7 / LOW 8 / INFO 7 / Test gaps 10
- HIGH:
  - **[H-1]** `claimPendingUnsettled` does not reserve `unforwardedBaseRewards` of OTHER users (cross-user fund drain) — TegridyRestaking.sol:603-621. `available` is raw balance; does not subtract `totalUnforwardedBase` or `totalActivePrincipal`.
  - **[H-2]** Double-claim of bonus across `claimAll` auto-refresh + main bonus block (rounding-favored to user) — lines 370-467.
  - **[H-3]** `decayExpiredRestaker` accrues bonus against stale `totalRestaked` AFTER `_accrueBonus()` is called, but the comment says it does the opposite — lines 1077-1118. Inflated period extends until decayExpiredRestaker called (no incentive).
- MEDIUM:
  - **[M-1]** `recoverStuckPrincipal` does NOT include `totalRecoveredPrincipal` in reserved math (double-counting) — lines 681-741.
  - **[M-2]** `unrestake`'s shortfall handling can leave principal stuck in `pendingUnsettledRewards` — lines 564-583.
  - **[M-3]** `revalidateBoostFor*` does NOT call `_accrueBonus` before `staking.revalidateBoost(tokenId)` (reward double-claim across boost change) — lines 958-1051.
  - **[M-4]** `emergencyForceReturn` does NOT clear `pendingUnsettledRewards` and uses inline accrual that bypasses `_accrueBonus` consistency — lines 873-944.
  - **[M-5]** `restake()` does NOT verify the NFT's underlying staking position is OWNER==MSG.SENDER at the staking contract level — line 293.
  - **[M-6]** `boostedAmountAt` uses CURRENT `boostedAmount` for ALL past timestamps (subtle over-credit on RevenueDistributor) — lines 278-283.
  - **[M-7]** `cancelAttributeStuckRewards` does NOT verify that `pendingAttribution` is currently set — lines 776-781.
- LOW: L-1 restake() does not validate _tokenId != 0 sentinel collision; L-2 fundBonus permissionless; L-3 emergencyWithdrawNFT callable while not paused; L-4 rescueNFT cannot rescue NFT that was emergency-stuck for the right user; L-5 proposeAttributeStuckRewards does not check _amount<=unattributed at propose time; L-6 decayExpiredRestaker uses revert string not custom error; L-7 BONUS_RATE_TIMELOCK declared after state vars; L-8 pendingBonus view uses unguarded bonusRewardToken.balanceOf.
- INFO: I-1 Storage slot packing suboptimal; I-2 _safeInt256 duplicated vs OZ SafeCast; I-3 BonusShortfall event spam-edge; I-4 lastForceReturnTime cooldown per-contract not per-tokenId; I-5 totalActivePrincipal not decremented in emergencyForceReturn (borderline MEDIUM); I-6 Reentrancy modifier on every state-mutator; I-7 No oracle dependency.

### 016 — Toweli.sol
- Source: agent 016
- Counts: HIGH 0 / MED 0 / LOW 2 / INFO 6 / Test gaps 4
- LOW:
  - **L-01** Permit DOMAIN_SEPARATOR rebuilt on chainid change but no EIP-5267 / explicit cross-chain replay test — Toweli.sol:27 (inherits ERC20Permit).
  - **L-02** Recipient unchecked beyond non-zero (Toweli.sol:35-41).
- INFO: 6 informational items confirming fixed-supply / no-admin design, decimals immutable, ERC-20 return-value compliance, no snapshot/voting layer, TOTAL_SUPPLY uses ether literal, no fee-whitelist drift.

### 017 — VoteIncentives.sol
- Source: agent 017
- Counts: HIGH 3 / MED 4 / LOW 4 / INFO 5
- HIGH:
  - **[H-017-1]** Snapshotted epochs with zero gauge votes permanently lock all deposited bribes — claimBribes L507-588, refundOrphanedBribe L879-901.
  - **[H-017-2]** Legacy `vote()` epochs fully expose see-bribes-then-vote arbitrage — L371-395.
  - **[H-017-3]** Token-list slot DoS: 20× 1-wei ERC20 deposits brick MAX_BRIBE_TOKENS for a pair-epoch — depositBribe L404-456, MIN_BRIBE_AMOUNT L80, minBribeAmounts L223.
- MEDIUM:
  - **[M-017-1]** `epochBribes`/`bribeDeposits` mismatch on partial refund leaves ghost slots (L879-901).
  - **[M-017-2]** `refundOrphanedBribe` does not refund the 3% fee already paid to treasury (L424-430, L468-474, L879-901).
  - **[M-017-3]** `currentEpoch()` / deposit-into-future-epoch race vs `advanceEpoch` (L354-356, L433, L325-351).
  - **[M-017-4]** `vote()`/`revealVote` cap-exceed uses `require` string, missing custom error & `EXCEEDS_POWER` not in errors block (L388, L1103).
- LOW: L-017-1 Dead state `epochBribeFirstDeposit` (L197); L-017-2 enableCommitReveal() deprecated stub view (L1192-1194); L-017-3 sweepExcessETH/sweepToken don't validate treasury!=0 at sweep time (L925-949); L-017-4 commitVote accepts arbitrary commitHash including bytes32(0) (L1035-1063).
- INFO: I-017-1 setMinBribe setter for minBribeAmounts is missing (mapping declared L223 read L418-421 but never written); I-017-2 MIN_DISTRIBUTE_STAKE=1000e18 blocks bootstrap; I-017-3 MAX_CLAIM_EPOCHS=500 and MAX_BATCH_ITERATIONS=200 interaction; I-017-4 commitDeadline/revealDeadline 1-second no-action zone; I-017-5 accumulatedTreasuryETH untouched on refundOrphanedBribe.

### 018 — GaugeController.sol
- Source: agent 018
- Counts: HIGH 1 / MED 4 / LOW 5 / INFO 5 / Test gaps 11
- HIGH:
  - **[H-1]** Owner can rug active votes via `executeRemoveGauge` mid-epoch — gauge removed mid-epoch dilutes denominator — L486-503.
- MEDIUM:
  - **[M-1]** Commit-reveal griefing — committer never reveals, NFT-owner cannot vote that epoch; mid-epoch transfer locks new owner out (L303-327).
  - **[M-2]** `commitVote` lock-end check insufficient — lock can expire before reveal window (L320-321, L366-367).
  - **[M-3]** Voting power snapshot reads pre-genesis returns 0; epoch-0 brittle (L222).
  - **[M-4]** Epoch-start snapshot does NOT prevent flash-stake/vote/unstake when staker has prior checkpoint (L220-223).
  - **[M-5]** No sanity cap on per-gauge weight or `totalWeightByEpoch` (L69, 242-243, 388-389).
- LOW: L-1 getRelativeWeightAt allows future-epoch (L431-435); L-2 cancelAddGauge clears pending pointers AFTER `_cancel` (L474-477); L-3 MAX_TOTAL_GAUGES=50 swap-and-pop OK (L39-40, 493-498); L-4 `votingPowerOf` per-EOA but `hasUserVotedInEpoch` keyed by msg.sender — multi-EOA Sybil possible (L206, 237); L-5 commitmentOf/committerOf not cleared on commit-then-no-reveal (L323-324).
- INFO: I-1..I-5 MAX_GAUGES_PER_VOTER=8, MAX_TOTAL_GAUGES=50; pause() does not pause execute paths; getTokenVotes returns last-vote regardless of epoch; commit-reveal hash binds chainid+address(this); currentEpoch() underflow if block.timestamp<genesisEpoch impossible.

### 019 — CommunityGrants.sol
- Source: agent 019
- Counts: HIGH 3 / MED 7 / LOW 7 / INFO 3 / Test gaps 15
- HIGH:
  - **[H-1]** `retryExecution` releases ETH while contract is paused — pause modifier missing — CommunityGrants.sol:420-461.
  - **[H-2]** `cancelProposal` while paused → owner rug via emergencyRecoverETH — CommunityGrants.sol:468-508 + 565-575.
  - **[H-3]** Lapse + cancel during pause sidestep emergencyRecoverETH invariant — lapseProposal L513-550 and cancelProposal L468-508.
- MEDIUM:
  - **[M-1]** `createProposal` is not `nonReentrant` and external token call precedes state writes — L195-263.
  - **[M-2]** `proposeFeeReceiver` not paused-gated; combined with timelock allows rug to attacker treasury during pause — L581-588.
  - **[M-3]** `_transferETHOrWETH` partial-state on WETH-fallback failure — L651-674.
  - **[M-4]** `voteOnProposal` deadline check uses `>` allowing exactly-at-deadline votes; finalize uses `<=` — L276 vs L321.
  - **[M-5]** `proposalUniqueVoters` not decremented on cancel/lapse — accounting drift (L302).
  - **[M-6]** `cancelProposal` of Active by proposer does NOT release `totalApprovedPending` but order can underflow `totalRefundableDeposits` (L490-491).
  - **[M-7]** Owner can sandwich a proposal between pause↔unpause and rush execute — `executeProposal:378`.
- LOW: L-1 sweepFees lacks whenNotPaused; L-2 _transferETHOrWETH 10k stipend incompatibilities; L-3 MAX_ACTIVE_PROPOSALS=50 cap with FailedExecution slot stuck; L-4 proposeFeeReceiver does not zero-check; L-5 No event on lapseProposal blacklist redirect; L-6 getProposal does not return proposerTokenId; L-7 MIN_UNIQUE_VOTERS=3 not enforced at execute.
- INFO: I-1 Hunt items found CLEAN; I-2 Recommended hardening; I-3 ProposerMissingStakingPointer validation only at creation.

### 020 — MemeBountyBoard.sol
- Source: agent 020
- Counts: HIGH 1 / MED 7 / LOW 8 / INFO 8 / Test gaps 10
- HIGH:
  - **[H-02]** `emergencyForceCancel` rug after legit submitters work, before quorum reached — L442-461.
- MEDIUM (selected):
  - **[M-01]** Snapshot lookback bypass for fresh stakers (L219-223).
  - **[M-02]** Creator front-runs honest artist's submitWork with cancelBounty (promoted from H-03).
  - **[M-03]** Vote-count overflow / griefing via stake-weighted accumulation (L284).
  - **[M-04]** refundStaleBounty and emergencyForceCancel bypass when totalBountyVotes >= 2*MIN_COMPLETION_VOTES but no single submission reaches quorum (L398-417, L442-461).
  - **[M-05]** refundStaleBounty permissionless griefing window (L398-417).
  - **[M-06]** pendingPayouts permanent loss if WETH transfer fails — but tested as resilient.
  - **[M-07]** sweepExpiredRefund rug when refund actually delayed by user (L468-476).
- LOW: L-01 completeBounty event-ordering race (demoted from H-01); L-02 withdrawRefund emits no event (L385-391); L-03 getBounty does not return createdAt or snapshotTimestamp (L493-499); L-04 submitWork allows arbitrary URI string up to 2000 bytes — XSS at frontend boundary (L232-256, L248); L-05 MAX_SUBMISSIONS_PER_BOUNTY=100 enables sub-block griefing (L47, 243); L-06 No on-chain helper for paginated bounties (L80, 482); L-07 Off-by-one tolerance verified ✅; L-08 cancelBounty owner backdoor (L363).
- INFO: 8 informational items (signature replay N/A, vote precision, top-tie-break, _warpPastGrace test arithmetic fragility, IStakingVote interface unchecked, voteToken immutable but unused).

### 021 — POLAccumulator.sol
- Source: agent 021
- Counts: HIGH 2 / MED 5 / LOW 5 / INFO 7 / Test gaps 10
- HIGH:
  - **[H-1]** Sandwich on `accumulate()` — slippage floor is computed from spot, not oracle/TWAP — POLAccumulator.sol:257-295.
  - **[H-2]** `accumulate()` re-uses pool-spot ratio as basis for LP-add minimums (effective 0% protection for LP step) — 275-286.
- MEDIUM:
  - **[M-1]** Threshold bypass via direct ETH transfer + multiple `accumulate` calls — 70-71, 81, 246-248.
  - **[M-2]** `lpToken` is **not validated** to match `(toweli, weth)` pair — line 56 (immutable lpToken), line 145 (constructor).
  - **[M-3]** `executeHarvestLP` runs the "ETH not received" sanity check **after** state changes that depend on hostile router — 459-479.
  - **[M-4]** `harvestLP` cap is per-proposal, not per-window — can drain 10% every 30 days (427-445).
  - **[M-5]** `sweepETH` sequential drain — 383-402 (acknowledged Finding 3 but flagged INFO; agent 021 elevates to MEDIUM).
- LOW: L-1 receive() emits event but no rate-limit (154-156); L-2 sweepTokens allows owner to sweep TOWELI dust (500-507); L-3 MIN_BACKSTOP_BPS=5000 (50%) loose (68); L-4 cancellers emit cancelled value AFTER `_cancel` zeroes pendingX (177-182, 207-213, 488-492); L-5 No explicit acceptOwnership test for harvest path.
- INFO: I-1..I-7 incl. accumulate() does not check lpReceived>0 against totalLPCreated invariant; tokenUsed not compared; receive() no reentrancy concern; double-spend on triggered execute NOT FOUND; owner rug via sweep bounded; rounding floor favors protocol; threshold bypass via direct transfer partial.

### 022 — PremiumAccess.sol
- Source: agent 022
- Counts: HIGH 2 / MED 8 / LOW 8 / INFO 12
- HIGH:
  - **[H-01]** `subscribe()` extension consumed-portion accounting under-credits `totalRefundEscrow` (drift toward shortfall) — L186-242 (extension branch L203-217). Silent fund loss for any user who extends and cancels.
  - **[H-02]** `withdrawToTreasury` can be drained by owner racing a `proposeFeeChange` / `executeFeeChange` because consumed escrow accounting is timing-sensitive — L339-345. Permanently inflated `totalRefundEscrow` for unreconciled expired users.
- MEDIUM:
  - **[M-01]** ERC20 fee-on-transfer / rebasing tokens silently underpay & break escrow invariant (L193).
  - **[M-02]** Payment-token blacklist DoS on cancelSubscription and withdrawToTreasury (L296, L343).
  - **[M-03]** cancelSubscription callable while paused enables refund-during-incident griefing (L249, L247-248).
  - **[M-04]** deactivateNFTPremium 10-minute grace period gameable for cross-block flash-NFT activation (L172-179).
  - **[M-05]** Extension at exact `block.timestamp == sub.expiresAt` boundary takes the "extension" branch instead of "new sub" (L196).
  - **[M-06]** reconcileExpired and batchReconcileExpired are permissionless with no rate limiting (L304-334).
  - **[M-07]** `nftActivationBlock` typo / storage-naming inconsistency (L62).
  - **[M-08]** `paidFeeRate` mapping is set but never read in current code path (L51, L232).
- LOW: L-01 getSubscription returns lifetime=nftHolder snapshot (L426-431); L-02 hasPremium does not check nftActivationBlock against current NFT (L130); L-03 cancel/subscribe events lack granularity (L241, L299); L-04 claimNFTAccess deprecated reverts (L350-353); L-05 Constructor accepts any treasury without code-size check (L104-112); L-06 pause/unpause not behind timelock (L364-365); L-07 proposeTreasuryChange does NOT validate _treasury != treasury (L400-405); L-08 No event emitted by reconcileExpired/batchReconcileExpired (L304-334).
- INFO: 12 informational items (multiple-tier overlap, owner free-grant rug, signature replay, frontend-only gating bypass, NFT-based tier transfer race, expiry timestamp underflow, extension window edge, missing pause, access bypass via expired→re-active, refund accounting, deprecated stubs, TimelockAdmin solid).

### 023 — ReferralSplitter.sol
- Source: agent 023
- Counts: HIGH 0 / MED 5 / LOW 7 / INFO 5 / Test gaps 10
- MEDIUM:
  - **[M-01]** `updateReferrer` cooldown bypass on FIRST update (mainnet timestamps) — setReferrer L171-185, updateReferrer L189-211. Testing trick: Foundry's default block.timestamp=1 hides this.
  - **[M-02]** Sybil ring deeper than `CIRCULAR_DEPTH=25` is documented-but-unbounded — _checkCircularReferral L224-231.
  - **[M-03]** `recordFee` accounting drift on forfeiture — forfeitUnclaimedRewards L475-500.
  - **[M-04]** `markBelowStake` is callable by anyone, but does NOT auto-reset the "above stake" timer — L450-468.
  - **[M-05]** Approved-caller withdrawal of `callerCredit` keeps fee remainder OFF-protocol — recordFee L252-258, withdrawCallerCredit L294-302.
- LOW: L-01..L-07 inline string requires vs custom errors (L241, L397); referrerRegisteredAt permanent (L180, L207, L313); setReferrer does not record refereeSetAt (L171-185); forfeitUnclaimedRewards does not emit relationship-break events (L475-500); _checkCircularReferral does not include _referrer==_user early-out (L224-231); proposeApprovedCaller does not check setupComplete before proposing (L351-360); etc.
- INFO: 5 informational (accumulatedTreasuryETH accumulates referrer-share even when user has no referrer; sweepUnclaimable owner-only no timelock; OwnableNoRenounce inheritance; MIN_REFERRAL_STAKE_POWER hard-coded 1000e18; receiver via WETH fallback).

### 024 — RevenueDistributor.sol
- Source: agent 024
- Counts: HIGH 3 / MED 8 / LOW 6 / INFO 6 / Test gaps 10
- HIGH:
  - **[H-1]** Restaker fallback silently double-credits when staking checkpoint is non-zero post-restake (race window) — `_calculateClaim` L536-543; `_restakedPowerAt` L399-406.
  - **[H-2]** Reward-index drift: `epoch.totalLocked` snapshot is the MIN of two reads, but claim-side denominator is unilaterally `epoch.totalLocked` — `_distribute` L241-249; `_calculateClaim` L547. Same-block flash-deflation possible.
  - **[H-3]** `pendingETH` view drifts from claim path: same `epochClaimed` snapshot can mislead UIs — `_pendingETH` L766-807.
- MEDIUM:
  - **[M-1]** `effectivePower = min(userPower, epoch.totalLocked)` masks staking-checkpoint corruption (L546).
  - **[M-2]** `reconcileRoundingDust` has no timelock — owner can sweep up to 1 ETH per call (L744-751).
  - **[M-3]** Grace-period race: user can extend lock between snapshot and claim (L530-533).
  - **[M-4]** `MIN_DISTRIBUTE_STAKE` constant insufficient on small protocols (L209).
  - **[M-5]** `block.timestamp - 1` snapshot at line 244 not safe at genesis.
  - **[M-6]** Owner emergency-sweep: `executeForfeitReclaim` reduces `totalEarmarked` without claim-window check (L719-728).
  - **[M-7]** pause() only blocks user-facing claims/distribute — owner admin actions still work (L409-416).
  - **[M-8]** No claim deadline / expiry — unbounded epochs.length growth and view-DoS.
- LOW: L-1 totalForfeited tracked but invisible (L97, 725, 748); L-2 epochCount()-1 underflow if epochs.length==0 (L221); L-3 PendingWithdrawalCredited event emitted regardless of credit change (L462); L-4 MAX_VIEW_EPOCHS and MAX_CLAIM_EPOCHS both 500 — no asymmetry (L103-104); L-5 sweepDust and reconcileRoundingDust both emit DustSwept event ambiguity (L652, 750); L-6 No fee-on-transfer reward-token concern but executeTokenSweep doesn't handle FoT (L680).
- INFO: 6 items (no multi-token; integer overflow; WETHFallbackLib DoS-resistance; nonReentrant + 10k stipend; OwnableNoRenounce; restaker-fallback under-credit acceptable trade-off).

### 025 — SwapFeeRouter.sol
- Source: agent 025
- Counts: HIGH 3 / MED 5 / LOW 6 / INFO 5 / Test gaps 10
- HIGH:
  - **[H-1]** Input-token FoT haircut leaves leaked input dust unaccounted (legacy `swapExactTokensForTokens`) — lines 450-492 + L745-749 doc comment.
  - **[H-2]** `convertTokenFeesToETHFoT` zeroes accounting before sizing the actual swap, can produce a state-balance phantom — lines 1147-1155.
  - **[H-3]** `withdrawTokenFees` does not enforce on-hand reservation against pending FoT haircuts — lines 1062-1071.
- MEDIUM:
  - **[M-1]** Per-pair fee override key collision with input-token address.
  - **[M-2]** Slippage bypass on legacy `swapExactETHForTokens` via inner-router check only — L377-378.
  - **[M-3]** `distributeFeesToStakers` fee-split rounding can leak wei to treasury when staker share is not 100% — L887-889.
  - **[M-4]** Slippage check on `swapExactETHForTokens` post-fee accuracy gap — L366-368.
  - **[M-5]** `recoverCallerCredit`/`recoverCallerCreditFrom` does not capture `accumulatedETHFees` ordering vs. concurrent swap fee accumulation — L1206-1215.
- LOW: L-1 MAX_DEADLINE = 2 hours hard cap (L99); L-2 _validateNoDuplicates O(n²) at maxPath=10; L-3 swapExactTokensForETH slippage check at L434 strict less correct; L-4 Conversion-cooldown grants single converter full 1h window per token; L-5 feeBps==BPS unreachable via constructor; L-6 withdrawPendingDistribution permissionless griefing benign.
- INFO: I-1 recoverCallerCredit uses require not custom error; I-2 keccak256 constants stored as bytes32 public constant runtime; I-3 pendingDistribution uses address keys; I-4 convertTokenFeesToETH and convertTokenFeesToETHFoT share cooldown via _enforceConversionCooldown; I-5 IUniswapV2Router02.WETH() pure mismatch.

### 026 — base/OwnableNoRenounce.sol
- Source: agent 026
- Counts: HIGH 0 / MED 3 / LOW 4 / INFO 5
- MEDIUM:
  - **[M-01]** Renounce-bypass via `transferOwnership(address(0))` is **NOT mitigated** — Ownable2Step allows it but cannot complete because address(0) cannot send tx; effectively neutralized but documentation oversight.
  - **[M-02]** Stale `pendingOwner` griefing surface (inherited from OZ).
  - **[M-03]** Two contracts (`TegridyDropV2`, `TegridyTWAP`) silently NO-OP `renounceOwnership` instead of reverting.
- LOW: L-01 Custom revert string instead of OZ custom error; L-02 renounceOwnership() declared `pure`, blocks future hooks; L-03 No OwnershipTransferStarted event override; L-04 14/17 importers hard-code OwnableNoRenounce(msg.sender) — CREATE2 footgun.
- INFO: I-01 Init double-call N/A; I-02 No `_checkOwner` overrides; I-03 stale test in TegridyDropV2.t.sol; I-04 Pragma ^0.8.20 matches OZ v5.1.0; I-05 abstract correctly used.

### 027 — base/TimelockAdmin.sol
- Source: agent 027
- Counts: HIGH 2 / MED 5 / LOW 7 / INFO 5
- HIGH:
  - **[H-01]** Pending value mutability between propose and execute (silent value swap) — base contract `_propose` reverts on duplicate but inheritors don't bind value to timelock key.
  - **[H-02]** `_executeAfter[key]` can be silently force-cleared mid-flight inside `acceptFeeToSetter` (TegridyFactory.acceptFeeToSetter() reaches directly into `_executeAfter[FEE_TO_CHANGE]` and zeroes it without going through `_cancel()`).
- MEDIUM:
  - **[M-01]** MIN_DELAY=1 hours dangerously low for "battle-tested" base.
  - **[M-02]** Grace-period (PROPOSAL_VALIDITY=7 days) griefable into perpetual deadlock.
  - **[M-03]** No proposer/executor role separation; lone-admin owns both halves.
  - **[M-04]** Re-propose-after-cancel race vs Ownable2Step transfer.
  - **[M-05]** Empty-key (`bytes32(0)`) collisions in keyed proposals.
- LOW: L-01 _execute does not consume external payload; L-02 _propose does not record proposer; L-03 block.timestamp 15-second miner skew; L-04 No event for delay parameter; L-05 hasPendingProposal and proposalExecuteAfter public read views fine but no batch view; L-06 TegridyFactory only importer without OwnableNoRenounce; L-07 Re-entrancy through `_execute` event handler (CEI good).
- INFO: 5 items (storage write costs, one-pending-per-key rule, PROPOSAL_VALIDITY public constant, no signature-based queue, payload-free design as STRONGEST property).

### 028 — lib/WETHFallbackLib.sol
- Source: agent 028
- Counts: HIGH 1 (info-only design note) / MED 5 / LOW 4 / INFO 5
- HIGH:
  - **[H-1]** (info-only — design tension): `safeTransferETHOrWrap` whole-amount wrap leaks accounting state when stipend fails partway. Recipient cannot opt out of WETH custody.
- MEDIUM:
  - **[M-1]** Recipient can grief 10k gas stipend → forced WETH path → forced ERC20 acceptance.
  - **[M-2]** `IWETH.transfer` boolean is honored, but `bool sent` ignores tokens that revert vs return-false.
  - **[M-3]** Return-data bombing on the ETH `.call`; CONFIRMED SAFE via Solmate pattern.
  - **[M-4]** Reentrancy posture — 10k stipend prevents external calls from recipient back into protocol contracts, but the WETH-fallback branch performs `IWETH.deposit{value:amount}()`.
  - **[M-5]** `safeTransferETH` (non-fallback variant) forwards UNBOUNDED gas — used only by TegridyLending.repayLoan line 550.
- LOW: L-1 Dust ETH stuck if `IWETH.transfer` succeeds but recipient is blacklisted; L-2 amount==0 early-return silently no-ops; L-3 msg.value vs amount mismatch — library doesn't validate; L-4 10k gas stipend may be insufficient for some legitimate Safe wallets / abstract account contracts.
- INFO: 5 items (gas optimization duplicate balance check; no event emission for fell-through-to-WETH; safeTransferETH no chain-stipend protection; library has no slippage on wrap; clone proxy factories use Initializable).

---

## Section 2 — Cross-cutting Solidity (agents 029-045)

### 029 — Cross-Contract Reentrancy Audit
- Source: agent 029
- Counts: 7 ATTACK PATHS (mix of MEDIUM and LOW). 10 contracts in scope; 4 of 20 RedTeam attacks defended explicitly.
- HIGH/MED:
  - **ATTACK PATH 1** — Read-only reentrancy on `TegridyPair.getReserves()` during burn() callback (PARTIALLY MITIGATED). Risk transfers to Router._calculateLiquidity for adjacent pair read. HIGH theoretical, gated by token-upgrade governance — TegridyPair.swap (L183), burn (L150); TegridyRouter.addLiquidity (L67), _calculateLiquidity (L490).
  - **ATTACK PATH 2** — RevenueDistributor `pendingDistribution` read-only reentrancy (LOW) — SwapFeeRouter.distributeFeesToStakers L879-937, pendingDistribution mapping L164.
  - **ATTACK PATH 3** — TegridyRestaking↔TegridyStaking unsettledRewards race during malicious receiver's `onERC721Received` (HIGH, partially mitigated) — TegridyRestaking.unrestake L470-599, restake L289, claimPendingUnsettled L603, staking.claimUnsettled cross-contract.
  - **ATTACK PATH 4** — TegridyFeeHook.claimFees read-only reentrancy via PoolManager.take (LOW, mitigated by Uniswap V4 lock) — L275-282.
  - **ATTACK PATH 5** — TegridyNFTPool seller-controlled ERC721 onReceived during swapNFTsForETH (MEDIUM) — L232, onERC721Received L552. DEFENDED.
  - **ATTACK PATH 6** — Multi-hop router→pair→pair-token-callback→adjacent-pair-stale-reserves (HIGH, depends on token type acceptance) — TegridyRouter._swap (L404), TegridyPair.swap (L183), skim (L255).
  - **ATTACK PATH 7** — TegridyLending ETH-floor sandwich during acceptOffer (DOCUMENTED, MEDIUM) — _positionETHValue (L715), acceptOffer (L403).

### 030 — Approval / Allowance Abuse Audit
- Source: agent 030
- Counts: HIGH 0 / MED 0 / LOW 1 (advisory) / INFO 2
- LOW (advisory):
  - **[1]** `IERC721.transferFrom` instead of `safeTransferFrom` on NFT inflows in lending escrow — TegridyLending.sol:462; TegridyNFTLending.sol:378.
- INFO:
  - Lending NFT inflow uses transferFrom not safeTransferFrom — receiver hook bypassed.
  - `_chargeExtendFee` in TegridyStaking:1478 pulls TOWELI via safeTransferFrom(msg.sender,treasury,fee).
- Verdict: zero raw `.approve(`, 16 `forceApprove(`, 0 long-lived non-zero allowances. ZERO live exploit paths.

### 031 — Slippage / MEV / Sandwich Forensic Audit
- Source: agent 031
- Counts: HIGH 4 / MED 6 / LOW 3 / INFO 6 / Test gaps 7
- HIGH:
  - **[H-1]** TegridyLending `_positionETHValue` uses spot reserves as oracle — TegridyLending.sol:715-723 called from :430.
  - **[H-2]** POLAccumulator `accumulate()` is high-value MEV target the owner can self-sandwich — POLAccumulator.sol:238-307.
  - **[H-3]** POLAccumulator `executeHarvestLP` removes 10% of POL with caller-supplied minOut — POLAccumulator.sol:450-486.
  - **[H-4]** SwapFeeRouter `convertTokenFeesToETH` gives caller full control of slippage on protocol fees — SwapFeeRouter.sol:1089-1130.
- MEDIUM:
  - **[M-1]** TegridyRouter MAX_DEADLINE=2 hours allows stale intents — TegridyRouter.sol:40, 47-50.
  - **[M-2]** Non-trivial maxSlippageBps ceiling on POLAccumulator is 10% — POLAccumulator.sol:60-61, 161.
  - **[M-3]** TegridyRouter uses `getAmountsOut()` as price source then enforces same minOut — TegridyRouter.sol:172, 206.
  - **[M-4]** Lending grace period (1h) extends MEV manipulation window — TegridyLending.sol:120, 524.
  - **[M-5]** TegridyFeeHook fee returns absolute value, no per-block sandwich check — TegridyFeeHook.sol:167-249.
  - **[M-6]** TegridyPair `swap()` allows back-running via permissionless `harvest()` — TegridyPair.sol:280-286.
- LOW: L-1 SwapFeeRouter FoT variants pass amountOutMin=0 to inner Uniswap (L543-544, 608-610, 671-673); L-2 POLAccumulator proposeMaxSlippage allows up to 1000 bps (L161); L-3 TegridyNFTPool swapNFTsForETH lacks per-item price floor (L232-264).
- INFO: 6 items (TegridyPair.swap canonical UV2; TegridyRouter swap paths bound by amountOutMin/amountInMax; TegridyLaunchpadV2 no swap path; RevenueDistributor reads no spot reserves; TegridyFeeHook fee reserve-independent; owner-triggered execute surfaces audited).

### 032 — Oracle / TWAP Cross-Dependency Forensic Audit
- Source: agent 032
- Counts: HIGH 3 / MED 5 / LOW 5 / INFO 4
- HIGH:
  - **[H-1]** TegridyLending ETH-floor reads spot AMM reserves (oracle-bypass, sandwich-manipulable) — TegridyLending.sol:715-724.
  - **[H-2]** TWAP `update()` is permissionless and can be sandwiched to drift the moving average — TegridyTWAP.sol:118-219.
  - **[H-3]** `block.timestamp − last.timestamp` math mixes uint256 and uint32 → wrap-window bypass — TegridyTWAP.sol:256, :318.
- MEDIUM:
  - **[M-1]** Decimals mismatch silently produces wrong amountOut — TegridyTWAP.sol:222-246.
  - **[M-2]** First-observation deviation guard is unconditional pass — TegridyTWAP.sol:164-188.
  - **[M-3]** TWAP buffer is 12h max, MAX_STALENESS=2h, consult(period) capped at 12h — but no minimum period enforced — TegridyTWAP.sol:222-246, 68-72.
  - **[M-4]** POLAccumulator's slippage backstop derives from spot, not TWAP — POLAccumulator.sol:225-296.
  - **[M-5]** `update()` accepts excess ETH, refunds via `.call` — refund failure reverts the observation write — TegridyTWAP.sol:122-127.
- LOW: L-1 withdrawFees is permissionless (L294-302); L-2 setFeeRecipient allows zero check but no two-step (L286-291); L-3 getLatestObservation has no staleness gate (L260-265); L-4 MAX_OBSERVATIONS=48 hardcoded (L69); L-5 getObservationCount returns clamped count, but storage observationCount is unbounded (L268-271).
- INFO: 4 items (Chainlink-class controls absent; TegridyNFTLending intentional no-oracle design; PremiumAccess no price logic; TegridyTWAP test coverage gaps).

### 033 — Fee-on-Transfer / Rebasing Token Forensic Audit
- Source: agent 033
- Counts: HIGH 0 / MED 2 / LOW 5 / INFO 6
- MEDIUM:
  - **[M-01]** TegridyStaking records `_amount` without balance-diff on stake/increase/notify — TegridyStaking.sol:540 stake; :588 stakeWithBoost; :695 increaseAmount; :1207 notifyRewardAmount.
  - **[M-02]** TegridyLPFarming asymmetric FOT awareness — funding is safe, staking is not — TegridyLPFarming.sol:263 stake vs L390-392 notifyRewardAmount.
- LOW: L-01 TegridyPair.skim is permissionless; FOT skim donation race (L255-265); L-02 TegridyPair.mint uses balance-reserve directly without sanity check (L112-115); L-03 CommunityGrants.submitProposal records nominal PROPOSAL_FEE not delivered amount (L217-221); L-04 PremiumAccess.purchase records nominal cost not delivered amount (L193); L-05 TegridyStaking _reserved() includes totalRewardsFunded which over-reserves under FOT (L1208 + L469-475).
- INFO: 6 items (Toweli has no FOT logic; VoteIncentives.depositBribe canonical; SwapFeeRouter multi-layer FoT defenses; TegridyRestaking uses balance-diff; TegridyPair.swap explicit FoT-output reverts; TegridyRouter exposes V2 *SupportingFeeOnTransferTokens family).

### 034 — Initializer + Proxy Storage Collision Review
- Source: agent 034
- Counts: HIGH 1 / MED 3 / LOW 4 / INFO 5
- HIGH:
  - **[H-034-1]** TegridyPair.sol initialize is **not protected by OZ Initializable** and uses hand-rolled `_initialized` bool with **no `_disableInitializers()` on the implementation** — TegridyPair.sol:42-82.
- MEDIUM:
  - **[M-034-1]** TegridyNFTPoolFactory.createPool salt is predictable and front-runnable for griefing — lines 144-147.
  - **[M-034-2]** TegridyNFTPool.initialize() has no factory reentrancy guard — lines 138-175. Anyone can clone implementation directly.
  - **[M-034-3]** TegridyDropV2.initialize storage slots vs ERC721 base — storage layout fragility on future upgrades (L19, 81-115).
- LOW: L-034-1 TegridyPair.initialize lacks reinitializer protection (L74-82); L-034-2 TegridyNFTPool.initialize zero-checks present but _protocolFeeBps not zero-checked at pool level (L138-156); L-034-3 TegridyDropV2: owner=p.creator no separate zero-check (L166-185); L-034-4 TegridyFactory.createPair raw CREATE2 (L113-119).
- INFO: 5 items (TegridyNFTPool constructor calls _disableInitializers L124; TegridyDropV2 constructor calls _disableInitializers L23; All initializer functions explicit zero-address; Factories pass address(this) as trusted factory; NFTPoolFactory salt includes msg.sender; LaunchpadV2 salt uses abi.encode collision-resistant).

### 035 — Test Hole Audit
- Source: agent 035
- Cross-file findings: 9 patterns including 120+ naked `vm.expectRevert()`, 50+ `assertGt(x,0)` post-conditions, mock VotingEscrow ignoring timestamp, mock router 1:1 with no slippage, `vm.assume(amount>0)` filters out small-amount edge cases, post-warp tests asserting only nonzero, "DEFENDED"-narrative tests with no failing assertion, single .bak file.
- Top-5 weakest test files: RedTeam_POLPremium.t.sol (5 _DEFENDED tests with assertTrue(true)); Audit195_StakingGov.t.sol (12 bare expectRevert + 7 assertGt); Audit195_SwapFeeRouter.t.sol (22 bare expectRevert); SwapFeeRouter.t.sol+AuditFixes (MockUniRouter 1:1); AuditFixes_Other.t.sol (mock VE ignores timestamp).
- 60 active test files. REAL: 17-20 (incl. Toweli, GaugeCommitReveal, TegridyFeeHook, TegridyLaunchpadV2, TegridyLending, TegridyLending_Reentrancy, TegridyNFTPool_Reentrancy, TegridyNFTPool_Sandwich, TegridyTWAP, TegridyTokenURIReader, Audit195_Factory, Audit195_Pair, Audit195_StakingCore, Audit195_StakingRewards, FuzzV3, FinalAudit_AMM/Restaking/Revenue, RedTeam_AMM, TegridyNFTPoolFactory). WEAK: 36+. DECORATIVE: 4 (RedTeam_POLPremium ATTACK 12/13/18 narrative; AuditFixes_Pair `test_router_hasNonReentrant`; TegridyLending_ETHFloor sandwich pin; Audit195_Restaking.t.sol.bak).

### 036 — Fuzz / Invariant Test Surface Audit
- Source: agent 036
- Critical missing invariants: 17 (HIGH) across 9 contracts; 13 (MEDIUM); 4 configuration deficiencies. Stateful invariants in repo: 3 (all guarding TegridyPair). 21 of 25 contracts have 0 invariants.
- foundry.toml has no [fuzz] or [invariant] profile section. Default fuzz.runs=256, invariant.runs=256, fail_on_revert=false.
- Per-contract critical missing invariants: TegridyPair (sumOfLPBalances==totalSupply, K-monotonic on swap, LP_minted, MINIMUM_LIQUIDITY locked, no-free-mint, kLast==0 iff feeTo==0); TegridyNFTPool (price-monotonic, no-loss-on-roundtrip multi-actor, ETH balance vs claims, heldTokenIds vs balanceOf, delta/spotPrice caps); TegridyLending (lending solvency, collateralValue>=debtValue, loan startTime, treasury leak); TegridyStaking (totalStaked==sum, accruedRewards<=unclaimedRewardPool, no-free-mint of NFTs, boost monotonicity, early-withdraw penalty); RevenueDistributor (vote-weight conservation, balance>=unclaimedShares, epoch monotonicity); TegridyRestaking (totalRestaked, reward-pool solvency); GaugeController+VoteIncentives (sum gaugeWeights, bribeBalance, no-double-claim); TegridyNFTLending (loan-collateral consistency, no reentrancy on default-claim).

### 037 — Deploy Scripts Audit
- Source: agent 037
- Counts: HIGH 8 / MED 19 / LOW 16 across 19 scripts in contracts/script/.
- HIGH highlights: DeployFinal.s.sol HIGH-1 setter ordering (Factory.proposeFeeToChange runs BEFORE transferOwnership but feeToSetter never moved to multisig); DeployAuditFixes.s.sol HIGH-1 same Factory feeToSetter problem; DeployRemaining.s.sol HIGH-1 cross-contract linking before ownership transfer with no validation; WireV2.s.sol HIGH-1 transferOwnership idempotent; HIGH-2 hardcoded V2 addresses without state validation; DeployGaugeController.s.sol HIGH-1 vm.startBroadcast() with NO PRIVATE_KEY arg; ConfigureFeePolicy.s.sol HIGH-1 setter calls run AGAINST a contract whose ownership is on multisig; DeploySwapFeeRouterV2.s.sol HIGH-1 deploys NEW SwapFeeRouter and proposes PremiumAccess + premium discount changes — but ReferralSplitter `setApprovedCaller` step omitted.
- Cross-script patterns: feeToSetter is systemic blind spot; vm.envOr("MULTISIG", address(0)) silently skips ownership transfer; wire scripts lack state guards; mid-broadcast env reads cause partial-state aborts; 2-step ownership = pendingOwner trap.

### 038 — Constructor & Immutable Address Audit
- Source: agent 038
- Counts: HIGH 2 / MED 1 / LOW + INFO mix
- HIGH:
  - **[1]** TegridyNFTLending bootstrap whitelist hard-codes 3 mainnet NFT collections — TegridyNFTLending.sol:237-244 (JBAC `0xd37264c7…`, Nakamigos `0xd774557b…`, GNSS Art `0xa1De9f93…`).
  - **[2]** `weth` address never codehash-verified in any of 14 contracts. WETHFallbackLib.safeTransferETHOrWrap depends on this.
- MEDIUM:
  - **[3]** Permanent rug surfaces baked at construction (no rotation path) — `weth`, `pair` (TegridyLending), `lpToken` (POLAccumulator), `factory` (VoteIncentives, TegridyRouter), `dropTemplate` (TegridyLaunchpadV2) are all immutable and unrotatable.

### 039 — Events Audit
- Source: agent 039
- Counts: 263 event declarations across 24 contracts; 9 contracts subscribed by indexer; 23 indexed event types.
- HIGH (Indexer Coverage Gaps): H-EVT-01 Paused/Unpaused not subscribed for ANY contract (13 contracts); H-EVT-02 TegridyPair (V2 LP) entirely unindexed; H-EVT-03 TegridyRestaking:EmergencyForceReturn / BoostRevalidated / PositionRefreshed not indexed; H-EVT-04 TegridyStaking admin events not indexed; H-EVT-05 GaugeController ENTIRELY unindexed (commented out: "deferred").
- MEDIUM: M-EVT-01..06 SwapFeeRouter:SwapExecuted tokenIn/tokenOut not indexed; TegridyLending:LoanAccepted lender not indexed; TegridyRouter:Swap path[] not indexed; setReferrer no event; RevenueDistributor:Claimed missing diff/totalClaimed; TegridyFactory:setFeeTo verify FeeToUpdated emission.
- LOW: L-EVT-01..05 RewardRateExecuted emits NEW only no OLD; TegridyDropV2.setMintPhase family emits ONLY new value; TegridyTWAP UpdateFeeChanged GOOD pattern; **L-EVT-04 ReferralSplitter.sol contains literal `\` characters** [REFUTED by agents 096+101 — false alarm]; L-EVT-05 Owner-change events.

### 040 — ERC Standards Conformance Audit
- Source: agent 040
- Counts: 0 HIGH/CRITICAL ERC-conformance gaps. ERC20Permit DOMAIN_SEPARATOR chain-id-safe via OZ v5 rebuild.
- Top-5: F-ERC721-07 LOW TegridyLending+TegridyNFTLending use raw transferFrom; F-ERC721-01 LOW TegridyStaking _mint over _safeMint; F-ERC721-03 LOW TegridyTokenURIReader returns metadata for burned tokens; F-ERC2981-03 LOW TegridyDropV2 royalty receiver sticky; F-ERC721-02 LOW TegridyStaking has no tokenURI override.
- TegridyRestaking is NOT ERC4626 — donation-inflation guard N/A.

### 041 — Gas-Griefing / Unbounded-Loop DoS
- Source: agent 041
- Counts: HIGH 0 / MED 1 / LOW 2 / INFO 5
- MEDIUM:
  - **[M-041-1]** RevenueDistributor._calculateClaim — state-mutating "view-like" loop (acceptable, but worth noting) — RevenueDistributor.sol:526. MAX_CLAIM_EPOCHS=500 per call.
- LOW: L-041-1 TegridyFactory.allPairs push-only with no on-chain cap (42, 122); L-041-2 TegridyNFTPoolFactory._poolsByCollection unbounded view enumeration (236, 269).
- INFO: I-041-1..5 GaugeController.removeGauge bounded by MAX_TOTAL_GAUGES=50; VoteIncentives.removeWhitelistedToken bounded by MAX_BRIBE_TOKENS=20; claimBribesBatch nested loop bounded; SwapFeeRouter._validateNoDuplicates O(n²) at maxPath=10; TegridyStaking.votingPowerOf bounded by MAX_POSITIONS_PER_HOLDER=100.
- All ETH-forwarding `.call{}` use explicit gas stipends. No return-data bomb surface.

### 042 — Signature / EIP-712 / Replay Surface
- Source: agent 042
- Counts: 0 HIGH / 0 MED / 0 LOW / 0 INFO findings. No credible signature-replay or off-chain-authority attack surface in this codebase.
- Surface inventory: Toweli (OZ ERC20Permit / EIP-2612); GaugeController (commit-reveal, no signatures); VoteIncentives (commit-reveal + bond); TegridyDropV2 (Merkle allowlist double-hashed); other contracts none.
- Audit checks all PASSED: chainid in DOMAIN_SEPARATOR; nonce hygiene; ECDSA s-malleability; ecrecover zero-return; multi-contract domain reuse; deadline; off-chain authority key (NONE EXIST); signed-amount vs param mismatch.
- Notes: 4 INFO observations on commit-reveal hash binding correctness, voter cap enforcement, double-hashed leaf, Toweli vanity address.

### 043 — Admin-Key Blast-Radius Matrix
- Source: agent 043
- Counts: 28 .sol files; 305 access-control hits across 20 contracts; 17 inheriting OwnableNoRenounce; 19 inheriting TimelockAdmin; 18 with pause; 0 contracts with auto-expiry on pause.
- Top-5 highest-blast-radius keys: SwapFeeRouter timelocked levers (CRITICAL but timelocked); SwapFeeRouter.sweepETH/withdrawTokenFees/sweepTokens/recoverCallerCreditFrom (HIGH NOT timelocked); RevenueDistributor.emergencyWithdraw + pause leverage (HIGH); TegridyFactory.proposeFeeToChange + guardian.emergencyDisablePair (HIGH guardian instant); TegridyStaking timelocked + pause direct + sweepToken direct (HIGH).
- CommunityGrants.emergencyRecoverETH(_recipient) MEDIUM-HIGH — owner picks recipient, only requires whenPaused. NOT timelocked.
- TegridyLending / TegridyNFTLending: no callable-during-pause emergency-exit for borrowers/lenders → indefinite freeze risk.
- Wave-0 caveat: 3 contracts still on EOA owner pending multisig acceptOwnership.

### 044 — Pause / Circuit-Breaker Discipline
- Source: agent 044
- Counts: 26 contracts; 18 with Pausable (~69%); 0 PAUSER_ROLE separation; 0 pause expiration; 0 pauser≠owner role separation.
- Severity ranking: HIGH TegridyNFTPool withdrawETH/withdrawNFTs lack whenPaused; HIGH RevenueDistributor claim()/claimUpTo() gated by both own pause AND staking pause; MEDIUM TegridyLending+TegridyNFTLending claimDefault paths gated; MEDIUM TegridyPair no pause despite holding LP; MEDIUM MemeBountyBoard completeBounty gated; LOW all 18 pausable contracts no PAUSER_ROLE separation; LOW no pause expiration; LOW TegridyLPFarming recoverERC20 not whenPaused; INFO ReferralSplitter no Pausable; INFO TegridyFeeHook EXEMPLAR (fee logic short-circuits on pause).

### 045 — L2 Compatibility Audit
- Source: agent 045
- Counts: HIGH 3 / MED 5 / LOW/INFO 5
- HIGH:
  - **[H1]** Arbitrum L2 timestamp can lag L1 by up to ~24h — short cooldowns and reveal windows are NOT validated against worst-case skew.
  - **[H2]** TegridyTWAP and TegridyPair use uint32(block.timestamp) — wrap year is 2106 on L1 but can be NOW on chains with high genesis offsets — TegridyTWAP.sol:137 and TegridyPair.sol:298.
  - **[H3]** No sequencer-uptime-feed integration anywhere in the codebase.
- MEDIUM: M1 TegridyStaking._checkpoints keys on uint48; M2 TegridyStaking rate-limit lastTransferTime initialized to 0 first transfer always passes; M3 code.length checks in TegridyStaking._update + VoteIncentives.sol:966 are evaluated at transfer/call time; M4 No CommunityGrants/GaugeController/MemeBountyBoard/POLAccumulator/SwapFeeRouter/TegridyLending/TegridyNFTLending/TegridyLPFarming/TegridyRestaking/TegridyTWAP/TegridyFeeHook/ReferralSplitter/TegridyDropV2/TegridyFactory/TegridyPair/TegridyNFTPool tests in L2Compatibility.t.sol; M5 TegridyDropV2.getCurrentDutchPrice (L322) on L2 with sequencer freeze causes dutch price to crash.
- LOW/INFO: L1 Pragma ^0.8.26 requires push0+MCOPY (Cancun); L2 block.chainid used for replay protection; L3 No ArbSys/L1Block/cross-domain message integration; L4 TegridyTWAP.MIN_PERIOD=15min; L5 TegridyPair.blockTimestampLast uint32.

---

## Section 3 — Frontend pages (agents 046-060)

### 046 — HomePage.tsx + DashboardPage.tsx
- Source: agent 046
- Counts: HIGH 1 / MED 5 / LOW 6 / INFO 3
- HIGH:
  - **[H1]** useEffect with stale-closure / re-trigger risk on Towelie nudge — DashboardPage.tsx:122-126.
- MED: M1 unsanitized URL search param accepted without history pollution guard (DashboardPage.tsx:57-71); M2 stale-closure risk in farmActions.isSuccess toast effect (DashboardPage.tsx:113-117); M3 useReadContract arg uses address! non-null assertion guarded only by query.enabled (DashboardPage.tsx:85-91); M4 prop-drilling loses chainId context to revenue/referral widgets (DashboardPage.tsx:489-506); M5 GitHub URL leaks deployer username (HomePage.tsx:321).

### 047 — TradePage / Swap surface
- Source: agent 047
- Counts: HIGH 3 / MED 8 / LOW 5 / INFO 3
- HIGH:
  - **[H-01]** Aggregator quote silently overwrites user-confirmed minOut at submit time — useSwap.ts:231-260; useSwapQuote.ts:262-263, 334-338.
  - **[H-02]** Quote staleness — no minimum freshness check before swap execution — useSwapQuote.ts:189-214; on-chain quotes :77-83, 102-108.
  - **[H-03]** Token symbol from on-chain symbol() rendered raw in chips, list rows, "Recent" pills — TokenSelectModal.tsx:390-391, 422-423, 426; TradePage.tsx:174, 219, 346.
  - **[H-04]** Race: spamming Swap during pending state can fire a second tx with stale/different route — useSwap.ts:207-340; TradePage.tsx:414-419.
- MED: M-01 deadline default 5 min too long; M-02 approve flow doesn't reset to zero before raising allowance — USDT will revert; M-03 No MEV/sandwich warning; M-04 custom-token import: lookup-by-`isImporting` runs `useReadContract` against any 40-hex blob; M-05 Aggregator HTTP failures swallow ALL errors as null; M-06 useSwap write-error effect drops actual revert reason; M-07 addCustomToken warning toast is the ONLY trust signal post-import; M-08 OpenOcean decimals math truncates with slice(0,6).

### 048 — FarmPage / Farm Hooks
- Source: agent 048
- Counts: HIGH 4 / MED 7 / LOW 6 / INFO 4
- HIGH:
  - **[H1]** Account-switch race during pending tx — useFarmActions.ts:30-94; useLPFarming.ts:104-122; useUserPosition.ts:9-25; FarmPage.tsx:106-116.
  - **[H2]** Tx receipt not re-checked against original sender — useFarmActions.ts:33-52; useLPFarming.ts:18-69.
  - **[H3]** useNFTBoost passes address! while query disabled (silent zero) — useNFTBoost.ts:23-27.
  - **[H4]** Stake amount fed to parseEther without normalization — FarmPage.tsx:104; useFarmActions.ts:74-92; StakingCard.tsx:315.
- MED: M1 TVL claim without source-of-truth confirmation; M2 APR cache staleness 60s no "stale" indicator; M3 Boost UI silently relies on per-render Date.now() for lock countdown; M4 optimistic clear of LP inputs on isSuccess without verifying which tx; M5 pendingEthGuard not enforced for claimUnsettled / extendLock; M6 chain-mismatch guard missing on read paths; M7 pause-state display incomplete.

### 049 — LendingPage / NFTLending / LendingSection / useMyLoans
- Source: agent 049
- Counts: HIGH 4 / MED 7 / LOW 5 / INFO 2
- HIGH:
  - **[H-049-1]** Position value mis-rendered as 1:1 TOWELI->ETH (token-lending LTV is fake) — LendingSection.tsx:1110-1112.
  - **[H-049-2]** ETH-floor mode is silently mis-rendered (rendered as wei-formatted ETH but never validated against position) — LendingSection.tsx:999-1003, 1062-1066.
  - **[H-049-3]** repayLoan fee included in `value` is stale (interest accrual not refreshed before tx) — NFTLendingSection.tsx:909-916, 932-944; LendingSection.tsx:1453-1494.
  - **[H-049-4]** Deadline countdown uses local clock — LendingSection.tsx:95-108, 1528-1545; NFTLendingSection.tsx:82-85, 905-907, 955-963.
- MED: M-049-1 missing chainId guard; M-049-2 missing pause-state check; M-049-3 oracle-staleness not surfaced to user; M-049-4 borrow-amount confirm shows different number than what gets submitted; M-049-5 partial-repay not surfaced; M-049-6 NFT collateral image fetched from external URL with no fallback; M-049-7 useMyLoans.ts indexes loans 0..n-1 but contracts mostly use 1..n.

### 050 — PremiumPage / usePremiumAccess
- Source: agent 050
- Counts: HIGH 0 / MED 0 / LOW 3 / INFO 3
- LOW: F-050-02 race between stale monthlyFee and subscribe maxCost (usePremiumAccess.ts:93-103); F-050-03 race between expiry boundary and subscribe re-up (usePremiumAccess.ts:73-75); F-050-05 setTimeout(0) reset chain may swallow rapid double-success or double-toast (usePremiumAccess.ts:114-147).
- INFO: F-050-01 client-only gating display only; no sensitive content gated; F-050-04 wrong ABI for JBAC NFT balance read (uses ERC20_ABI); F-050-06 payment confirmation correctly uses on-chain receipt + cache invalidation.

### 051 — AdminPage
- Source: agent 051
- Counts: CRITICAL 0 / HIGH 1 / MED 3 / LOW 4 / INFO 3
- HIGH:
  - **[H-1]** Client-only auth via owner() read; no server-side enforcement of admin UI — AdminPage.tsx:191-206, 345-361.
- MED: M-1 pause()/unpause() is the only write surface with a typed-confirmation guard; future writes have no scaffold (72-178, 437); M-2 owner refetch interval (30s) leaves stale-RBAC window (196-200); M-3 contractReadsError.message rendered raw to DOM (401-407).

### 052 — Art Studio (Dev Tool Surfaces)
- Source: agent 052
- Counts: CRITICAL 0 / HIGH 2 / MED 4 / LOW 4 / INFO 3
- HIGH:
  - **[H1]** /art-studio page route is shipped in the production bundle (no auth, no DEV gate) — App.tsx:115; ArtStudioPage.tsx:1-583.
  - **[H2]** Save endpoint accepts unauthenticated cross-origin POSTs from any localhost-resolvable origin — frontend/vite.config.ts:14-67.
- MED: M1 auto-save races against in-flight writes; M2 localStorage draft state can mask ART_OVERRIDES regressions across machines; M3 pageArt override artId lookup is case-sensitive but file system is not; M4 iframe X-Frame-Options: DENY will break <LivePreview> in production.

### 053 — CommunityPage + sub-components
- Source: agent 053
- Counts: 0 critical / 1 HIGH / 4 MEDIUM / 4 LOW = 9 findings
- HIGH:
  - **[#1]** Bounty submission URI accepts arbitrary string, will be rendered/clicked downstream without validation — BountiesSection.tsx:28-77, 230-237.
- MEDIUM: #2 Newline / control-char injection into proposal description and bounty description (GrantsSection.tsx:199-201; BountiesSection.tsx:151-153); #3 submCount from contract decoded with wrong tuple shape; UI displays NaN (BountiesSection.tsx:191-192); #4 target="_blank" inline contract address values interpolated raw into URLs without validation (GrantsSection.tsx:300; BountiesSection.tsx:250; VoteIncentivesSection.tsx:1510); #5 Bounty deadline computed off Date.now() without UTC sanity check.

### 054 — Leaderboard / Points / Tegridy Score
- Source: agent 054
- Counts: HIGH 4 / MEDIUM 6 / LOW 5 / INFO 4 / Total 19
- HIGH:
  - **[H1]** Client-computed scores are the source of truth (trivially gameable) — pointsEngine.ts:169-189; useTegridyScore.ts:340-380; usePoints.ts:99-104.
  - **[H2]** Self-referral self-credit possible via incrementReferralCount — pointsEngine.ts:241-249; usePoints.ts:106-118.
  - **[H3]** Sybil protection completely absent — pointsEngine.ts (whole), useTegridyScore.ts (whole).
  - **[H4]** localStorage integrity hash uses djb2 (not crypto), nonce defeated — pointsEngine.ts:62-106.

### 055 — Static Page Content Drift
- Source: agent 055
- Counts: HIGH 7 / MEDIUM 9 / LOW 6 / INFO 8 / Total 30
- Notable HIGH drifts: TokenomicsPage SUPPLY_DATA buckets vs TOKENOMICS.md (65/20/10/5 vs 30/10/10/5/45); POL_ACCUMULATOR marked "Pending" but live; FAQ lock duration "1 to 52 months" vs 7d-4y; FAQ JBAC stacking vs flat 0.5x; FAQ Nakamigos/GNSS receive yield boost (FALSE); TermsPage 0.3% fee vs 0.50% (SWAP_FEE_BPS=50); SecurityPage hard-codes deprecated v1 staking addr `0x65D8…a421` instead of v2; SecurityPage hard-codes wrong NFT lending addr; SecurityPage doesn't import from constants.ts; ContractsPage GitHub org mismatch `tegridyfarms` vs `fomotsar-commits`; ContractsPage typo "tegriddy" in issues link; RisksPage list of "patched but not yet redeployed" stale by 7 days; SecurityPage "Protocol admin controlled by team multisig" vs RisksPage single EOA.

### 056 — LiveActivity / Towelie Assistant Surfaces
- Source: agent 056
- Counts: HIGH 0 / MEDIUM 1 / LOW 3 / INFO 6
- MED:
  - **[F-056-01]** Stale-closure / missing-dep in TowelieAssistant queue effect — TowelieAssistant.tsx:167-179.
- LOW: F-056-02 unbounded dismissTimes growth (242-247); F-056-03 Idle-timer effect re-attaches global listeners on every disabled/canShow change (209-226); F-056-04 useTypewriter uses setInterval+cancelled flag redundant with clearInterval (54-69).
- INFO (positive): F-056-08 Static knowledge base eliminates entire LLM-backed assistant attack class; F-056-10 useToweliePrice.ts does not exist (file path correction).

### 057 — Wagmi Config
- Source: agent 057
- Counts: HIGH 0 / MED 3 / LOW 4 / INFO 4
- MEDIUM:
  - **[MEDIUM-1]** Public RPC fallback chain has rate-limit / production cost-storm risk — wagmi.ts:10-17.
  - **[MEDIUM-2]** VITE_WALLETCONNECT_PROJECT_ID ships in client bundle (acceptable per WC spec, but no domain allowlist enforced in code) — wagmi.ts:7.
  - **[MEDIUM-3]** wagmi/RainbowKit cache TTL not explicitly tuned; React Query defaults applied app-wide — App.tsx:70-78.
- LOW: L-1 transports table only includes mainnet but explorer.ts enumerates L2s; L-2 CHAIN_ID=1 hardcoded in constants.ts while wagmi exports mainnet.id; L-3 TEGRIDY_LAUNCHPAD_V2_ADDRESS is 0x0000…0000 (zero address); L-4 No autoConnect flag visible.

### 058 — History / Activity / Transaction Receipt
- Source: agent 058
- Counts: CRITICAL 0 / HIGH 1 / MED 5 / LOW 6 / INFO 4
- HIGH:
  - **[H1]** Etherscan response is not validated against a strict schema (no zod / typed contract); only field-presence checked — HistoryPage.tsx:31-55, 211-260 (isValidTxRecord, truncateTxFields, fetch().then(parse)).
- MED: M1 Tx hash rendered without checksum or strict validation in HistoryPage; M2 value (wei) rendered raw in CSV export, no decimal formatting; M3 block-explorer URL falls back to mainnet Etherscan for unknown chains (explorer.ts:25-31); M4 in-memory + localStorage cache stored unvalidated; M5 pre-finality / pending receipt state not represented; receipts shown as authoritative.

### 059 — Gallery & NFT Metadata
- Source: agent 059
- Counts: HIGH 4 / MED 5 / LOW 4 / INFO 3
- HIGH:
  - **[H-1]** useNFTDropV2.resolveContractUri accepts arbitrary protocol schemes (data:/javascript:/file:/gopher:) — useNFTDropV2.ts:13-21, 26-32.
  - **[H-2]** NftImage.jsx IPFS gateway is a single point of failure (`ipfs.io`) — NftImage.jsx:13-17.
  - **[H-3]** Metadata gateway calls have no client-side rate limit — NftImage.jsx:69-93, 95-147; nakamigos/api.js.
  - **[H-4]** ArtImg.tsx has zero failure handling — broken `<img>` will render — ArtImg.tsx:32-44.

### 060 — TreasuryPage
- Source: agent 060
- Counts: HIGH 0 / MEDIUM 3 / LOW 8 / INFO 3
- MEDIUM:
  - **[M1]** USD figures lack staleness indicator despite oracleStale/displayPriceStale available in PriceContext.
  - **[M2]** No source attribution / "as of block" / RPC origin caption — figures not server-reproducible.
  - **[M3]** TreasuryPage never reads paused() — paused protocol shows stale fees as if live.

---

## Section 4 — Frontend hooks/lib/components (agents 061-075)

### 061 — Swap/DCA/Limit-Order Hooks
- Source: agent 061
- Counts: CRITICAL 0 / HIGH 5 / MEDIUM 9 / LOW 7 / INFO 4
- HIGH:
  - **[HIGH-1]** Stale-closure on executeSwap: BroadcastChannel cross-tab amount race — useSwap.ts:207-340.
  - **[HIGH-2]** executeSwap deps missing chainId and address — useSwap.ts:340.
  - **[HIGH-3]** useSwapQuote aggregator effect: stale-result race despite request-ID — useSwapQuote.ts:189-214.
  - **[HIGH-4]** useDCA.executeDCASwap rebuilds path without checking if pair exists — useDCA.ts:296-416.
  - **[HIGH-5]** useLimitOrders price polling: stale executeOrder closure inside async loop — useLimitOrders.ts:389-419.

### 062 — Frontend Hooks (Pool / Farm / NFT)
- Source: agent 062
- Counts: HIGH 4 / MEDIUM 9 / LOW 7 / INFO 5
- HIGH:
  - **[H-062-01]** useNFTBoost: enabled: !!address but args use [address!] — useNFTBoost.ts:23-26.
  - **[H-062-02]** useNFTDrop / useNFTDropV2: missing chainId in queryKey → cross-chain cache poisoning — useNFTDrop.ts:16-27; useNFTDropV2.ts:43-59.
  - **[H-062-03]** usePoolTVL: TVL multiplies user-influenceable reserves by ETH price with no sanity bounds — usePoolTVL.ts:46-53.
  - **[H-062-04]** useLPFarming: refetchInterval: 30_000 plus auto-refetch() on every tx success → RPC storm under bot activity — useLPFarming.ts:35, 60-69.

### 063 — Hooks/Governance Forensic Audit
- Source: agent 063
- Counts: HIGH 4 / MEDIUM 9 / LOW 7 / INFO 6
- HIGH:
  - **[H1]** useGaugeList is fully stale across an epoch boundary — no listener for GaugeAdded/GaugeKilled/epoch advance — useGaugeList.ts:32-37.
  - **[H2]** Bribe deposit not refetched after an external claim — useBribes only auto-refetches on the caller's transaction — useBribes.ts:256-270.
  - **[H3]** useRestaking trusts a single RPC for share-price / pending-rewards — no oracle, no sanity bounds — useRestaking.ts:17-32, 45-50.
  - **[H4]** useToweliPrice write-through cache poisons baseline across origins — useToweliPrice.ts:69-81, 218-226.

### 064 — Frontend Hooks (Misc)
- Source: agent 064
- Counts: CRITICAL 0 / HIGH 3 / MED 6 / LOW 5 / INFO 4
- HIGH:
  - **[H1]** useMyLoans.ts: Unbounded pagination — fetches ALL loans ever created (DoS / RPC bomb) — useMyLoans.ts:59-93.
  - **[H2]** useIrysUpload.ts: NO size cap on uploads — wallet drainer / accidental funding — useIrysUpload.ts:106-156, 170-209.
  - **[H3]** useTransactionReceipt.ts: NO reorg / re-confirmation handling; receipt is purely client-state — useTransactionReceipt.ts:1-78.

### 065 — Frontend Lib: Aggregator + Storage + ABI Supplement + Token List
- Source: agent 065
- Counts: HIGH 1 / MEDIUM 5 / LOW 5 / INFO 4
- HIGH:
  - **[H1]** Hard-coded CHAIN_ID = 1 in aggregator with no chainId guard against connected wallet — aggregator.ts:5.

### 066 — LibErrAnalytics (errorReporting / analytics / copy / navConfig)
- Source: agent 066
- Counts: HIGH 1 / MEDIUM 4 / LOW 4 / INFO 3
- HIGH:
  - **[H-1]** Analytics + error reporting fire before any user consent (no consent gate) — analytics.ts (entire module); errorReporting.ts (installGlobalHandlers, line 152). Wired in main.tsx:9, TradePage.tsx:66, AppLayout.tsx:87.

### 067 — Lib: Points Engine, Boost Calculations, Towelie Knowledge
- Source: agent 067
- Counts: HIGH 0 / MEDIUM 5 / LOW 4 / INFO 4 (total 13)
- MEDIUM:
  - **[MEDIUM-1]** Towelie KB contradicts on-chain truth: "100% of swap fees flow back to stakers" — towelieKnowledge.ts:22, 122. Actual: 5/6 to LPs, 1/6 to protocol.
  - **[MEDIUM-2]** "early withdrawal penalty scales with how far from unlock" — towelieKnowledge.ts:60-61. Actual: flat 25%.
  - **[MEDIUM-3]** "Stack JBAC NFTs for stacked boost" — towelieKnowledge.ts:142. Actual: holdsJBAC ? 1.5 : 1, no additive stacking.
  - **[MEDIUM-4]** Boost ceiling claim contradicts on-chain MAX_BOOST_BPS_CEILING — towelieKnowledge.ts:88. Actual ceiling 4.5x.
  - **[MEDIUM-5]** incrementReferralCount has no idempotency key — replay vector if wired up — pointsEngine.ts:241-249.

### 068 — Frontend lib: revertDecoder / txErrors / explorer / formatting / nftMetadata
- Source: agent 068
- Counts: HIGH 2 / MEDIUM 4 / LOW 4 / INFO 3
- HIGH:
  - **[H-01]** revertDecoder cannot decode Solidity custom errors (4-byte selector ABI errors); user sees raw 0x... hex — revertDecoder.ts:4-58.
  - **[H-02]** KNOWN_ERRORS ordering: generic "execution reverted" matches before specific patterns when both substrings co-occur — revertDecoder.ts:18, 37-39.

### 069 — Layout / Loader / UI Forensic Audit
- Source: agent 069
- Counts: HIGH 4 / MEDIUM 7 / LOW 6 / INFO 4
- HIGH:
  - **[H-1]** OnboardingModal missing focus trap + initial focus management — OnboardingModal.tsx:33-164.
  - **[H-2]** Modal.tsx lacks focus trap; only auto-focuses dialog root — Modal.tsx:18-112.
  - **[H-3]** BottomNav z-50 collides with global modal layer — BottomNav.tsx:47; ArtLightbox.tsx:80; Modal.tsx:57.
  - **[H-4]** OnboardingModal close-on-outside-click swallows ALL backdrop taps — OnboardingModal.tsx:67-75.

### 070 — Chart & Community & Visual Effects Audit
- Source: agent 070
- Counts: HIGH 1 / MEDIUM 4 / LOW 4 / INFO 3
- HIGH:
  - **[H-1]** Untrusted on-chain string description rendered without length guard or sanitization (2 sites) — BountiesSection.tsx:211; GrantsSection.tsx:245.

### 071 — Widgets & Misc UI Forensic Audit
- Source: agent 071
- Counts: HIGH 1 / MEDIUM 5 / LOW 6 / INFO 4
- HIGH:
  - **[H-1]** SeasonalEvent.tsx: cross-tab dismissal flag is unkeyed by user/wallet — global mute leakage between accounts — SeasonalEvent.tsx:33-34, 75-79.

### 072 — Launchpad Components Forensic Audit
- Source: agent 072
- Counts: 1 CRITICAL / 3 HIGH / 5 MEDIUM / 4 LOW / 2 INFO / 1 DEAD-V1
- CRITICAL:
  - **[C-1]** OwnerAdminPanel.tsx (V1) reads V2 ABI but uses V1 phase-enum literal `5` for CANCELLED → owner UX wrongly drives a V2 contract — OwnerAdminPanel.tsx:23-30.
- HIGH:
  - **[H-1]** PHASE_LABELS drift between V1 (3 phases) and V2 admin grid — launchpadConstants.ts:11.
  - **[H-2]** OwnerAdminPanelV2.tsx:75 — wrong isCancelled index.
  - **[H-3]** Wizard persists deployedAddress / deployTxHash to localStorage and re-hydrates them on mount — useWizardPersist.ts:33-34; CreateWizard.tsx:60-61.

### 073 — AppRoot / Frontend Bootstrap Audit
- Source: agent 073
- Counts: HIGH 1 / MED 4 / LOW 4 / INFO 2
- HIGH:
  - **[H-073-1]** Real third-party API key bundled into client JS via VITE_ETHERSCAN_API_KEY — frontend/.env line 3 (`VITE_ETHERSCAN_API_KEY=28QIIIRZPGUBJPDA5ZANG2E9Y48SWKACRK`).

### 074 — Responsive / iOS / iPad Audit
- Source: agent 074
- Counts: 5 device-specific breaks (HIGH severity first)
- Top-5 device-specific breaks:
  1. **[HIGH]** 100vh / min-h-screen everywhere — iOS Safari URL bar overflow. 0 uses of 100dvh in entire codebase.
  2. **[HIGH]** iPad mini (744px) hits md-only breakpoint cliff. BottomNav (md:hidden), TopNav (hidden md:flex) flip at 768px; iPad mini is 744px.
  3. **[HIGH]** nav-link desktop touch target = ~30px (fails Apple HIG 44px) — index.css:370-380.
  4. **[HIGH]** No defensive overflow-x-hidden on page containers — horizontal scroll risk.
  5. **[MEDIUM]** BottomNav clashes with iOS home indicator + TowelieAssistant overlap — BottomNav.tsx:47-54.

### 075 — Skeletons (PageSkeleton + PageSkeletons + page wiring)
- Source: agent 075
- Counts: HIGH 3 / MED 2 / LOW 5 / INFO 2
- HIGH:
  - **[F-1]** Skeleton dimensions cause guaranteed CLS / layout shift — PageSkeletons.tsx (every variant); PageSkeleton.tsx.
  - **[F-2]** Infinite skeleton animation runs without prefers-reduced-motion opt-out — PageSkeleton.tsx:11-12; PageSkeletons.tsx (every .skeleton div); index.css:417-422; index.css:444-454.
  - **[F-3]** aria-busy missing from every skeleton — PageSkeleton.tsx; PageSkeletons.tsx (all three).

---

## Section 5 — API + auth + indexer + CI (agents 076-090)

### 076 — Auth/SIWE Forensic Audit
- Source: agent 076
- Counts: CRITICAL 0 / HIGH 1 / MEDIUM 3 / LOW 4 / INFO 4
- HIGH:
  - **[H-076-1]** expirationTime / notBefore not server-side enforced when omitted — siwe.js:208-218. Per `siwe` library v2 semantics, if message omits expirationTime, time parameter has no expiration — practical impact bounded by 5-min nonce TTL.
- MEDIUM: M-076-1 URI (siweMessage.uri) not validated against allowed origins (siwe.js:163-168); M-076-2 Origin used for domain in verify can be empty (siwe.js:164, 207-215); M-076-3 No CSRF token on POST /api/auth/siwe (siwe.js:141-257).

### 077 — Ratelimit + Proxy Schemas
- Source: agent 077
- Counts: HIGH 2 / MED 2 / LOW 2
- HIGH:
  - **[HIGH-01]** X-Forwarded-For trusted unconditionally → rate-limit bypass via spoofed header — ratelimit.js:81-87.
  - **[HIGH-02]** No body-size or depth-limit on JSON parsing → DoS via nested JSON — supabase-proxy.js:49-50.

### 078 — API Proxy Audit (v1/index.js, alchemy.js, etherscan.js)
- Source: agent 078
- Counts: HIGH 4 / MEDIUM 6 / LOW 5 / INFO 4
- HIGH:
  - **[H-1]** Alchemy & Etherscan API keys interpolated into upstream URL (queryable from Vercel logs / SaaS observability) — v1/index.js:14; alchemy.js:8-9; etherscan.js:93.
  - **[H-2]** v1/index.js has NO real rate limit (cosmetic headers only) — v1/index.js:37-41.
  - **[H-3]** v1/index.js has NO body-size guard, NO upstream response-size cap, NO gzip-bomb defense — v1/index.js:68; alchemy.js:99-103; etherscan.js:104.
  - **[H-4]** Shared edge cache (s-maxage=…) on RPC response that may carry per-request data — alchemy.js:144.
  - **[H-5]** eth_getLogs block-range is unbounded (gzip / quota DoS vector) — alchemy.js:115-135.

### 079 — frontend/api/opensea.js & frontend/api/orderbook.js
- Source: agent 079
- Counts: HIGH 3 / MEDIUM 6 / LOW 4 / INFO 4
- HIGH:
  - **[H1]** OpenSea proxy returns full upstream response body to caller without schema validation (price/poison/XSS vector) — opensea.js:171-190.
  - **[H2]** Orderbook create action forwards client-supplied seaportSignature and parameters to DB without verifying they form a valid on-chain Seaport order — orderbook.js:298-374.
  - **[H3]** price_eth is computed via `Number(BigInt * 1e8 / divisor) / 1e8` — silent precision loss + Number(BigInt) overflow on 18-decimal large prices — orderbook.js:284-286, 166.

### 080 — Supabase RLS / Proxy
- Source: agent 080
- Counts: HIGH 0 / MEDIUM 3 / LOW 4 / INFO 5
- MEDIUM:
  - **[MED-1]** toggle_like SECURITY DEFINER without locked search_path — 001_siwe_auth_rls.sql:90-110.
  - **[MED-2]** prune_revoked_jwts SECURITY DEFINER without search_path and EXECUTE not revoked — 003_revoked_jwts.sql:40-48.
  - **[MED-3]** Public messages INSERT path: trigger ratelimit + RLS rely on JWT-claim mismatch with proxy validator (case sensitivity) — 001_siwe_auth_rls.sql:26-30 vs proxy-schemas.js:27.
- LOW: LOW-1 messages table missing UNIQUE/replay constraint; LOW-2 siwe_nonces lacks UNIQUE/FOR-DELETE on consume path; LOW-3 trade_offers and push_subscriptions SELECT policies leak via JOIN-style patterns; LOW-4 Conflicting policies on trade_offers — 002 does NOT DROP POLICY on the legacy "Anyone can read trades" → effectively public.

### 081 — CORS + Secret-Handling Forensic Audit
- Source: agent 081
- Counts: 7 API route files; 2 MED + 3 LOW + 1 INFO
- MED-1: auth/me.js and auth/siwe.js set Allow-Credentials: true on hardcoded fallback origin (`https://nakamigos.gallery`); MED-2: supabase-proxy.js does NOT call setCors() / handle OPTIONS.
- LOW-1: ALLOWED_ORIGIN env var fallback is unsafe default; LOW-2: Vary: Origin not set on supabase-proxy.js.
- Verdict: Strong baseline. No CORS wildcards on per-user endpoints. No `.env` files committed. No client-bundle leakage of server secrets.

### 082 — Logging Forensic Audit
- Source: agent 082
- Counts: 17 console.* calls in frontend/api (all error/warn, NO log); 0 console.* in errorReporting.ts; 0 console.* in indexer/src/index.ts; 0 Sentry/PostHog references.
- Top-5 LOW findings: api/auth/siwe.js logs error.message from supabase responses; api/_lib/ratelimit.js line 136 logs upstash error; api/orderbook.js line 475 logs RPC verification failure; LOW; INFO frontend console.error/warn widely DEV-gated; ErrorBoundary logs componentStack.

### 083 — Webhook Signature Handling & Idempotency
- Source: agent 083
- **NO INCOMING WEBHOOK SURFACE.** Frontend/api exposes zero third-party webhook receivers.
- Adjacent in-scope concerns: orderbook.js MAX_SIGNATURE_AGE_SEC=300; siwe.js nonce single-use atomic delete-then-verify.
- Findings: 0 critical/high/medium/low.
- Forward-looking recommendation: build the `_lib/verifyWebhook.js` helper before first provider integration.

### 084 — Indexer Audit
- Source: agent 084
- Counts: HIGH 5 / MEDIUM 7 / LOW 4 / INFO 3 / Total 19
- HIGH:
  - **[IDX-H1]** GaugeController entirely unsubscribed (commented-out "deferred") — ponder.config.ts:419-420.
  - **[IDX-H2]** TegridyPair (DEX core LP) entirely unsubscribed.
  - **[IDX-H3]** No reorg/finality / confirmations setting in config — ponder.config.ts:354-359.
  - **[IDX-H4]** Paused/Unpaused not subscribed for ANY of 13 pausable contracts.
  - **[IDX-H5]** Schema mismatch: EarlyWithdrawn ABI declares 4 args, handler reads 3 — ponder.config.ts:30-34 + index.ts:81-83. `penalty` field silently dropped.

### 085 — GitHub Workflows & Issue Templates Audit
- Source: agent 085
- Counts: CRITICAL 0 / HIGH 2 / MEDIUM 3 / LOW 4 / INFO 7 / Follow-up 4
- HIGH:
  - **[HIGH-1]** Secret available to fork-PR builds — ci.yml:67-68 (VITE_WALLETCONNECT_PROJECT_ID).
  - **[HIGH-2]** Floating major-version pins on third-party actions (supply-chain) — actions/checkout@v4, foundry-rs/foundry-toolchain@v1, crytic/slither-action@v0.4.0, softprops/action-gh-release@v2, github/codeql-action/*@v3.

### 086 — Vercel / CSP / Edge-Headers Forensic Audit
- Source: agent 086
- Counts: HIGH 1 / MEDIUM 3 / LOW 2 / INFO 5
- HIGH:
  - **[F1]** connect-src missing `https://rpc.ankr.com` → wagmi fallback transport will be CSP-blocked — frontend/src/lib/wagmi.ts:14.

### 087 — Build Scripts Forensic Audit
- Source: agent 087
- Counts: HIGH 0 / MEDIUM 3 / LOW 4 / INFO 3 / Total 10
- MEDIUM:
  - **[M-087-1]** migrate-art-imgs.mjs is a destructive bulk rewrite with no backup or dry-run flag — frontend/scripts/migrate-art-imgs.mjs:70.
  - **[M-087-2]** render-og-png.mjs recommends unpinned, unchecksummed npx install in CI hint — scripts/render-og-png.mjs:13, 51.
  - **[M-087-3]** extract-missing-abis.mjs overwrites a checked-in TypeScript file with no provenance, no diff gate — scripts/extract-missing-abis.mjs:82.

### 088 — E2E + Test-Utils Forensics
- Source: agent 088
- Counts: CRITICAL 0 / HIGH 3 / MEDIUM 4 / LOW 4 / INFO 3
- HIGH:
  - **[H-088-1]** All E2E coverage is mock-based; no Anvil fork ever stood up — fixtures/wallet.ts:107-186.
  - **[H-088-2]** Six core user flows have no e2e coverage at all — connect wallet (partial), swap, add liquidity, remove liquidity, stake/unstake, claim rewards, repay loan, borrow, mint launchpad, gauge commit+reveal.
  - **[H-088-3]** `test-results/` is checked into git — frontend/test-results/.last-run.json (45 bytes, tracked).

### 089 — Type Safety Audit
- Source: agent 089
- Counts: HIGH 0 (no critical) / 5 highest-risk type holes
- Top-5: #1 OwnerAdminPanelV2.tsx:93 & OwnerAdminPanel.tsx:55 `args as never[] } as any` for wagmi writeContract; #2 Every `await res.json()` site (11 hooks/lib + 4 nakamigos files) with no zod; #3 frontend/tsconfig.app.json:34 excludes `src/**/*.test.ts(x)` from typecheck; #4 useIrysUpload.ts × 5 `Uint8Array as unknown as Buffer`; #5 usePoolTVL.ts:29 and VoteIncentivesSection.tsx:1038 heterogeneous-tuple `as any` / `Array<any>`.

### 090 — Silent Error Handling Audit
- Source: agent 090
- Counts: HIGH 1 / MED 4 / LOW 6 / INFO 4
- HIGH:
  - **[1]** tx.wait() without receipt.status check on critical Seaport cancel/approve flows — nakamigos/lib/weth.js:74, 99; BidManager.jsx:287; MyListings.jsx:357, 417; OrderBookPanel.jsx:67; api-offers.js:610, 703.

---

## Section 6 — Cross-cutting forensics (agents 091-101)

### 091 — Dead Code & Unused Exports
- Source: agent 091
- Counts: 12 dead page modules + 3 dead V1 launchpad files + 1 .bak + 14 Solidity DEPRECATED functions retained intentionally + 0 generated.ts ABIs for deleted V1 + 0 indexer dead handlers
- Top-5: V1 launchpad/drop pair (CollectionDetail.tsx, OwnerAdminPanel.tsx, useNFTDrop.ts, useNFTDrop.test.ts ~600 LOC); HistoryPage.tsx (~370+ LOC merged into ActivityPage); PremiumPage.tsx 449 LOC; TokenomicsPage.tsx with Sparkline+chart deps; contracts/test/Audit195_Restaking.t.sol.bak (50KB committed backup).

### 092 — V1 vs V2 Drift Forensics
- Source: agent 092
- Verdict: V1 contract sources are deleted from contracts/src/ (good). V1 frontend duplicates still exist as orphan source files but internally call V2 ABIs — they are not real V1-runtime drift, they are dead-code aliases. One historical V1 factory address embedded in a frontend file as an Etherscan link constant.
- Total runtime-wired V1 surfaces: 0. Total dead V1 source files in tree: 4 (CollectionDetail.tsx, OwnerAdminPanel.tsx, useNFTDrop.ts, useNFTDrop.test.ts) — 866 LOC.

### 093 — ABI vs Source Drift (CRITICAL ABI-DRIFT)
- Source: agent 093
- Three competing ABI sources, no clear precedence: generated.ts (6,661 LOC, 261 fn entries, 5 events; LOWERCASE camelCase; **0 imports** — effectively dead); abi-supplement.ts (6,869 LOC, 263 fn entries, 87 events; UPPER_SNAKE; 1 contract actually consumed - TWAP); contracts.ts (313 fn entries, 7 events; hand-coded UPPER_SNAKE; the **de-facto runtime source**); indexer/ponder.config.ts (~10 inline event-only ABIs, 0 shared with frontend).
- Top 5 drifts:
  1. **CRITICAL** — `totalPenaltiesRedistributed` referenced in contracts.ts:30 + generated.ts:2100 + generated.ts:5758-5764 hook; **deleted from contract**. Calling this hook on the deployed contract reverts with no-such-method.
  2. **HIGH** — TegridyPair.harvest() exists in artifact + source, missing from ALL three frontend ABIs — TegridyPair.sol:280; abi-supplement.ts TEGRIDY_PAIR_ABI block lines 5844-6517 missing harvest, blockTimestampLast, several events.
  3. **CRITICAL** — tegridyStakingAbi covers 30 of 143 functions (80% missing surface). Missing: acceptOwnership, proposeRewardRate, executeRewardRateChange, etc. (~113 functions).
  4. **HIGH** — TEGRIDY_TWAP_ABI (auto-extracted) only has 8 of 24 artifact functions. Missing: acceptOwnership, owner, pendingOwner, transferOwnership, renounceOwnership, setFeeRecipient, setUpdateFee, withdrawFees, accumulatedFees, feeRecipient, updateFee, MAX_UPDATE_FEE.
  5. **MEDIUM** — Indexer ABI inline duplicates that don't bother to re-import; CommunityGrants overload collision (`ProposalCreated` two events; ABI selector clash drops the timelock-overload event). Same overload collision in TegridyStaking / TegridyLending TimelockAdmin events silently dropped.
- Other findings: 6 of 7 supplement ABIs dead-but-exported (~6,000 LOC dead, drifting code); generated.ts has tegridyLaunchpadV2Address = 0x000…0; abi-supplement.ts header claims auto-extraction but extract-missing-abis.mjs was run against an old `out/`.

### 094 — Address Consistency
- Source: agent 094
- Cross-checked 9 sources × 30 contracts. OK rows: 23. Drift rows (≥2 sources disagree): 5. Stale-broadcast-only rows: 2.
- Top-5 mismatches:
  1. **HIGH** — SwapFeeRouter EIP-55 case mismatch (`BFc8ff` vs `BFc8fF`) — frontend/constants.ts:16, CONTRACTS.md:27, README.md:317 (BFc8ff…) vs indexer/ponder.config.ts:404 (BFc8fF…).
  2. **HIGH** — Latest SwapFeeRouter broadcast points to a different contract (`0x71eaeca0…`) than what FE/indexer/CONTRACTS.md/README all reference (`0xea13Cd…937A0`). `contracts/broadcast/DeploySwapFeeRouterV2.s.sol/1/run-latest.json` shows new address.
  3. **HIGH** — VoteIncentives latest broadcast points to `0xa5a974da…5b43` but every source-of-truth lists `0x417F44ae…cf1A`. 5 historical VoteIncentives broadcasts on disk pointing to 5 different addresses.
  4. **MEDIUM** — DeploySwapFeeRouterV2.s.sol L12 hardcoded ReferralSplitter `0x5A2c3382…7411` (does NOT match `REFERRAL_SPLITTER_ADDRESS = 0xd3d46C0d…2c16`).
  5. **MEDIUM** — DeploySwapFeeRouterV2.s.sol L13 hardcodes `PREMIUM_ACCESS = 0x84AA3Bf4…8aF7` (does NOT match canonical `0xaA16dF3d…22Ad`).

### 095 — Documentation Drift Audit
- Source: agent 095
- Counts: CRITICAL 4 / HIGH 7 / MEDIUM 9 / LOW/INFO 6 / Verify-with-user 2 / Total 28
- Top-5 highest-impact drifts:
  1. **FAQ-01 / FAQ-02** — FAQ.md publishes a fictitious 10% burn/buyback AND a fictitious 4-of-7 Gnosis Safe. Both contradicted by TOKENOMICS, README, and NEXT_SESSION.
  2. **REV-01** — REVENUE_ANALYSIS.md cites a contract constant `SWAP_FEE_BPS = 50` that does not exist in SwapFeeRouter.sol.
  3. **SEC-02** — SECURITY.md links to an Immunefi page that 404s; bug-bounty SLA + $50k-$250k reward range published; submission flow not yet live.
  4. **README-05 / FIX-02** — README's "Quick start — contracts" tells users to `./scripts/redeploy-patched-3.sh`, a deleted file.
  5. **RUN-03** — DEPLOY_RUNBOOK §10 says H-2 commit-reveal "not implemented", AUDITS.md + CHANGELOG say it's live on mainnet.
- Honourable mention: README-04 / TOKEN-01 — boost ladder differs by 0.5× between README and TOKENOMICS for 1-year and 2-year locks.

### 096 — Compile & Lint Audit
- Source: agent 096
- Verdict: contracts compile cleanly (forge build PASS, 0 errors, 429 warnings + 751 notes). frontend types pass (tsc --noEmit PASS). frontend lint FAILS (eslint exit 1; 127 errors + 35 warnings = 162 problems). indexer typecheck FAILS (135 TS errors; 102 in src code).
- Forge-lint warning histogram (429 total): 349 erc20-unchecked-transfer, 78 unsafe-typecast, 2 divide-before-multiply.
- Forge-lint note histogram (751 total): 406 unaliased-plain-import, 152 mixed-case-variable, 87 mixed-case-function, 61 screaming-snake-case-immutable, 10 unused-import, etc.
- **REFUTES Agent 039 finding**: Agent 039 cross-flagged `ReferralSplitter.sol` has literal `\` characters where `//` was intended on lines 175, 247, 249, 253, 257, 260, 261, 263. Agent 096 verified each line — all use proper `//` comment markers. **FALSE flag**.
- Top-5 compile/lint blockers: indexer ponder.config.ts uses `chains` key, Ponder Config type expects `networks` (cascades to ~100 TS errors); 25 react-hooks/rules-of-hooks violations in frontend; 16 react-hooks/set-state-in-effect violations (LearnPage.tsx:40, LendingPage.tsx:66); 349 erc20-unchecked-transfer forge-lint warnings; 78 unsafe-typecast warnings (some in pricing math).

### 097 — Storage Layout Sanity (Cloned Implementations)
- Source: agent 097
- Counts: 2 contracts audited (TegridyDropV2, TegridyNFTPool); 51 storage slots in use (33 Drop + 18 Pool); 0 collisions; 0 diamond conflicts; 0 missing __gap (justified, not required for EIP-1167 clones); 0 packed-struct misalignments; 0 private-shadowed-by-parent reads; 0 wrong constant/immutable choices; 2 dead-but-occupying inherited slots (Drop slots 0-1 ERC721._name/_symbol by design); _disableInitializers() on template both ✓.
- Top-3:
  1. **POSITIVE** — Both implementations correctly call `_disableInitializers()` in their constructor (TegridyDropV2.sol:23; TegridyNFTPool.sol:124).
  2. **POSITIVE** — Missing __gap reserves are JUSTIFIED, not a bug. EIP-1167 minimal proxies are non-upgradeable by construction.
  3. **LOW** — Two minor packing inefficiencies in TegridyDropV2 (gas-only, NOT security). Re-clustering MintPhase mintPhase + bool revealed + bool withdrawn + platformFeeBps could save ~3 slots × ~20k gas ≈ 60k gas per clone deploy.

### 098 — Frontend Bundle Size & Runtime Performance
- Source: agent 098
- Counts: HIGH 3 / MEDIUM 6 / LOW/INFO mix; total dist = 71 MB; 529 asset files; 224 .js.map files
- HIGH:
  - **[H1]** Source maps shipped to production (224 .js.map files, ~33 MB extra payload) — vite.config.ts line 176: `sourcemap: 'hidden'`.
  - **[H2]** Both ethers AND viem shipped in same bundle — package.json `"ethers": "^6.16.0"` AND `"viem": "^2.47.6"`. 49 source files import from 'ethers'.
  - **[H3]** LendingPage eagerly imports 4 large sections (1.30 MB single chunk) — pages/LendingPage.tsx lines 7-10.

### 099 — SEO + Meta + OG + Favicon + Sitemap + Robots
- Source: agent 099
- Counts: HIGH 3 / MED 5 / LOW 4 / INFO 3 / Total 15
- HIGH:
  - **[HIGH-2]** usePageTitle is JS-only meta mutation; crawlers see only index.html defaults. Per-page OG/canonical/description invisible to Twitter, Facebook, Slack, Discord.
  - **[HIGH-1]** apple-touch-icon points at the 1024×1024 / 189 KB hero JPG — frontend/index.html:20.
  - **[HIGH-3]** 4 wrapper pages (ActivityPage, InfoPage, LearnPage, ArtStudioPage) skip usePageTitle; 13 of 21 sitemap URLs serve homepage tags during chunk load and to JS-disabled crawlers.

### 100 — Cross-Audit Adjudication Report
- Source: agent 100
- Reviews findings from agents 001-087 + 088 + 090 (84 reports present at time of run).
- Coverage map: 84 of expected 100 present at audit time. Missing slots: 086, 089, 091-099 (orphan slots noted; have since been filled by agents 086, 089, 091-099 in the final 101-agent set). 5 contracts/modules nobody covered: Toweli↔SwapFeeRouter↔ReferralSplitter end-to-end fee accounting; Solidity custom error catalog drift; CI secret scanning; CREATE2 address-prediction tests; .spartan_unpacked directory.
- 20 contradictions / severity drifts adjudicated:
  - C-1 TegridyLending spot oracle: triple HIGH (006, 031, 032) vs MEDIUM-DOCUMENTED (029) → **HIGH** (3 vs 1).
  - C-2 harvest() permissionless on disabled pairs: 001 HIGH unique → **confirm HIGH**.
  - C-3 setGuardian instant on TegridyFactory: 003 HIGH unique → **confirm HIGH** (reclassify as owner-rug surface).
  - C-4 TegridyTWAP `update()` permissionless: 032 HIGH vs 013 omits → **upgrade 013's view to HIGH**.
  - C-5 TegridyPair `harvest()` nonReentrant: internal inconsistency in 001 — actual issue is missing disabled-pair check, not lock.
  - C-6 _safeMint reentrancy in TegridyDropV2: 011 MED vs 029 silent → **keep MEDIUM**.
  - C-7 TegridyStaking M-005-04 `_clearPosition` overwrites userTokenId: 005 MED vs 015 H-2 assumes single-position → **flag for product owner decision**.
  - C-8 claimFees reentrancy on TegridyFeeHook: 004 MED vs 029 LOW (V4 lock) → **downgrade 004 M-1 to LOW**.
  - C-9 feeTo race during 48h timelock: 001 M-7 (governance-only if multisig) → **downgrade to LOW** if multisig is in place.
  - C-10 TegridyNFTPool spotPrice updates BEFORE NFT transfers: 008 H-2 vs 029 ATTACK PATH 5 MEDIUM → **settle on HIGH**.
  - C-11 OwnableNoRenounce transferOwnership(0): 026 M-01 → **confirm MEDIUM, hardening required**.
  - C-12 SwapFeeRouter convertTokenFeesToETH slippage: 025 + 031 same root cause → **merge into one HIGH**.
  - C-13 POLAccumulator accumulate() spot vs TWAP: 021 H-1 vs 032 M-4 → **settle on HIGH**.
  - C-14 TegridyRouter MAX_DEADLINE = 2h: 002 LOW vs 031 MED vs 025 LOW → **settle on MEDIUM**.
  - C-15 TegridyRestaking H-2 double-claim: aligned → no conflict.
  - C-16 Skeleton `aria-busy` missing: 075 HIGH a11y → **downgrade to MEDIUM**.
  - C-17 localStorage referrer/score/draft NOT wallet-namespaced: 054 + 058 + 071 same root cause → **merge into one HIGH**.
  - C-18 Etherscan API key bundled into client JS: 073 HIGH vs 081 silent → **confirm HIGH**.
  - C-19 Aggregator quote silently overwrites user-confirmed minOut: 047 + 061 facets of same race → **merge as one HIGH**.
  - C-20 safeTransferETHOrWrap 10k stipend forces WETH path: 028 canonical write-up; others rely on it.
- **Consolidated TOP 20 highest-impact issues** (severity-ranked) including spot-as-oracle merge across 006/021/029/031/032; SwapFeeRouter FoT drains 025+033; TegridyTWAP first-2-obs 013+032; PremiumAccess subscribe-extend 022; VoteIncentives lock-bribes 017; TegridyRestaking unsettled 015; TegridyStaking accumulator 005; TegridyPair harvest+FoT 001; Alchemy/Etherscan keys 078+073; TegridyNFTPool sniping 008; MemeBountyBoard rug 020; CommunityGrants pause-recover 019; TegridyDropV2 root-rotation 011; RevenueDistributor pause+drift 024+044; TegridyFactory setGuardian 003; TegridyFeeHook delta-credit 004; client-points/sybil 054; trade UI minOut/race 047+061; ArtStudio prod ship 052; a11y / responsive across 069/074/075.

### 101 — Final Forensic Sweep
- Source: agent 101
- Counts: 152 source files audited; 0 orphans across 6 target directories; 100% coverage.
- Section A (REFUTED): Agent 039's claim that ReferralSplitter.sol has literal `\` characters is REFUTED. Line-by-line verification (lines 175, 247, 249, 253, 257, 260, 261, 263) shows all use proper `//` comment markers. Ground-truth `forge build` confirms zero compile errors.
- Section B (Final Orphan Sweep):
  - contracts/src/ (28 files): all covered by agents 001-028 + cross-cutting 029-045.
  - frontend/src/pages/ (25 files): all covered.
  - frontend/src/hooks/ (50 entries): all covered.
  - frontend/src/lib/ (36 entries): all covered.
  - frontend/api/ (12 entries): all covered.
  - indexer/src/ (1 entry): covered.
- Verdict: The 100-agent forensic audit achieved full surface coverage. No newly-found risks. Audit corpus closed.

---

## Section 7 — Systemic patterns (cross-agent)

### Owner-rug-during-pause
- Contributing agents: 019 (CommunityGrants H-1/H-2/H-3), 043 (admin-keys blast radius), 044 (pause discipline)
- One paragraph: CommunityGrants exposes the canonical owner-rug-during-pause: `retryExecution`, `cancelProposal`, and `lapseProposal` lack `whenNotPaused` while `emergencyRecoverETH` is whenPaused-gated. Owner pauses, cancels Approved proposals to drop `totalApprovedPending`, then recovers full balance. Adjacent surfaces (RevenueDistributor admin sweeps continue during pause; SwapFeeRouter direct-call sweeps non-timelocked but route to timelocked treasury; CommunityGrants `emergencyRecoverETH(_recipient)` allows arbitrary recipient). Pause-covers-only-deposit is the dominant anti-pattern across 18 pausable contracts; emergency recovery surfaces never auto-expire.

### Spot-reserves-as-oracle
- Contributing agents: 006 (TegridyLending), 021 (POLAccumulator), 029 (cross-contract reentrancy ATTACK PATH 7), 031 (slippage/MEV), 032 (oracle/TWAP), 067 (boostCalculations cross-validates)
- One paragraph: TegridyLending `_positionETHValue` reads raw `getReserves()`; POLAccumulator `accumulate` and `executeHarvestLP` use spot-derived backstops; SwapFeeRouter `convertTokenFeesToETH` accepts caller-supplied minOut. Already proven by `test_sandwich_sameBlockManipulation_succeeds`. TegridyTWAP exists on-chain but has ZERO production consumers; TegridyLending never imports it despite advertising the floor as oracle-protected. Three competing readings (HIGH triple — 006+031+032; MEDIUM-documented — 029) reconciled to HIGH. Same root-cause across multiple contracts; merge into a protocol-wide finding.

### Decorative tests / weak fuzz
- Contributing agents: 035 (test holes), 036 (fuzz invariants), 088 (e2e)
- One paragraph: 60 active Solidity test files, 17-20 truly REAL, 36+ WEAK (bare `vm.expectRevert()`, `assertGt(.,0)` post-conditions, mock VotingEscrow ignoring timestamp, mock router 1:1, _DEFENDED narratives that pass via assertTrue(true)). Stateful invariant functions in repo: 3 (all guarding TegridyPair). 21 of 25 contracts have 0 invariants. foundry.toml has no [fuzz] or [invariant] profile section; defaults: runs=256, fail_on_revert=false. E2E coverage is mock-based; six core user flows have NO e2e (swap, add/remove liquidity, stake/unstake, claim, repay, mint launchpad, gauge commit-reveal). The team has the Anvil upgrade scaffold in-tree but has not executed.

### Frontend↔on-chain drift (incl. ABI drift)
- Contributing agents: 067 (Towelie KB false claims), 093 (ABI drift CRITICAL), 094 (address consistency), 095 (docs drift), 055 (static page drift)
- One paragraph: Three competing ABI sources, no clear precedence: generated.ts (6,661 LOC, **0 imports** — effectively dead); abi-supplement.ts (6,869 LOC, 1 contract actually consumed); contracts.ts (313 fn entries, hand-coded — the de-facto runtime source); indexer/ponder.config.ts (10 inline event-only ABIs, 0 shared with frontend). CRITICAL drift: `totalPenaltiesRedistributed` referenced in contracts.ts:30 + generated.ts hook but **deleted from contract**. Calling this on the deployed contract reverts with no-such-method. `tegridyStakingAbi` covers 30 of 143 functions (80% missing surface). TegridyPair.harvest() exists in artifact + source but missing from ALL three frontend ABIs. Three Solidity events (CommunityGrants overload-collision, TimelockAdmin events on Staking/Lending) silently dropped by indexer. SwapFeeRouter latest broadcast points at `0x71eaeca0…` but FE/indexer/CONTRACTS.md/README all reference `0xea13Cd…937A0`. Towelie KB asserts "100% of swap fees flow back to stakers" (actual: 5/6 to LPs, 1/6 to protocol); "early withdrawal penalty scales with how far from unlock" (actual: flat 25%); "Stack JBAC NFTs for stacked boost" (actual: flat +0.5x).

### Indexer coverage gaps
- Contributing agents: 039 (events), 084 (indexer)
- One paragraph: 9 of 24 contracts subscribed (37.5% coverage). 23 of 263 events indexed (8.7% coverage). GaugeController entirely unsubscribed (commented "deferred"). TegridyPair (DEX core LP) entirely unsubscribed — DEX volume / TVL irrecoverable from indexer. Paused/Unpaused not subscribed for any of 13 pausable contracts. EarlyWithdrawn ABI declares 4 args, handler reads 3 — `penalty` field silently dropped. No reorg/finality / confirmations setting in config. Schema mismatches and missing handlers across staking, restaking, revenue distribution, vote incentives, lending. `EpochAdvanced` is in ABI but has no handler.

### L2 readiness
- Contributing agents: 045 (L2 compat), 057 (wagmi config)
- One paragraph: 0 uses of `100dvh` in entire codebase (every full-viewport surface has the iOS overflow bug). Arbitrum L2 timestamp can lag L1 by up to ~24h — short cooldowns and reveal windows not validated against worst-case skew. TegridyTWAP and TegridyPair use `uint32(block.timestamp)` — wrap-window bypass possible on chains with high genesis offsets. NO sequencer-uptime-feed integration anywhere in the codebase. wagmi `transports` table only includes mainnet but `explorer.ts` enumerates L2s (Optimism, Base, Arbitrum, Polygon, BSC, Avalanche). `CHAIN_ID = 1` hardcoded as bare numeric literal. 22 of 25 timestamp-dependent contracts have 0 L2 coverage.

### Doc misrepresentation
- Contributing agents: 095 (docs drift), 067 (Towelie KB), 055 (static drift)
- One paragraph: FAQ.md publishes a fictitious 10% burn/buyback (no burn entrypoint on Toweli.sol) AND a fictitious 4-of-7 Gnosis Safe (NEXT_SESSION.md explicitly states multisig migration is deferred). REVENUE_ANALYSIS.md cites a contract constant `SWAP_FEE_BPS = 50` that does not exist. SECURITY.md links to an Immunefi page that 404s; bug-bounty SLA + $50k-$250k reward range published. README's "Quick start — contracts" tells users to `./scripts/redeploy-patched-3.sh`, a deleted file. DEPLOY_RUNBOOK §10 says H-2 commit-reveal "not implemented", AUDITS.md + CHANGELOG say it's live on mainnet. Boost ladder differs by 0.5× between README and TOKENOMICS for 1-year and 2-year locks. SecurityPage.tsx hard-codes deprecated v1 staking address `0x65D8…a421` (live v2 is `0x6266…4819`). ContractsPage GitHub org mismatch `tegridyfarms` vs `fomotsar-commits`. 28 doc drift findings total.

### API hygiene
- Contributing agents: 076 (auth/SIWE), 077 (ratelimit/proxy schemas), 078 (alchemy/etherscan/v1), 079 (opensea/orderbook), 080 (Supabase RLS), 081 (CORS/secrets), 082 (logging), 083 (webhooks N/A)
- One paragraph: SIWE login solid (atomic nonce-claim, HS256, HttpOnly+Secure+SameSite=Strict). HIGH gaps: X-Forwarded-For trusted unconditionally → rate-limit bypass via spoofed header; no body-size or depth-limit on JSON parsing → DoS via nested JSON; v1/index.js has NO real rate limit (cosmetic headers only); v1/index.js has NO body-size guard, NO upstream response-size cap, NO gzip-bomb defense; eth_getLogs block-range unbounded; OpenSea proxy returns full upstream response body without schema validation; orderbook `create` action forwards client-supplied seaportSignature without verifying valid on-chain Seaport order; price_eth computed via Number(BigInt × 1e8) — silent precision loss + Number(BigInt) overflow. Alchemy & Etherscan API keys interpolated into upstream URL (queryable from Vercel logs). Shared edge cache (`s-maxage=…`) on RPC response that may carry per-request data. **No webhook surface yet** (Section 9 clean).

### iOS responsive
- Contributing agents: 074 (responsive iOS/iPad), 069 (layout/loader/UI), 075 (skeletons CLS)
- One paragraph: 0 uses of `100dvh` (every full-viewport surface has iOS Safari URL bar overflow). iPad mini (744px) hits md-only breakpoint cliff — gets mobile layout including BottomNav. Nav-link desktop touch target ~30px (fails Apple HIG 44px). No defensive `overflow-x-hidden` on page containers. BottomNav clashes with iOS home indicator + TowelieAssistant overlap. OnboardingModal missing focus trap + initial focus management; backdrop tap dismisses permanently. Modal.tsx lacks focus trap; only auto-focuses dialog root. Skeleton dimensions cause guaranteed CLS / layout shift; aria-busy missing from every skeleton; infinite skeleton animation runs without prefers-reduced-motion opt-out. SwapSkeleton 480px wide vs full-width real content + tabs. 4 wrapper pages skip usePageTitle.

---

## Section 8 — False alarms refuted

### ReferralSplitter `\` vs `//` (agent 039 → refuted by 096+101)
- Agent 039 cross-flagged that `contracts/src/ReferralSplitter.sol` has literal `\` characters where `//` was intended on lines 175, 247, 249, 253, 257, 260, 261, 263 — claiming this would make the file uncompilable.
- Agent 096 (Compile & Lint Audit) and Agent 101 (Final Forensic Sweep) both verified line-by-line: all 8 flagged lines use proper `//` comment markers. No backslashes present.
- Ground-truth: `forge build --skip test` produces only `unsafe-typecast` and `asm-keccak256` lint **warnings** in TegridyStaking.sol/TimelockAdmin.sol; **zero compile errors**. ReferralSplitter.sol is not mentioned in the warning stream — file compiles cleanly.
- Likely cause: ReferralSplitter.sol uses fancy unicode characters (`─`, `→`, `—`) in comments which may have been misread as backslash artefacts in some terminal renderings, but the actual file bytes use standard `//` markers throughout.
- **REFUTED.** No CRITICAL build-blocker exists.

### Other contradictions noted by agent 100
- C-7 (TegridyStaking multi-position-per-holder): 005 M-005-04 (MEDIUM, _clearPosition overwrites userTokenId for multi-position holders) vs 015 H-2 (assumes single-position model). Architectural conflict — flagged for product-owner decision.
- C-8 (claimFees reentrancy): 004 M-1 MEDIUM vs 029 ATTACK PATH 4 LOW (mitigated by Uniswap V4 lock). Adjudication: downgrade 004 M-1 to LOW.
- C-9 (feeTo race during 48h timelock): 001 M-7 (assumes malicious feeToSetter). If multisig is in place per Wave 0 acceptance, downgrade to LOW.
- C-10 (TegridyNFTPool spotPrice update ordering): 008 H-2 vs 029 ATTACK PATH 5 MEDIUM. Settle on HIGH.
- C-13 (POLAccumulator spot-vs-TWAP): 021 H-1 (HIGH) vs 032 M-4 (MEDIUM). Settle on HIGH.
- C-14 (TegridyRouter MAX_DEADLINE): 002 L-2 (LOW) vs 031 M-1 (MEDIUM) vs 025 L-1 (LOW). Settle on MEDIUM.
- C-16 (skeleton aria-busy missing): 075 F-3 (HIGH a11y). Adjudication: downgrade to MEDIUM (a11y, not security).
- C-17 (localStorage NOT wallet-namespaced): 054, 058, 071 all flag similar root cause; merge into one HIGH.
- C-19 (aggregator silently overwrites user minOut): 047 H-01 + 061 H-1 are facets of same race. Merge as one HIGH.

---

## Section 9 — Clean-bill-of-health zones

### Approval/allowance posture (030)
- 0 raw `.approve(` calls. 16 `forceApprove(` (USDT-safe). 0 long-lived non-zero allowances (every `forceApprove(addr,X)` paired with reset `forceApprove(addr,0)`). 0 `permit(` invocations anywhere. 0 `setApprovalForAll`. 0 `type(uint256).max` allowances. Zero live exploit paths.

### Signature replay (042)
- 0 HIGH/MED/LOW/INFO findings. Surface inventory: Toweli (OZ ERC20Permit / EIP-2612, chain-id-safe via OZ EIP712 rebuild); GaugeController (commit-reveal, no signatures); VoteIncentives (commit-reveal + bond); TegridyDropV2 (Merkle allowlist double-hashed); other contracts none.
- Audit checks all PASSED: chainid in DOMAIN_SEPARATOR; nonce hygiene; ECDSA s-malleability; ecrecover zero-return; multi-contract domain reuse; deadline; **off-chain authority key (NONE EXIST)**; signed-amount vs param mismatch.

### Gas griefing caps (041)
- HIGH 0 / MEDIUM 1 (RevenueDistributor MAX_CLAIM_EPOCHS=500 acceptable) / LOW 2 / INFO 5. All ETH-forwarding `.call{}` use explicit gas stipends. No return-data bomb surface. Strong, consistent application of explicit caps (`MAX_*`), gas stipends, and pull-pattern fallbacks.

### Storage layout (097)
- Both Clones implementations (TegridyDropV2, TegridyNFTPool): 51 storage slots in use; 0 collisions; 0 diamond conflicts; 0 missing __gap (justified for EIP-1167); 0 packed-struct misalignments; 0 private-shadowed-by-parent reads; 0 wrong constant/immutable choices. Both implementations correctly call `_disableInitializers()` in their constructor.

### SIWE auth (076)
- CRITICAL 0; SIWE design fundamentally sound: HS256 pinned, atomic nonce-claim via DELETE-then-verify, HttpOnly+Secure+SameSite=Strict cookie, 24h fixed expiry no rolling refresh, jose `algorithms: ["HS256"]` rejects alg=none. Replay protection correct.

### Supabase RLS (080)
- HIGH 0; INSERT policies all carry WITH CHECK; proxy correctly uses anon key never service-role; JWT verification HS256 with issuer:"supabase", audience:"authenticated"; wallet-authn / RLS auth.uid() mismatch NOT present (RLS reads `current_setting('request.jwt.claims', true)::json->>'wallet'`); ALL TO authenticated not used anywhere.

### Webhook surface (083 — none = clean)
- NO INCOMING WEBHOOK SURFACE. Frontend/api exposes zero third-party webhook receivers. The audit hunt list (HMAC absent, timing attack, replay nonce, idempotency-key, out-of-order delivery, DLQ, 5xx retry, IP allow-list) is structurally not applicable. 0 critical/high/medium/low findings.

### Toweli token (016)
- HIGH 0 / MED 0 / LOW 2 / INFO 6. Fixed-supply, no-admin design self-documenting and matches tests. No mint/burn/owner/pause/blocklist surface. Fee whitelist drift / FoT N/A by design. ERC-20 return-value compliance via OZ. Decimals immutable 18.

### ParticleBackground (070)
- INFO I-1 — exemplary: pauses on visibilitychange (line 194-203), respects `prefers-reduced-motion` with live update (line 73-98), throttles resize (line 123-126), uses delta-time animation (line 142-145). No issues found.

---

## Section 10 — Statistics & coverage map

### Total findings by severity (HIGH/MED/LOW/INFO)
Approximate aggregate (after consolidation noted by agent 100):
- HIGH (consolidated, dedup'd): **~80** before merging (Section 7 root-cause merges reduce to ~20-25 protocol-wide HIGHs in MASTER_REPORT executive view).
- MEDIUM (estimate after merging): **~250-300**.
- LOW (estimate after merging): **~280**.
- INFO (estimate): **~220**.
- Test gaps recommended: **~250+** scenarios across all agents.

### Per-agent counts table
| Agent | Target | HIGH | MED | LOW | INFO |
|------:|--------|-----:|----:|----:|-----:|
| 001 | TegridyPair.sol | 3 | 7 | 7 | 3 |
| 002 | TegridyRouter.sol | 0 | 3 | 6 | 5 |
| 003 | TegridyFactory.sol | 1 | 4 | 5 | 6 |
| 004 | TegridyFeeHook.sol | 2 | 4 | 4 | 4 |
| 005 | TegridyStaking.sol | 2 | 4 | 5 | 4 |
| 006 | TegridyLending.sol | 3 | 6 | 6 | 6 |
| 007 | TegridyNFTLending.sol | 0 | 0 | 6 | 12 |
| 008 | TegridyNFTPool.sol | 3 | 6 | 5 | 4 |
| 009 | TegridyNFTPoolFactory.sol | 0 | 5 | 8 | 7 |
| 010 | TegridyLPFarming.sol | 3 | 7 | 5 | 11 |
| 011 | TegridyDropV2.sol | 1 | 3 | 4 | 4 |
| 012 | TegridyLaunchpadV2.sol | 0 | 3 | 5 | 6 |
| 013 | TegridyTWAP.sol | 3 | 5 | 4 | 3 |
| 014 | TegridyTokenURIReader.sol | 0 | 2 | 4 | 5 |
| 015 | TegridyRestaking.sol | 3 | 7 | 8 | 7 |
| 016 | Toweli.sol | 0 | 0 | 2 | 6 |
| 017 | VoteIncentives.sol | 3 | 4 | 4 | 5 |
| 018 | GaugeController.sol | 1 | 4 | 5 | 5 |
| 019 | CommunityGrants.sol | 3 | 7 | 7 | 3 |
| 020 | MemeBountyBoard.sol | 1 | 7 | 8 | 8 |
| 021 | POLAccumulator.sol | 2 | 5 | 5 | 7 |
| 022 | PremiumAccess.sol | 2 | 8 | 8 | 12 |
| 023 | ReferralSplitter.sol | 0 | 5 | 7 | 5 |
| 024 | RevenueDistributor.sol | 3 | 8 | 6 | 6 |
| 025 | SwapFeeRouter.sol | 3 | 5 | 6 | 5 |
| 026 | OwnableNoRenounce.sol | 0 | 3 | 4 | 5 |
| 027 | TimelockAdmin.sol | 2 | 5 | 7 | 5 |
| 028 | WETHFallbackLib.sol | 1 | 5 | 4 | 5 |
| 029 | CrossContractReentrancy | 7 ATTACK PATHS (mixed sev) | | | |
| 030 | ApprovalAllowance | 0 | 0 | 1 | 2 |
| 031 | SlippageMEV | 4 | 6 | 3 | 6 |
| 032 | OracleTWAP | 3 | 5 | 5 | 4 |
| 033 | FeeOnTransfer | 0 | 2 | 5 | 6 |
| 034 | InitProxy | 1 | 3 | 4 | 5 |
| 035 | TestHoles | qualitative — 60 files reviewed | | | |
| 036 | FuzzInvariants | 17 missing HIGH invariants; 13 MED | | | |
| 037 | DeployScripts | 8 | 19 | 16 | — |
| 038 | ConstructorImmutables | 2 | 1 | mix | — |
| 039 | Events | 5 | 6 | 5 | 4 |
| 040 | ERCStandards | 0 | 0 | 5 | mix |
| 041 | GasGriefing | 0 | 1 | 2 | 5 |
| 042 | SignatureReplay | 0 | 0 | 0 | 4 |
| 043 | AdminKeys | (qualitative blast-radius) | | | |
| 044 | Pause | 2 | 3 | 3 | 2 |
| 045 | L2Compat | 3 | 5 | 5 | — |
| 046 | HomeDashboard | 1 | 5 | 6 | 3 |
| 047 | TradeSwap | 3 | 8 | 5 | 3 |
| 048 | FarmPage | 4 | 7 | 6 | 4 |
| 049 | LendingPage | 4 | 7 | 5 | 2 |
| 050 | PremiumPage | 0 | 0 | 3 | 3 |
| 051 | AdminPage | 1 | 3 | 4 | 3 |
| 052 | ArtStudio | 2 | 4 | 4 | 3 |
| 053 | CommunityPage | 1 | 4 | 4 | 0 |
| 054 | Leaderboard | 4 | 6 | 5 | 4 |
| 055 | StaticDrift | 7 | 9 | 6 | 8 |
| 056 | LiveTowelie | 0 | 1 | 3 | 6 |
| 057 | WagmiConfig | 0 | 3 | 4 | 4 |
| 058 | HistoryActivity | 1 | 5 | 6 | 4 |
| 059 | Gallery | 4 | 5 | 4 | 3 |
| 060 | Treasury | 0 | 3 | 8 | 3 |
| 061 | HooksSwap | 5 | 9 | 7 | 4 |
| 062 | HooksPoolFarm | 4 | 9 | 7 | 5 |
| 063 | HooksGov | 4 | 9 | 7 | 6 |
| 064 | HooksMisc | 3 | 6 | 5 | 4 |
| 065 | LibAggStorage | 1 | 5 | 5 | 4 |
| 066 | LibErrAnalytics | 1 | 4 | 4 | 3 |
| 067 | LibPointsBoost | 0 | 5 | 4 | 4 |
| 068 | LibTxErrors | 2 | 4 | 4 | 3 |
| 069 | Layout | 4 | 7 | 6 | 4 |
| 070 | ChartCommunity | 1 | 4 | 4 | 3 |
| 071 | WidgetsMisc | 1 | 5 | 6 | 4 |
| 072 | LaunchpadComp | 1 CRITICAL+3 | 5 | 4 | 2 |
| 073 | AppRoot | 1 | 4 | 4 | 2 |
| 074 | Responsive | 5 device-specific (HIGH first) | | | |
| 075 | Skeletons | 3 | 2 | 5 | 2 |
| 076 | AuthSiwe | 1 | 3 | 4 | 4 |
| 077 | Ratelimit | 2 | 2 | 2 | — |
| 078 | ApiV1Alchemy | 4 | 6 | 5 | 4 |
| 079 | OpenseaOrderbook | 3 | 6 | 4 | 4 |
| 080 | SupabaseRLS | 0 | 3 | 4 | 5 |
| 081 | CorsSecrets | 0 | 2 | 3 | 1 |
| 082 | Logging | 0 | 0 | 4 | (qualitative) |
| 083 | Webhooks | 0 | 0 | 0 | 0 (no surface) |
| 084 | Indexer | 5 | 7 | 4 | 3 |
| 085 | GhWorkflows | 2 | 3 | 4 | 7 |
| 086 | VercelCSP | 1 | 3 | 2 | 5 |
| 087 | BuildScripts | 0 | 3 | 4 | 3 |
| 088 | E2ETests | 3 | 4 | 4 | 3 |
| 089 | TypeSafety | 0 (5 highest-risk type holes) | | | |
| 090 | ErrorHandling | 1 | 4 | 6 | 4 |
| 091 | DeadCode | (12 dead pages + 3 V1 + 1 .bak) | | | |
| 092 | V1V2Drift | 0 runtime; 4 dead V1 source files; 866 LOC | | | |
| 093 | AbiDrift | 1 CRITICAL+2 | 1 | — | — |
| 094 | AddressConsistency | 2 HIGH + 2 MED + 2 LOW | | | |
| 095 | DocsDrift | 4 CRIT+7 HIGH | 9 | 6 | 8 (incl. verify-with-user 2) |
| 096 | Compile | qualitative; refutes 039 | | | |
| 097 | StorageLayout | 0 | 0 | 2 | 5 |
| 098 | BundleSize | 3 | 6 | mix | mix |
| 099 | SeoMeta | 3 | 5 | 4 | 3 |
| 100 | CrossCheck | 20 contradictions adjudicated | | | |
| 101 | FinalSweep | 0 (refutes 039; 100% coverage confirmed) | | | |

### Coverage confirmation per agent 101
**152 source files audited; 0 orphans across 6 target directories; 100% coverage:**
- contracts/src/ (28 files): all covered by agents 001-028 + cross-cutting 029-045.
- frontend/src/pages/ (25 files): all covered.
- frontend/src/hooks/ (50 entries incl. tests): all covered.
- frontend/src/lib/ (36 entries incl. tests): all covered.
- frontend/api/ (12 entries incl. tests): all covered.
- indexer/src/ (1 entry): covered by agent 084.

The 101-agent forensic audit achieved full surface coverage. No module slipped through; the corpus is closed.

— end of detailed report —
