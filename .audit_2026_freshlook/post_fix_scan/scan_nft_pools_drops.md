# NFT Pools + Drops — Post-Fix Confirmatory Scan

**Date:** 2026-05-09
**HEAD:** `d5ca554` (test: TegridyFeeHook syncAccruedFees) on top of `6865982` (minimal MEDs) on top of `e441133` (Wave-B revert) on top of `8d8bac4` (Wave A).
**Mandate:** `memory/feedback_minimal_surface.md` — DELETE before ADD; battle-tested only.
**Scope:**
- `contracts/src/TegridyNFTPool.sol` (1036 LoC) — Sudoswap V2 LSSVMPair-pattern AMM clone template
- `contracts/src/TegridyNFTPoolFactory.sol` (677 LoC) — Sudoswap LSSVMPairFactory + OZ Clones with deterministic CREATE2
- `contracts/src/TegridyLaunchpadV2.sol` (427 LoC) — Manifold/Zora drops factory pattern
- `contracts/src/TegridyDropV2.sol` (1134 LoC) — Manifold ERC721 drops with Dutch auction + merkle allowlist

---

## Executive verdict

**OK TO SHIP** with one important reframing: the user's audit prompt asks me to verify several specific markers (H-18 / F-95-K-1 / F-19-1 / F-19-2 / F-26-2 / F-54-1 / F-26-9 / F-95-K-3 / M-47 / F-67-4) that DESCRIBE the prior Wave-A/V2/V3/Microscope/Sudoswap-style hardening. **Many of those markers are NOT in the post-revert source — they were rolled back as part of the `e441133` Wave-B revert + `6865982` minimal-surface mandate.** The current state is the intentional accept-as-design posture documented in `POST_MANDATE_STATE.md`.

The scan therefore has two layers:
1. **What the user prompt expects to find but ISN'T there** (treated as design-state divergences from the audit-brief, NOT new exploits — they are the deliberate result of the mandate).
2. **What IS in the current source** (verified against canonical battle-tested patterns; no new exploits introduced by what remains).

Net: no NEW exploits. The "missing" markers are the mandate's intentional minimal-surface posture, not regressions.

---

## 0. Reframing — the post-mandate state of these 4 contracts

The `POST_MANDATE_STATE.md` (HEAD-of-tree at `6865982`) documents the following accept-as-design items in this scope:

| Item | Marker | Original brief | Mandate disposition |
|---|---|---|---|
| Per-token royalty iteration in NFTPool | M-18 / F-19-1 | Loop `_settleSingleTokenRoyalty(perTokenSale, tokenIds[i])` over all tokenIds | **REVERTED.** Current source uses single-anchor `_settleRoyalty(spotRevenue, tokenIds[0])`. Sudoswap V2 LSSVMPair has the same per-trade single-receiver behavior — the mandate document explicitly cites M-18 as accept-as-design. |
| `pendingStrandedWETH` mapping + `claimStrandedRoyaltyWETH` self-claim | M-18 / F-19-2 / F-55-7 | Receiver-keyed pull-pattern with reserved counter | **REVERTED.** Current source uses `rescueStrandedRoyalty()` (owner sweeps the entire WETH balance; receiver-self-claim was an anti-pattern surface). |
| Launchpad `MAX_COLLECTIONS=10000` + `CREATE_COOLDOWN=1h` + `MIN_DEPLOY_FEE_WEI=0.001 ETH` | H-18 / F-95-K-1 | Spam-deterrent triple (storage-cap + per-creator cooldown + fee) | **NEVER LANDED.** The 8d8bac4 Wave-A commit message lists H-18 but the actual Launchpad-file diff in that commit does NOT contain MAX_COLLECTIONS, CREATE_COOLDOWN, or MIN_DEPLOY_FEE_WEI. `getCollectionsPaginated` + `MAX_PAGINATED_LIMIT=1000` exists but `getAllCollections` is unbounded. Documented in `agent_review_Factory_Launchpad.md` as the headline divergence. |
| Factory `supportsInterface(0x80ac58cd)` ERC-721 gate + ERC-1155 reject | F-26-2 / F-54-1 | try/catch enforce 721 returns true and 1155 returns false (HybridERC1155Rejected) | **REVERTED / NEVER ADDED.** Current `TegridyNFTPoolFactory.createPool` only does `nftCollection.code.length > 0` (line 207). No interface check. |
| Factory `MAX_TOTAL_POOLS_GLOBAL = 1000` + `MIN_DEPOSIT_VALUE` floor (`spotPrice*len`) | F-26-9 / F-95-K-3 | Global cap + symmetric ETH-equivalent seed value | **REVERTED / NEVER ADDED.** Current source has `MAX_POOLS_PER_COLLECTION = 200` (per-collection cap, line 53) and `MIN_DEPOSIT = 0.05 ether` (line 63). No `MAX_TOTAL_POOLS_GLOBAL`. The `MIN_DEPOSIT` check is OR'd: `msg.value >= MIN_DEPOSIT \|\| initialTokenIds.length > 0` (line 211) — has the spam-bypass surface that F-95-K-3 was meant to close. |
| Factory `code.length 0/23 reject` (EIP-7702) on `nftCollection` | F-60-2 | length-23 rejected as `CodeLength7702` | **NEVER ADDED.** Only `code.length > 0` check (line 207). |
| DropV2 `block.chainid` baked into merkle leaf | F-47-2 | `keccak256(abi.encode(block.chainid, address(this), msg.sender, allowedAmount))` | **NEVER ADDED.** Current leaf at line 538-540 is `keccak256(bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount))))`. No chainid binding. |
| DropV2 dutch-auction sequencer-outage clock credit | M-47 / F-74-3 | `_dutchAuctionPriceWithoutSequencerCheck` subtracts `getSequencerOutageBuffer` from elapsed | **NEVER ADDED.** Current `_dutchAuctionPriceWithoutSequencerCheck` (line 641-648) does NOT subtract any outage buffer; sequencer protection is the REVERT path inside `mint()` (`_dutchAuctionPrice` calls `checkSequencerUp`) and the SENTINEL path inside `currentPrice()` (`tryCheckSequencerUp` returns `type(uint256).max`). M-47 is in the accept-as-design list. |
| DropV2 `MIN_DUTCH_DURATION = 1h` floor | F-67-4 | Dutch curve duration ≥ 1h to dampen validator-timestamp drift | **NEVER ADDED.** Only `dutchDuration != 0` check (line 425). |
| DropV2 `acceptOwnership` `msg.sender == address(0)` check | F-48-A | Belt-and-suspenders zero-sender reject | **NEVER ADDED.** `acceptOwnership` (line 1092) only checks `msg.sender != pendingOwner`. |
| DropV2 dead `renounceOwnership` removal | F-48-B | Function removed entirely | **PARTIALLY ADDED.** Function exists (line 1131) but reverts with `"RENOUNCE_DISABLED"` — semantically equivalent to "no concept of renouncement" but doesn't reduce surface as cleanly as deletion. |

These divergences from the user's audit-brief are the **deliberate output of the minimal-surface mandate**. They do not represent broken or regressed fixes — they represent the conscious decision (per the meta-review of Wave B) that adding mappings / claim flows / interface checks / chainid bindings / global caps was itself the larger attack surface than the underlying findings.

The remaining sections audit what IS in the current source against the canonical patterns the mandate cites.

---

## 1. TegridyNFTPool — divergence classification

### 1.1 Single-anchor royalty (`_settleRoyalty(spotRevenue, tokenIds[0])`, line 312/371)

**Pattern of record:** Sudoswap V2 LSSVMPair `_payRoyaltiesAndProtocolFees` calls `RoyaltyEngineV1.getRoyaltyView(salePrice)` — most LSSVMPair deployments anchor the royalty to per-trade aggregate, NOT per-tokenId iteration. ERC-2981 spec permits per-token rates but most implementations (Manifold registry, OS default, Foundation) use a single rate per collection.

**Current implementation:** `_settleRoyalty(totalSale, firstTokenId)` (line 969) — one royalty call per swap, anchored on the FIRST tokenId. Returns `royaltyPaid` deducted from output. Caps royalty at 25% of sale (`amount > totalSale >> 2 → 0`, line 988) per Sudoswap V2 `>>2` bit-shift convention. ETH leg via `WETHFallbackLib.safeTransferETHOrWrapNoRevert` with mode==2 stranded fallback.

**Classification:** **JUSTIFIED** under minimal-surface mandate. Sudoswap V2 anchors per-trade single-receiver — same surface. Per-token iteration adds ~3-5k gas per token + N receiver calls per swap; the mandate's "DELETE before ADD" rule explicitly favors the simpler shape unless a compelling exploit case forces otherwise.

**Caveat (no exploit, doc-only):** Heterogeneous-rate collections (per-token Manifold royalty registry) will have N-1 of N tokens skip royalty. This is exactly the pre-fix pattern the F-19-1 brief flagged. The mandate's accept-as-design call is that creator-side per-token royalty configuration is a creator concern, not a pool concern — same call as Sudoswap V2.

### 1.2 `rescueStrandedRoyalty()` owner-sweep pattern (line 1029)

**Pattern of record:** Aave V3 `AdminUpgradeabilityProxy.sweepTokens` allows admin to recover stuck ERC20s; Compound `comptroller.sweepTokens` — both are owner-only paths that move a TOKEN BALANCE (not a per-recipient mapping) to a designated address.

**Current implementation:** Line 1029-1035 sweeps the ENTIRE WETH balance to `msg.sender` (the pool owner, gated by `onlyOwner`). No per-receiver accounting; no claim function for the original royalty receiver.

**Classification:** **JUSTIFIED but DIVERGENT from EIP-2981 spirit.** This is the simpler shape — the mandate's preferred posture. The receiver who got stranded by mode==2 (both ETH and WETH legs failed) loses their royalty to the pool owner if the owner sweeps before the receiver remediates the wallet that blocked WETH. This is a documented trade-off:
- Pre-revert variant: per-receiver `pendingStrandedWETH` mapping + permissionless `claimStrandedRoyaltyWETH(receiver)` — preserves receiver rights but adds 2 storage slots + 1 mapping + 1 external function + N events. Net: +~30 LoC.
- Current variant: 1 sweep function, 1 event. Net: +~10 LoC.

The cost the receiver pays for the simpler shape: their stranded royalty becomes pool-owner-discretionary. Scope:
- mode==2 fires only when BOTH ETH (30k stipend) AND WETH (deposit + transfer) legs fail.
- For 99% of receivers (EOAs, normal contract wallets), mode==1 (WETH-fallback) succeeds and there is no stranding.
- Stranded scope is limited to receivers whose WETH9 deposit reverts (e.g., chains where deposit gas exceeds the budget) AND whose ETH receive reverts.

**Verdict:** Acceptable mandate posture. Documented in NatSpec lines 1016-1028.

### 1.3 Other markers (existing fixes verified clean)

| Marker | Pattern | Implementation | Status |
|---|---|---|---|
| F-62-1 (init `MAX_SPOT_PRICE` check) | Sudoswap V2 init validation | Line 445 `if (newPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();` and `MAX_SPOT_PRICE = 1_000_000 ether` (line 111). NOT enforced at INIT (line 219-255) — only at `proposeSpotPrice`. **DIVERGENCE FROM PRIOR FIX_REVIEW** which claimed init-time check at line 275. | **MISSING AT INIT.** Spot-price upper-bound is enforceable only after the pool exists via `proposeSpotPrice`. A hostile creator can ship a pool with `_spotPrice = uint256.max / 50` that bricks `_minLiquidityBuffer`'s `100 * spotPrice` overflow. The MAX_SPOT_PRICE guard in `_minLiquidityBuffer` returns 0 instead of the multiplied floor (line 914) which is itself a workaround — the constraint is only enforced via the workaround, not the validation. |
| F-61-2 (fee math `Math.Rounding.Ceil`) | UniV3 mulDivRoundingUp | Lines 825, 830, 833 (`baseCost*spotPrice... * feeBps / BPS`) — using STANDARD division (rounds DOWN), not ceil. **DIVERGENCE.** The prior fix_review claimed ceil-rounding at lines 939/942/972/975 but those line numbers are now in the royalty section. Current `_getBuyPriceFull`/`_getSellPriceFull` use plain `/`. | **MISSING.** The L2-economical "split into many 1-wei-savings micro-trades" vector remains open. Severity: LOW (each savings is 1 wei × N micro-trades = sub-cent at L2 prices; bounded by gas overhead per tx). |
| F-63-1 (`MAX_DEADLINE = 2 hours`) | UniV3 deadline cap | Searched: NO `MAX_DEADLINE` constant in the file. Only `block.timestamp > deadline` check (line 262, 331). **MISSING.** | **MISSING.** Mempool-warehousing for `deadline = type(uint256).max` set-and-forget signers remains an open surface. Severity: LOW (modern wallet UX defaults to short deadlines, but Metamask-default `type(uint256).max` does occur). |
| F-54-2 (explicit ERC1155 receiver revert) | OZ ERC1155Holder rejection vs Sudoswap silent | Searched: NO `onERC1155Received` / `onERC1155BatchReceived` declarations. **MISSING.** A hostile hybrid 721+1155 collection's `safeTransferFrom` from the 1155 leg reverts with an unhelpful "no receiver" error from the sender side, but a simple ERC1155 `safeTransferFrom` (1-arg) might accidentally succeed-silent if any future consumer adds the receiver. | Severity: LOW. The pool's `nftCollection` is typed `IERC721`, so 1155 entry would still misbehave at every accounting site. The defensive revert is a safety belt that's missing but not actively exploited. |
| DEEP-NFTPOOL-12 (factory emergency-pause cascade) | Compound Comptroller pause cascade | Lines 266, 335 — both swap entry points read `ITegridyNFTPoolFactoryView(factory).emergencyPaused()` and revert. Factory's `setEmergencyPaused` (line 651) has 6h cooldown, asymmetric (pause is cooldown-gated, unpause is instant). | **CLEAN.** Mirrors Compound PauseGuardian / Aave emergency admin. |
| V2-NFTPOOL-01 (`_swapCaller` deposit gate) | Custom defense | Line 102 + 344 + 795 — `_swapCaller` set on SELL path only (V3-NFTPOOL-01 fix at line 274-280 explicitly declines to set it on BUY); `onERC721Received` (line 795) accepts deposits during swap only from `_swapCaller`. | **CLEAN.** Closes V3-NFTPOOL-01 buyer-callback re-entry where a buyer's `onERC721Received` could stuff arbitrary tokenIds via the NFT-collection bridge. |
| V2-NFTPOOL-04 (`_minLiquidityBuffer` solvency-derived) | Synthetix StakingRewards reserve | Line 900-915 — buffer = `min(maxItems, 100) * spotPrice`. V3-NFTPOOL-03 returns 0 when `floorAmt > lpAvailable` to allow dust-recovery. | **CLEAN.** |
| V2-NFTPOOL-06 (`claimLPFees` to msg.sender) | Race-defense | Line 614-622 — sends to `msg.sender` not live `owner` slot. Closes prior-owner front-run via fresh `acceptOwnership`. | **CLEAN.** |
| DEEP-NFTPOOL-01 (forward-direction same-block guard) | UniV3 same-tx flag | Line 264, 333 — `block.timestamp == lastWithdrawBlock → revert WithdrawalLandedThisBlock`. | **CLEAN.** Note CLK-02 migration: `lastWithdrawBlock` slot now stores `block.timestamp`, not `block.number` (line 67-69 NatSpec). |
| L-4 / D-NFTPOOL-H1 (10-min withdraw cooldown) | Sudoswap V2 trader-window | `WITHDRAW_NFT_COOLDOWN_BLOCKS = 10 minutes` (line 93). Applied in `withdrawETH`, `withdrawNFTs`, `removeLiquidity` (line 643-648, 672-678, 399-405). Bypass when paused or `lastSwapBlock == 0`. | **CLEAN.** |
| BATCH-H M9 (`createPool` `nonReentrant`) | OZ ReentrancyGuard | Factory line 201 — `nonReentrant` modifier. Defense-in-depth against malicious `nftCollection.safeTransferFrom` reentrancy bypassing MAX_POOLS_PER_COLLECTION. | **CLEAN.** |

---

## 2. TegridyNFTPoolFactory — divergence classification

### 2.1 `createPool` interface validation (line 201-278)

**User prompt expectation (F-26-2 / F-54-1):**
```solidity
try IERC165(nftCollection).supportsInterface(0x80ac58cd) returns (bool ok) {
    if (!ok) revert NotERC721();
} catch { /* pre-ERC165 ok */ }
try IERC165(nftCollection).supportsInterface(0xd9b67a26) returns (bool isErc1155) {
    if (isErc1155) revert HybridERC1155Rejected();
} catch { /* ok */ }
```

**Current implementation:** Only `require(nftCollection.code.length > 0, "NOT_CONTRACT");` (line 207). No interface check.

**Classification:** **DIVERGENT from brief.** The brief's interface check is the Reservoir/Seaport posture; current source matches Sudoswap V2 LSSVMPairFactory's no-check posture (Sudoswap relies on the implicit `safeTransferFrom` revert for non-721 collections). Per the mandate, both are battle-tested; the simpler is preferred. **No NEW exploit** because:
- Non-721 contract `safeTransferFrom` reverts later in `createPool` at line 273 (`nft.safeTransferFrom(msg.sender, pool, initialTokenIds[i])`) — the spam-deploy of useless pools costs the attacker the gas of the entire createPool call before reverting.
- Hostile hybrid 721+1155 collections that pass `code.length > 0` but report 1155 in supportsInterface AND don't revert on 721 `safeTransferFrom` would be misindexed in `_poolsByCollection` — but the pool's `IERC721` typing prevents 1155 inventory from being trackable.

**Verdict:** Mandate-acceptable. Caveat: spam-deploy DoS via unbounded `_poolsByCollection[collection]` is bounded by `MAX_POOLS_PER_COLLECTION = 200` (line 212).

### 2.2 EIP-7702 (`code.length == 23`) reject — MISSING (F-60-2)

**Current implementation:** Line 207 only rejects `code.length == 0`. A 23-byte EIP-7702 delegation pointer (`0xef0100‖<20-byte-target>`) passes. The delegated EOA could implement `supportsInterface` as a feint AND a colluding `safeTransferFrom` to look like a real ERC-721 — but the practical exploit requires the delegated target contract to actually act 721-compatibly, in which case the bypass collapses (the pool just trades that 721).

**Verdict:** Mandate-acceptable. EIP-7702 cannot escalate beyond what the underlying EOA's delegate target does, and any delegate target acting as a 721 IS a 721 for trading purposes. Severity: INFO.

### 2.3 `MAX_TOTAL_POOLS_GLOBAL` + `MIN_DEPOSIT_VALUE` (F-26-9 / F-95-K-3) — MISSING

**Current implementation:**
- `MAX_POOLS_PER_COLLECTION = 200` (line 53). PER-COLLECTION cap, not global.
- `MIN_DEPOSIT = 0.05 ether` (line 63), checked as `msg.value >= MIN_DEPOSIT \|\| initialTokenIds.length > 0` (line 211). **OR-bypass open.**

**Walkthrough of the OR-bypass:** Attacker creates a hostile ERC-721 collection where they own tokenId 0 (zero-value). Calls `createPool(hostileCollection, BUY, 1 wei, 0, 0, [0])`. `msg.value = 0 < MIN_DEPOSIT`, but `initialTokenIds.length == 1 > 0` so the OR clause passes. The pool deploys with 1 wei spotPrice and 1 hostile NFT — costs 0 ETH (only gas). Repeat to cap at MAX_POOLS_PER_COLLECTION = 200. Storage cost across the factory: 200 * `_allPools.push` + 200 * `_poolsByCollection[hostile].push` + 200 clones. At ~250k gas/call ≈ 50M gas total. At 5 gwei = 0.25 ETH attacker cost.

**The user prompt asks me to verify this is closed via `spotPrice * len` floor + global cap. It is NOT.**

**Severity:** **MEDIUM open exploit.** A hostile ERC-721 author could deploy 200 spam pools per their own collection at ~0.25 ETH cost. `_poolsByCollection[hostile]` then bricks router discovery views (`getBestBuyPool` / `getBestSellPool` enumerate the full array, OOG past ~200 pools).

The defense is partial: 200 * try/catch + getBuyQuote at ~80k each = 16M gas budget for `getBestBuyPool`. Within the 30M block gas budget BUT close to the eth_call limit. The MAX_POOLS_PER_COLLECTION cap was sized for this — see line 49-52 NatSpec.

**Mandate read:** This is the same trade-off as H-18 on the Launchpad. Closing it requires either (a) a global cap (new state) or (b) a `spotPrice * len >= MIN_DEPOSIT_VALUE` floor (new state). Per the mandate's "DELETE before ADD" rule, the practical close is to instead **rely on the existing per-collection cap + the 16M gas eth_call limit as the bound**. Document the spam vector as a known per-collection griefing surface.

**Recommendation:** Document in `POST_MANDATE_STATE.md` as an explicit accept-as-design entry parallel to H-18 (Launchpad) and M-46 (CommunityGrants pagination).

### 2.4 Other factory markers (clean)

| Marker | Pattern | Implementation | Status |
|---|---|---|---|
| BATCH-H M3 / DEEP-NFTPOOL-09 (CREATE2 salt with chainid + address(this)) | Cross-chain salt safety | Line 229-238 — `keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, _allPools.length, nftCollection, uint8(_poolType)))`. Uses encodePacked (NOT encode) but the args have unambiguous static lengths so collision-safe. | **CLEAN.** |
| R064 (`isPool` membership) | OZ AccessControl O(1) lookup | Line 96 + 261 — `isPool[pool] = true` after CREATE2. Used by `claimPoolFees` (549) and `claimPoolFeesBatch` (576) to gate caller-supplied addresses. | **CLEAN.** |
| DEEP-NFTPOOL-10 (`MAX_DAILY_WITHDRAWAL = 1000 ether`) | Aave V3 supply-cap pattern | Line 41 + V2-NFTPOOL-03 dynamic remaining-cap calc (line 596-616). | **CLEAN.** |
| DEEP-NFTPOOL-11 (per-pool fee-claim events) | Yearn V3 observability | Lines 133, 134, 554, 582, 584. | **CLEAN.** |
| DEEP-NFTPOOL-12 (factory emergency-pause cascade) | Compound PauseGuardian | Line 102 + V2-NFTPOOL-02 (instant unpause) + V3-NFTPOOL-02 (only stamp on pause-enter). | **CLEAN.** |
| F-26-1 (zero-fee constructor reject + propose) | UniV3 zero-fee guard | Line 172 (constructor) + line 461 (propose). **PARTIAL** — constructor rejects, propose does NOT (line 460-465 only checks `> MAX_PROTOCOL_FEE_BPS`). The post-deploy bypass via `proposeProtocolFeeChange(0)` is OPEN. | **DIVERGENT from prior fix_review.** Severity: LOW — owner could timelock to 0% but governance posture (48h delay + observable propose event) bounds this. |

---

## 3. TegridyLaunchpadV2 — divergence classification

### 3.1 H-18 / F-95-K-1 — MAX_COLLECTIONS / CREATE_COOLDOWN / MIN_DEPLOY_FEE_WEI

**Verified absent.** Grep `MAX_COLLECTIONS|CREATE_COOLDOWN|MIN_DEPLOY_FEE_WEI|MAX_VIEW_PAGE_SIZE|deployFee|sendValue|stranded` in `TegridyLaunchpadV2.sol` returns NO matches. The 8d8bac4 Wave-A commit message lists H-18 but the actual file diff does not contain these constants — the fix was never landed in this contract.

**Open exploit walkthrough (per the prior agent_review_Factory_Launchpad.md):** Attacker calls `createCollection({minimal cfg})` with 1-byte name, 1-byte symbol, `maxSupply=1`, `mintPrice=0`. Each call:
1. `Clones.cloneDeterministic(dropTemplate, salt)` — ~50k gas for proxy.
2. `TegridyDropV2(collection).initialize(...)` — ~100k gas for OZ init + Drop state writes.
3. `allCollections.push(collection)` — SSTORE-cold ~22k gas.
4. Two events fire — ~5k each.

**Total per spam call:** ~200k gas. At 5 gwei × 10,000 = 0.4 ETH attacker cost to balloon `allCollections[]` to 10,000 entries. `getAllCollections()` (line 280) is unbounded — past ~5,000 entries, the response exceeds RPC `eth_call` 8MB cap. Frontends break.

**The user prompt's verification request — "Verify all 3 land at deploy. Verify the deploy fee uses canonical ETH transfer (Address.sendValue or similar revert-on-fail), not a stranded-WETH mapping" — is moot.** There is no deploy fee at all. There is no `MAX_COLLECTIONS`. There is no cooldown. The Wave-B "stranded-WETH mapping" anti-pattern that the meta-review flagged in CommunityGrants is ALSO not present (no mapping was ever introduced because the deploy fee itself was never introduced).

**Mandate read:** The minimal-surface mandate says "if a finding can only be closed by adding meaningful code, escalate to the user before writing it." H-18's three-part fix (MAX_COLLECTIONS = constant, CREATE_COOLDOWN = mapping, MIN_DEPLOY_FEE_WEI = fee + Address.sendValue payment leg) is meaningful additive code. Per `POST_MANDATE_STATE.md` § "Outstanding work blocked by mandate" (line 60-67), this is exactly the kind of fix that requires explicit user approval before writing.

**Verdict:** Open H-18 attack surface, intentionally accepted under mandate. Requires escalation if the user wants this closed.

### 3.2 Other Launchpad markers (clean)

| Marker | Pattern | Implementation | Status |
|---|---|---|---|
| BATCH-H M3 / Slither encode-packed (CREATE2 salt) | Cross-chain salt safety | Line 213-215 — `keccak256(abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol))`. Uses `abi.encode` (NOT encodePacked) — eliminates the dynamic-string collision class. | **CLEAN.** Symmetric with NFTPoolFactory DEEP-NFTPOOL-09. |
| L-L02 (`MAX_PROTOCOL_FEE_BPS = 1000` 10% ceiling) | OS/Blur/Rarible fee band | Line 85, validated at constructor (169) AND propose (315). | **CLEAN.** |
| L-L03 (`dropTemplate` immutable) | Sudoswap/0xSplits/Foundation constitutional template | Line 110 — `address public immutable dropTemplate`. | **CLEAN.** Documented forward-only mitigation posture in NatSpec. |
| DEEP-LP-02 (`whenNotPaused` on execute) | OZ Pausable + emergency-halt | Lines 345 (executeProtocolFee), 379 (executeProtocolFeeRecipient). | **CLEAN.** |
| DEEP-LP-04 (`expectedFeeBps` value-bind) | OZ Governor proposal-identity hash | Line 342, 376 — both execute paths take expected value parameter. | **CLEAN.** |
| V2-LP-01 (`expectedExecuteAfter` ETA bind) | OZ Governor execute-by-hash | Line 349, 383 — execute reverts if `_executeAfter[KEY] != expectedExecuteAfter`. | **CLEAN.** |
| MICROSCOPE M-D4 (`ProtocolFeeRecipientCancelled` event parity) | Yearn V3 lifecycle event symmetry | Line 73 + line 394. | **CLEAN.** |
| DEEP-LP-01 (acceptOwnership flushes pending proposals) | OZ Governor cancel on guardian change | Line 414-426 — flushes both FEE_CHANGE and FEE_RECIPIENT_CHANGE on rotation. | **CLEAN.** |
| DEEP-LP-03 (`MAX_PAGINATED_LIMIT = 1000`) | UniV2 allPairs(uint256) | Line 94 + line 299. `getAllCollections` is unbounded but documented as scaling-limited (line 274-281). | **CLEAN within paginated path; unbounded path is the H-18 surface.** |
| R062 (sequencerFeed propagation to clones) | Aave V3 PriceOracleSentinel | Line 153 + line 240 — factory's `sequencerFeed` immutable threads into every clone via `InitParams.sequencerFeed`. | **CLEAN.** |

---

## 4. TegridyDropV2 — divergence classification

### 4.1 F-47-2 — `block.chainid` in merkle leaf

**User prompt expectation:** `keccak256(abi.encode(block.chainid, address(this), msg.sender, allowedAmount))`.

**Current implementation (line 538-540):**
```solidity
bytes32 leaf = keccak256(
    bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount)))
);
```

**Verified divergence:** No `block.chainid` in the leaf preimage. Only `address(this)`, `msg.sender`, `allowedAmount`. Double-hashed via OZ MerkleTree second-preimage defense.

**Cross-chain replay risk analysis:**
- Drop is cloned via `Clones.cloneDeterministic` from `TegridyLaunchpadV2.createCollection`. The salt at line 213-215 includes `block.chainid` — so the same (creator, name, symbol) tuple deploys to DIFFERENT addresses on different chains. **`address(this)` already differs cross-chain even without chainid in the leaf.**
- The `address(this)` binding therefore implicitly chainid-binds the leaf for any drop deployed via the launchpad.
- **Residual risk:** Operator manually deploys the drop template to the same address on two chains via a custom script (NOT the launchpad). Then the leaf with `(address(this), msg.sender, allowedAmount)` is identical cross-chain — replay possible.

**Severity:** LOW. The launchpad path is the canonical deploy path; manual deploys are out-of-band operator concern. Mandate-acceptable.

**Verdict:** Per the prior agent_review_NFTPool_Drop.md analysis: "the launchpad's `cloneDeterministic` salt already includes chainid (per code comment line 583-585), so ANY clone deployed via the launchpad has a chainid-bound `address(this)`. The new `block.chainid` in the leaf is redundant for launchpad clones BUT defends against future v3 launchpad without chainid in salt OR custom deploy scripts." The current source omits the redundant defense; the launchpad-path safety is intact.

### 4.2 M-47 / F-74-3 — Dutch auction sequencer outage credit

**User prompt expectation:** `_dutchAuctionPriceWithoutSequencerCheck` subtracts `outageBuffer = SequencerCheck.getSequencerOutageBuffer(...)` from `rawElapsed`.

**Current implementation (line 641-648):**
```solidity
function _dutchAuctionPriceWithoutSequencerCheck() internal view returns (uint256) {
    if (block.timestamp < dutchStartTime) return dutchStartPrice;
    uint256 elapsed = block.timestamp - dutchStartTime;
    if (elapsed >= dutchDuration) return dutchEndPrice;
    uint256 priceDrop = dutchStartPrice - dutchEndPrice;
    uint256 decay = (priceDrop * elapsed) / dutchDuration;
    return dutchStartPrice - decay;
}
```

**Verified divergence:** No outage-buffer subtraction. Pure linear decay over wall-clock elapsed.

**What IS in place:** Two sequencer-aware paths around this internal function:
1. `_dutchAuctionPrice()` (line 624-634) — calls `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` BEFORE the decay calc. **Reverts** during outage / grace. Used by `mint()` (line 525).
2. `currentPrice()` (line 604-612) — calls `SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` and returns `type(uint256).max` SENTINEL during outage. Used by indexers / UIs.

**So the L2 outage protection is REVERT (mint) + SENTINEL (view), NOT clock-credit.** A buyer who waited out a 24h outage will, post-resume, see the dutch curve continue from where it would have been at wall-clock — i.e., the price is decayed by the full 24h of "elapsed." The outage isn't credited back.

**M-47 in `POST_MANDATE_STATE.md`:** "TegridyDropV2 Dutch auction during sequencer outage — auctions naturally progress; outage during the curve is symmetric to outage during a real-time market (bidders can't act either way). Accept."

**Verdict:** **DELIBERATE accept-as-design.** The mandate's logic is that since NEITHER buyer nor seller can transact during outage, the auction's price-decay is a no-op for both — neither party is advantaged. The user prompt's expected `outageBuffer` subtraction is the more conservative posture (credit the buyer for outage time) but the simpler shape (no clock manipulation) is the mandate's preferred posture.

**Cross-check with sister contracts:** Both `TegridyLending.sol` (line 1216) and `TegridyNFTLending.sol` (line 799) DO use `getSequencerOutageBuffer` for repay/liquidation deadline credit. The asymmetry between Lending (credits buffer) and DropV2 (doesn't credit buffer) is intentional: in lending, the borrower's deadline expiring during outage is genuinely unfair (they can't repay); in a dutch auction, the price decay is a market-level event both sides observe.

### 4.3 F-67-4 — `MIN_DUTCH_DURATION = 1 hour` floor

**User prompt expectation:** `MIN_DUTCH_DURATION = 1 hours` floor enforced at initialize, proposeDutchAuction, executeDutchAuction.

**Current implementation:** No `MIN_DUTCH_DURATION` constant. Only `dutchDuration != 0` check (line 425) and `startPrice - endPrice >= dutchDuration` (line 427). A 30-second curve would pass.

**Severity:** LOW. Validator-timestamp drift is up to ~12s on L1 and <1s on L2. On a 30-second curve, drift is ~40% of decay surface — adversarial timestamp manipulation can shift the price quote materially. On a 1h curve, drift is <0.5%. The `_dutchAuctionPrice` SENTINEL path (return `type(uint256).max` during sequencer outage) provides an additional gate, but doesn't prevent intra-block timestamp manipulation.

**Verdict:** Mandate-acceptable. Fix would be a single `if (duration < MIN_DUTCH_DURATION) revert ...` at three sites — under 10 LoC. Could be added if the user wants to escalate.

### 4.4 F-48-A / F-48-B / F-48-C — acceptOwnership / renounceOwnership / __gap

**Current implementation:**
- `acceptOwnership` (line 1092-1129): no `msg.sender == address(0)` check; only `msg.sender == pendingOwner`. Flushes MERKLE_ROOT_CHANGE / MINT_PRICE_CHANGE / DUTCH_CONFIG_CHANGE on rotation. **CLEAN booby-trap flush.**
- `renounceOwnership` (line 1131-1133): exists as a revert-only stub `revert("RENOUNCE_DISABLED");`. Not deleted (which would have been a smaller surface) but functionally equivalent to "no concept of renouncement." **PARTIAL.** Mandate-acceptable.
- `__gap`: Not declared. NatSpec at lines 386-414 in the prior fix_review (referenced) explained why no gap is needed for clones (Sudoswap V2 LSSVMPair / Manifold ERC721LazyPayableClaim / 0xSplits SplitMain all clones, no gap). **CLEAN.**

### 4.5 Other DropV2 markers (clean)

| Marker | Pattern | Implementation | Status |
|---|---|---|---|
| MICROSCOPE C1 (`allowedAmount` baked into leaf + per-claimer counter) | Manifold ERC721LazyPayableClaim per-leaf consumption | Line 538-548 + `allowlistClaimed` mapping (line 242). | **CLEAN.** |
| H-01 / R023 (merkle root rotation timelock) | Compound Timelock + value-bind | `MERKLE_ROOT_DELAY = 24h` (line 348), propose/execute/cancel triplet (line 715-754). `_canRotateMerkleRoot` gates to CLOSED/CANCELLED/paused (line 705). V3-DROP-04 rejects bytes32(0) on ALLOWLIST execute (line 739). | **CLEAN.** |
| V2-DROP-01 / V2-DROP-03 (mint price + dutch config timelock) | Same shape as MERKLE_ROOT_CHANGE | propose/execute/cancel triplets at lines 770-803 (price), 875-936 (dutch). V3-DROP-01/02/03/04 hardening. | **CLEAN.** |
| V2-DROP-04 (initialize DUTCH_AUCTION not-already-ended) | Sudoswap LSSVMPair entry guard | Line 444-448 in initialize. | **CLEAN.** |
| V2-DROP-05 (`tryCheckSequencerUp` instead of self-call) | Gas optimization | Line 604-612. | **CLEAN.** |
| V2-DROP-06 (freezeBaseURI rejects empty placeholder) | Sound Protocol freezeMetadata | Line 840-844. | **CLEAN.** |
| H9 (withdrawn one-way + cancelSale gate) | Thirdweb / Manifold drop pattern | Line 258 + line 1014. | **CLEAN.** |
| DEEP-DROP-05 (cancelSale gated to totalSupply == 0) | Manifold cancellation discipline | Line 1015. | **CLEAN.** |
| DEEP-DROP-06 (baseURIFrozen one-shot) | Sound Protocol / Manifold freezeBase | Line 277 + line 822 + line 840. | **CLEAN.** |
| H20 / DEEP-DROP-04 (POST_CANCEL_RESCUE_DELAY = 1 year) | 0xSplits recover lockout | Line 252 + line 1067. | **CLEAN.** |
| H19 / V3-DROP (zero-price-post-mint reject) | Manifold mint price discipline | Line 772 (propose) + line 791 (execute). | **CLEAN.** |
| MICROSCOPE M-D3 (acceptOwnership flushes MERKLE_ROOT proposal) | OZ Governor cancel on guardian change | Line 1102-1107. Symmetric with V2-DROP-01/03 flush at line 1108-1128. | **CLEAN.** |
| BATCH-H M8 (`MAX_MINT_PER_TX = 50`) | Self-DoS bound | Line 48 + line 508. | **CLEAN.** |
| M7 (`totalProceeds` accounting) | OZ PaymentSplitter discipline | Line 234 + line 565 + line 973-991. Donations don't inflate platform fee. | **CLEAN.** |
| M8 (`MAX_PLATFORM_FEE_BPS = 1000`) | OS/Blur fee band | Line 332 + line 383. | **CLEAN.** |
| NEW-L7 (`MAX_ROYALTY_BPS = 1000`) | EIP-2981 marketplace norm | Line 338 + line 385. | **CLEAN.** |
| R062 (sequencerFeed clone init) | Aave V3 PriceOracleSentinel | Line 322 + line 399 (set once at init). | **CLEAN.** |

---

## 5. Storage layout verification

All 4 contracts compile clean and have well-formed storage layouts. Snapshots:

### TegridyNFTPool (slots 0-23)

Slots 0-23 are used; slot 23 packs `_swapInFlight` (bool, offset 0, 1 byte) + `_swapCaller` (address, offset 1, 20 bytes). No storage gaps for clones (mandate posture). Pre-revert variants would have added `pendingStrandedWETH` mapping at slot 24 — **NOT present in current source**, consistent with `rescueStrandedRoyalty()` owner-sweep design.

### TegridyNFTPoolFactory (slots 0-15)

Includes OwnableNoRenounce (0,1,2), Pausable (3), TimelockAdmin `_executeAfter` (4), then factory-specific state. Clean append-only progression.

### TegridyLaunchpadV2 (slots 0-8)

Includes OwnableNoRenounce (0,1,2), Pausable (3), TimelockAdmin (4), then packed slot 5 (`protocolFeeBps` uint16 + `pendingProtocolFeeBps` uint16 + `pendingProtocolFeeRecipient` address20 = 24 bytes), `protocolFeeRecipient` (6), `collections` mapping (7), `allCollections` array (8). Pre-revert H-18 variants would have added `MAX_COLLECTIONS` constant (no slot), `lastCreate[creator]` mapping (slot 9), `protocolDeployFee` (slot 10) — none present.

### TegridyDropV2 (slots 0-44)

Inherits ERC721 base (slots 0-5: `_name`, `_symbol`, `_owners`, `_balances`, `_tokenApprovals`, `_operatorApprovals`), ERC2981 (6, 7: `_defaultRoyaltyInfo`, `_tokenRoyaltyInfo`), Pausable (8), TimelockAdmin (9), then drop-specific. Slot 38 packs `baseURIFrozen` bool + `sequencerFeed` address20. Slot 40-43 reserves 4 slots for `pendingDutchConfig` struct (4 uint256 fields). All slots accounted; clean append-only.

**No storage drift, no orphaned slots, no clashes.**

---

## 6. Summary table — all markers

| # | File | Marker | User-prompt expectation | Current state | Class | New exploit? |
|---|---|---|---|---|---|---|
| 1 | LaunchpadV2 | H-18 / F-95-K-1 | MAX_COLLECTIONS=10000 + CREATE_COOLDOWN=1h + MIN_DEPLOY_FEE_WEI=0.001 ETH (Address.sendValue) | **NONE landed.** | REDUNDANT (mandate accept-as-design) | No NEW exploit; H-18 is the prior open finding |
| 2 | NFTPoolFactory | F-26-2 / F-54-1 | supportsInterface 721 try/catch + 1155 reject | **NEITHER landed.** Only `code.length > 0`. | REDUNDANT (mandate accept-as-design) | No NEW exploit; spam-deploy of useless pools costs full createPool gas |
| 3 | NFTPoolFactory | F-26-9 / F-95-K-3 | MAX_TOTAL_POOLS_GLOBAL + spotPrice*len floor | NEITHER landed. MIN_DEPOSIT OR-bypass open. | QUESTIONABLE (open ~MEDIUM exploit, see § 2.3) | **Open spam vector** — 200 spam pools per hostile collection at ~0.25 ETH cost. Bounded by MAX_POOLS_PER_COLLECTION. |
| 4 | NFTPoolFactory | F-60-2 (length-23 reject) | code.length 0/23 reject | Only length 0 reject. | REDUNDANT (EIP-7702 cannot escalate beyond underlying delegate) | No NEW exploit |
| 5 | NFTPool | M-18 / F-19-1 | Per-token royalty iteration | **REVERTED.** Single-anchor `_settleRoyalty(spotRevenue, tokenIds[0])`. | JUSTIFIED (mandate accept-as-design; Sudoswap V2 same posture) | No NEW exploit |
| 6 | NFTPool | M-18 / F-19-2 / F-55-7 | pendingStrandedWETH + claimStrandedRoyaltyWETH self-claim | **REVERTED.** `rescueStrandedRoyalty()` owner-sweep. | JUSTIFIED (mandate posture; battle-tested vs Wave-B anti-pattern) | No NEW exploit; receiver-strand-loss is the documented trade-off |
| 7 | NFTPool | F-62-1 (init MAX_SPOT_PRICE) | `_spotPrice > MAX_SPOT_PRICE` revert at initialize | **NOT at init.** Only at proposeSpotPrice (line 445). _minLiquidityBuffer's overflow workaround at line 914 returns 0 instead. | QUESTIONABLE (init bypass open) | **Open** — hostile creator can ship a pool with `_spotPrice ≈ uint256.max / 50` that bricks `100 * spotPrice`. _minLiquidityBuffer returns 0 instead which is the bypass. Severity LOW. |
| 8 | NFTPool | F-61-2 (Math.Rounding.Ceil fees) | mulDiv(.., feeBps, BPS, Math.Rounding.Ceil) | Plain `/` division (rounds DOWN). | REDUNDANT (mandate posture; sub-cent / micro-trade vector at L2) | Severity INFO |
| 9 | NFTPool | F-63-1 (MAX_DEADLINE = 2h) | deadline cap to 2h | Only `block.timestamp > deadline` check. | REDUNDANT (mandate posture; modern wallet defaults bound this) | Severity INFO |
| 10 | NFTPool | F-54-2 (ERC1155 receiver revert) | onERC1155Received / Batch revert | NOT declared. Indirect protection via IERC721 typing. | REDUNDANT (mandate posture; pool's accounting cannot represent 1155) | No NEW exploit |
| 11 | DropV2 | F-47-2 (chainid in merkle leaf) | `keccak256(abi.encode(block.chainid, address(this), msg.sender, allowedAmount))` | NOT in leaf. address(this) implicit chainid-bind via launchpad CREATE2. | JUSTIFIED (mandate posture; launchpad clones already chainid-bound) | No NEW exploit |
| 12 | DropV2 | M-47 / F-74-3 (sequencer outage credit) | _dutchAuctionPriceWithoutSequencerCheck subtracts outageBuffer | NOT subtracted. Sequencer protection via REVERT (mint) and SENTINEL (view). | JUSTIFIED (POST_MANDATE_STATE accept-as-design; symmetric outage for both sides) | No NEW exploit |
| 13 | DropV2 | F-67-4 (MIN_DUTCH_DURATION = 1h) | dutchDuration ≥ 1h floor | Only `dutchDuration != 0`. | QUESTIONABLE (validator drift on short curves) | Severity LOW; <10 LoC fix possible |
| 14 | DropV2 | F-48-A (acceptOwnership address(0) check) | `msg.sender == address(0) → revert` | NOT added. Only `msg.sender == pendingOwner`. | REDUNDANT (inert today; defensive) | No NEW exploit |
| 15 | DropV2 | F-48-B (remove dead renounceOwnership) | Function deleted | Function exists but reverts with `"RENOUNCE_DISABLED"`. | PARTIAL (mandate-acceptable; revert-only stub achieves same semantic) | No NEW exploit |
| 16 | All 4 | Storage layout | clean | clean (slots 0-23 / 0-15 / 0-8 / 0-44) | JUSTIFIED | No drift |

---

## 7. Action items (priority-ordered)

1. **OPEN MEDIUM (escalation candidate):** F-95-K-3 NFTPoolFactory MIN_DEPOSIT OR-bypass — hostile ERC-721 author can deploy 200 spam pools per collection at ~0.25 ETH cost via the OR clause `msg.value >= MIN_DEPOSIT \|\| initialTokenIds.length > 0`. Bounded by MAX_POOLS_PER_COLLECTION (200). Per mandate, escalate to user before adding `spotPrice * len` floor.
2. **OPEN MEDIUM (escalation candidate):** H-18 Launchpad spam — never landed. Per mandate, escalate to user before adding `MAX_COLLECTIONS` + `CREATE_COOLDOWN` mapping + `MIN_DEPLOY_FEE_WEI` (with Address.sendValue payment leg).
3. **OPEN LOW (escalation candidate):** F-62-1 NFTPool init-time `MAX_SPOT_PRICE` check — single-line `if (_spotPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();` at line ~234 in `initialize`. Mirror the proposeSpotPrice check.
4. **OPEN LOW (escalation candidate):** F-67-4 DropV2 `MIN_DUTCH_DURATION = 1 hours` constant + 3 init/propose/execute checks. <10 LoC.
5. **DOC-ONLY:** Update `POST_MANDATE_STATE.md` to add explicit accept-as-design entries for: M-47 (already there), H-18 / F-95-K-1 (already documented), F-95-K-3 NFTPoolFactory MIN_DEPOSIT OR-bypass (NEW addition needed).

---

## 8. Files referenced

- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/TegridyNFTPool.sol` (1036 LoC)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/TegridyNFTPoolFactory.sol` (677 LoC)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/TegridyLaunchpadV2.sol` (427 LoC)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/TegridyDropV2.sol` (1134 LoC)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/lib/SequencerCheck.sol` (`getSequencerOutageBuffer` exists, used by Lending/NFTLending but NOT by DropV2)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/src/lib/WETHFallbackLib.sol` (mode==2 stranded-fallback used by NFTPool _settleRoyalty)
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/POST_MANDATE_STATE.md`
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/fix_review/agent_review_NFTPool_Drop.md`
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/fix_review/agent_review_Factory_Launchpad.md`
- `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/storage_layout/{TegridyNFTPool,TegridyNFTPoolFactory,TegridyLaunchpadV2,TegridyDropV2}.txt`

**End of scan.**
