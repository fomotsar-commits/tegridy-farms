# Audit 009 — TegridyNFTPoolFactory.sol

**Agent:** 009 / 101
**Target:** `contracts/src/TegridyNFTPoolFactory.sol`
**Cross-check:** `contracts/test/TegridyNFTPoolFactory.t.sol`
**Date:** 2026-04-25
**Mode:** AUDIT-ONLY

---

## Scope summary
ERC1167 minimal-proxy factory deploying `TegridyNFTPool` clones via `cloneDeterministic` (CREATE2). Clone init in same tx as deploy via `initialize()`. Indexes pools globally and per-collection. Owner can pause; protocol fee + recipient changes are 48h timelocked. Routes router queries via best-buy/best-sell helpers that iterate the per-collection array.

---

## HIGH

_None._ Clone init-front-running is properly mitigated: `cloneDeterministic` + same-tx `initialize()` + `_disableInitializers()` on the implementation closes the standard hijack window. Owner has no privilege over deployed pools (factory only acts as fee claim relay + initial state writer). Re-init is blocked by OZ `Initializable` `initializer` modifier.

---

## MEDIUM

### M-1: Cross-chain salt collision via squatter — DoS for honest deployer (predictable salt)
**Location:** `createPool()` lines 144-147
**Severity:** MEDIUM
**Status:** UNFIXED

The salt is `keccak256(msg.sender, _allPools.length, nftCollection, uint8(poolType))`. None of those inputs include `block.chainid` or any factory-instance entropy, AND `Clones.cloneDeterministic` reverts when the target CREATE2 address already has code.

Attack: an adversary observes Alice's pool deploys on chain A, then on chain B (different factory address — but if any operator deploys the *same* factory bytecode at the same address on the new chain via deterministic factory deployment / CREATE2 deployer — common practice for L2 deployments, e.g., the same Tegriddy factory at `0xABC…` on Base + Optimism + Arbitrum) the attacker pre-front-runs Alice's first deploy by calling `createPool` themselves from her address-equivalent? They cannot, since `msg.sender` is in the salt. **However**, the salt is fully deterministic given (sender, counter, collection, poolType). On a new chain with the same factory address, **any** user can predict the address Alice's clone will land at and grief by no-op deployment that bumps the on-chain counter to a different value, OR deploy any contract at that address via a CREATE2 deployer. The `Clones.cloneDeterministic` call will then revert with `ERC1167FailedCreateClone`.

The implementation's predictable address by `_allPools.length` global counter also means: if a single transaction calls `createPool()` twice (e.g., via a multicall or another factory wrapper that creates two pools), and the second errors mid-way, the first one's salt is now consumed; replaying becomes impossible without bumping counter via dummy deploys.

**Recommendation:** add `block.chainid` and `address(this)` (or a per-collection nonce) to the salt mix, e.g.:
```solidity
bytes32 salt = keccak256(abi.encodePacked(
    block.chainid,
    address(this),
    msg.sender,
    _allPools.length,
    nftCollection,
    uint8(_poolType)
));
```

### M-2: Unbounded enumeration in `getBestBuyPool` / `getBestSellPool` — gas-DoS via pool spam
**Location:** lines 232-287
**Severity:** MEDIUM
**Status:** UNFIXED

`createPool` has **no per-collection rate limit and no creation cost beyond `MIN_DEPOSIT = 0.01 ether` OR ≥1 NFT**. A griefer can spam thousands of pools for a target collection (each costs `0.01 ETH` minimum, but they can later withdraw via `removeLiquidity`/`withdrawETH` — net cost is gas only on cheap L2s). After pool count grows large enough, every `getBestBuyPool` / `getBestSellPool` call hits the block gas limit due to nested `try…catch` external view calls (each iteration: `pool.poolType()`, `pool.getHeldCount()`, `pool.getBuyQuote()` — three external SLOAD-heavy calls per iter).

Even with reasonable pool counts (~500), routers integrating these helpers will exceed 20M gas. There is no `getBestBuyPoolPaginated` variant, and the function reverts atomically on OOG — there's no "best so far" return value if the loop is truncated.

**Recommendation:** add `getBestBuyPoolPaginated(collection, numItems, offset, limit)` and document that the unbounded variant is unsafe for on-chain consumption above some pool-count threshold. Alternatively, sort pools off-chain and have routers pass pre-filtered candidates.

### M-3: `claimPoolFeesBatch` swallows all errors silently — observability gap
**Location:** lines 379-383
**Severity:** MEDIUM
**Status:** UNFIXED

```solidity
function claimPoolFeesBatch(address[] calldata pools) external {
    for (uint256 i = 0; i < pools.length; i++) {
        try TegridyNFTPool(payable(pools[i])).claimProtocolFees() {} catch {}
    }
}
```

The empty `catch {}` discards both reason and pool index. If a hostile or buggy "pool" is added to the array (anyone can pass arbitrary addresses — there is no membership check against `_allPools`), it will silently fail. **Worse,** because the array is caller-controlled and the function does not require the pool be in `_allPools`, an adversary can pass attacker-controlled fake "pools" that revert in interesting ways or even spoof `claimProtocolFees()` to re-enter the factory. While `claimProtocolFees()` on real pools requires `msg.sender == factory`, a fake "pool" doesn't; it could call back into `withdrawProtocolFees()` or another factory function. Today's surface is benign because the only callable factory functions during reentry are view + the timelocked admin functions (gated by `onlyOwner`), but `withdrawProtocolFees` has `nonReentrant` only — `claimPoolFeesBatch` itself does NOT have `nonReentrant`. A fake pool could re-enter `claimPoolFeesBatch` with a different list, producing log/spam DoS.

**Recommendation:** require `pools[i]` is in `_allPools` (use a `mapping(address => bool) isPool` set when push-indexing), and emit an event with `(pool, reason)` on catch, and add `nonReentrant` to the batch.

### M-4: No collection contract-type check beyond `code.length > 0`
**Location:** line 130
**Severity:** MEDIUM
**Status:** UNFIXED

`require(nftCollection.code.length > 0, "NOT_CONTRACT")` rejects EOAs but accepts **any** contract. A non-ERC721 contract (or worse, a malicious "NFT" with custom `safeTransferFrom` that re-enters back into the factory or pool) can be passed. The factory then calls `nft.safeTransferFrom(msg.sender, pool, initialTokenIds[i])` after `_allPools.push` and `_poolsByCollection[nftCollection].push` — meaning the registry is mutated **before** the external call. An attacker could:
1. Deploy a fake "NFT" that on `safeTransferFrom` re-enters the factory's `createPool` to spam the registry.
2. Pollute `_poolsByCollection[fakeNFT]` arbitrarily (cheap, only `MIN_DEPOSIT` per call).

While this doesn't directly steal funds, it's registry tampering that misleads UIs/routers integrating `getPoolsForCollection`. Same for `getBest*Pool` — those iterate every entry, so a single pool with a `poolType()` that returns garbage will cascade error rates.

**Recommendation:** call `IERC165(nftCollection).supportsInterface(0x80ac58cd)` (ERC721 interface ID) before push — but with `try/catch` since not all ERC721s implement ERC165. Alternative: do a probing `nft.balanceOf(msg.sender)` call inside `try` to verify the contract responds plausibly.

### M-5: ETH initial-deposit forwarded via `.call` with full gas — reentrancy surface
**Location:** lines 170-173
**Severity:** MEDIUM
**Status:** UNFIXED

```solidity
if (msg.value > 0) {
    (bool success,) = pool.call{value: msg.value}("");
    require(success, "ETH_TRANSFER_FAILED");
}
```

This is a **full-gas** call to a freshly-deployed clone. The clone has been initialized but the index push has already completed. The clone's `receive()` is empty in `TegridyNFTPool.sol` line 571, so today the receive can't re-enter — but the clone code is the implementation address pulled from `poolImplementation` (immutable). If the implementation is ever upgraded by re-deploying the factory with a new template that has a non-empty receive, this becomes exploitable.

Also note: `createPool()` itself has **no `nonReentrant` modifier**, despite the factory inheriting `ReentrancyGuard`. The reentrancy guard appears to be there only for `withdrawProtocolFees`. In current state with the empty receive, this is benign — but it's defense-in-depth that's been left off.

**Recommendation:** add `nonReentrant` to `createPool()`. Use `_sendETH` (10k gas stipend pattern from WETHFallbackLib) instead of full-gas `.call`.

---

## LOW

### L-1: NFT initial-deposit loop has no allowlist of `tokenIds` length cap
**Location:** lines 176-181
**Severity:** LOW
**Status:** UNFIXED

The loop calls `nft.safeTransferFrom(msg.sender, pool, initialTokenIds[i])` for every id. No cap. A user can pass 5,000 ids in one tx and OOG, but more importantly, a malicious NFT can run arbitrary code per iteration. While `safeTransferFrom` is on the user's NFT (under their control), if the NFT has a malicious `_beforeTokenTransfer` hook, it can re-enter `createPool` (the factory has no `nonReentrant`). This is the same vector as M-5.

**Recommendation:** cap `initialTokenIds.length <= 100` (matching the pool's `TooManyItems` cap of 100), and add `nonReentrant`.

### L-2: `pool.call{value: msg.value}("")` doesn't pass an ABI selector
**Location:** line 171
**Severity:** LOW (informational pattern)
**Status:** UNFIXED

The empty calldata triggers the clone's `receive()`. This is fine, but if a future `TegridyNFTPool` version has a `fallback()` that does anything non-trivial, the empty calldata will hit `receive` — confusion vector. Consider explicit `pool.call{value: msg.value}("")` documented or use a typed `seedETH()` setter on the pool.

### L-3: Constructor does not validate `_owner != address(0)`
**Location:** lines 87-92
**Severity:** LOW
**Status:** UNFIXED — depends on `OwnableNoRenounce`

The constructor passes `_owner` to `OwnableNoRenounce(_owner)` without an explicit zero check at the factory layer. If `OwnableNoRenounce` doesn't enforce non-zero (must verify), the factory could be deployed ownerless.

**Recommendation:** add `if (_owner == address(0)) revert ZeroAddress();` at line 92.

### L-4: `MAX_PROTOCOL_FEE_BPS = 1000` (10%) on initial deploy — but the timelocked propose path has the same ceiling
**Location:** lines 30, 294
**Severity:** LOW (design observation)
**Status:** UNFIXED

The constructor blocks fee==0 (good — comment NEW-L8) and fee>1000. The timelocked propose path blocks fee>1000 — but does it block fee==0? Let me check line 294: only `if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();` — **fee=0 is allowed via propose path.** This contradicts the constructor's intent that fee==0 is forbidden. After 48h, owner can drop the protocol fee to zero, defeating the constructor's NEW-L8 protection.

**Recommendation:** if fee==0 is truly invalid, mirror the check in `proposeProtocolFeeChange`: `if (newFeeBps == 0) revert InvalidFee();`.

### L-5: `_allPools.length` as salt component is gameable across reverting calls
**Location:** line 145
**Severity:** LOW
**Status:** UNFIXED

If `createPool` reverts after the salt is computed but before the push (e.g., the cloning succeeds but `safeTransferFrom` reverts on a deceptive NFT), the counter is unchanged. Subsequent successful calls will compute a salt against the same counter — but with different `nftCollection` or `poolType`, so the address differs. This is not exploitable today, but the comment "makes repeated calls by the same user produce distinct addresses" is technically not the only invariant — distinct (sender, counter, collection, type) tuples produce distinct salts, but two different users in different blocks can collide if both call with `_allPools.length=N` and identical other params (only `msg.sender` differs, salt is unique — OK). Just noting that the counter is a **shared global** and not a per-user counter; this is fine but the documentation overstates the property.

### L-6: No event on `withdrawProtocolFees`
**Location:** lines 389-393
**Severity:** LOW
**Status:** UNFIXED

`withdrawProtocolFees()` performs an ETH transfer but emits no event. Auditors / fee-tracking dashboards have no on-chain footprint of fee withdrawals from the factory.

**Recommendation:** add `event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount)` and emit in `withdrawProtocolFees`.

### L-7: `claimPoolFees` / `claimPoolFeesBatch` emit no factory-level event
**Location:** lines 373-383
**Severity:** LOW
**Status:** UNFIXED

The factory relays `claimProtocolFees()` to pools but emits no event from the factory itself. Off-chain monitoring relies on the pool's `ProtocolFeePaid` event firing during swaps + `_sendETH` transfer logs from each clone — possible but cumbersome. A factory-level `PoolFeesClaimed(pool, amount)` event would aid observability.

### L-8: `MIN_DEPOSIT` (0.01 ETH) is a magic number not declared as constant
**Location:** line 131
**Severity:** LOW
**Status:** UNFIXED

`require(msg.value >= 0.01 ether || initialTokenIds.length > 0, "MIN_DEPOSIT");` — no named constant. Hard to audit and tune.

---

## INFO

### I-1: `cloneDeterministic` revert reason on collision is opaque
If a salt collision occurs (whether via M-1 vector or L-5), the revert is OZ's `ERC1167FailedCreateClone` — does not tell the user "your deploy was front-run." Consider catching and rethrowing with a domain-specific error.

### I-2: `getAllPools()` returns the entire array — gas-DoS for off-chain reads at scale
At ~10k pools, `eth_call`-returned array exceeds 320KB ABI-encoded — most RPC providers will refuse. Mirror the per-collection pagination on a `getAllPoolsPaginated`.

### I-3: Documentation says "Per-collection pool indexing for discovery" but the registry has no de-duplication
A single user can create 1000 TRADE pools for the same collection. The registry will faithfully store all 1000. No design issue per se, but UIs / routers will need an off-chain ranking.

### I-4: `protocolFeeRecipient` is initially set in constructor without timelock
The constructor sets `protocolFeeRecipient` directly, but subsequent changes are 48h-timelocked. This is consistent with most factory patterns, but if the deployer is compromised at deploy-time, no timelock protection exists for the initial setting. Mitigation is operational: deploy from a trusted multisig.

### I-5: `withdrawProtocolFees` uses `WETHFallbackLib.safeTransferETHOrWrap` — good
Confirmed pattern matches Aave V3 fallback wrap. Recipient-of-WETH is the same `protocolFeeRecipient`. Note: if `protocolFeeRecipient` is a contract that rejects both ETH and WETH, the funds revert. Library should fail loud here — verified by reading WETHFallbackLib (not in this scope).

### I-6: The pool implementation deploys inline in the constructor (`new TegridyNFTPool()`)
Means the factory deployment cost includes the full pool bytecode. For factory upgrades, the implementation is immutable — to upgrade, deploy a new factory. This is a deliberate non-upgradeable design — solid.

### I-7: `receive() external payable {}` accepts arbitrary ETH
Anyone can `selfdestruct` ETH into the factory or transfer pre-deployment. The `withdrawProtocolFees` requires `address(this).balance > 0` and forwards everything. Forced ETH could mix with legit fees — minor accounting smear but not exploitable.

---

## Test Gaps (TegridyNFTPoolFactory.t.sol)

The existing test file has **23 tests** covering: constructor validation, createPool input validation, CREATE2 determinism, indexing, pagination, pause, fee timelock happy/sad path, and `PoolCreated` event emission. **Gaps:**

1. **GAP-T1 (corresponds to M-1):** No test for cross-chain salt collision or salt mixing. Recommend forge fuzz with `vm.chainId()` to assert salts differ across chains.

2. **GAP-T2 (corresponds to M-2):** No gas-bounded tests for `getBestBuyPool` / `getBestSellPool`. Add `test_getBestBuyPool_at100Pools_underGasLimit` that asserts gas usage stays under 30M.

3. **GAP-T3 (corresponds to M-3):** No test for `claimPoolFeesBatch` with a non-pool address in the array. Add `test_claimPoolFeesBatch_acceptsArbitraryAddress` and verify the registry-membership lack.

4. **GAP-T4 (corresponds to M-4):** No test for non-ERC721 contract collection. Add `test_createPool_acceptsNonERC721ContractCollection` to demonstrate the gap.

5. **GAP-T5 (corresponds to M-5):** No reentrancy test on `createPool`. Add `test_createPool_reentrancyViaMaliciousNFT` that has a malicious NFT calling back into `createPool` during `safeTransferFrom`.

6. **GAP-T6 (corresponds to L-4):** No test that timelock propose-path enforces fee > 0. Add `test_proposeProtocolFeeChange_rejectsZero`.

7. **GAP-T7:** No test for `claimPoolFees` happy-path forwarding (single pool). Test asserts that the factory ETH balance increases after `claimPoolFees(pool)` for a pool with accumulated fees.

8. **GAP-T8:** No test for `withdrawProtocolFees` to a contract recipient that rejects ETH (verifies WETH fallback path).

9. **GAP-T9:** No test for `withdrawProtocolFees` zero-balance revert (currently `require(balance > 0, "NO_FEES")`).

10. **GAP-T10:** No NFT-only deposit test (the existing `test_createPool_acceptsNFTOnlyDeposit` actually sends 0.01 ETH — comment admits this; the NFT-only path is **untested at the factory level**).

11. **GAP-T11:** No test for the `try/catch` skip behavior in `getBestBuyPool` (when a pool's quote reverts). Add a malicious pool that reverts on `getBuyQuote()` and assert iteration continues.

12. **GAP-T12:** No test for proposing a recipient change with already-pending proposal (should revert via TimelockAdmin's `ExistingProposalPending`).

13. **GAP-T13:** No test asserting `_disableInitializers()` blocks direct init of the implementation contract.

14. **GAP-T14:** No multi-call ordering test: createPool → propose fee change → execute → createPool again → assert second pool snapshots the new fee. (Note: the second pool snapshots `protocolFeeBps` at init, so the test would confirm the per-pool snapshot pattern.)

15. **GAP-T15:** No event-emission test for `ProtocolFeeChangeExecuted`, `ProtocolFeeRecipientChangeExecuted`, `ProtocolFeeChangeCancelled`, `ProtocolFeeRecipientChangeCancelled`. Only `PoolCreated` is asserted.

---

## Counts

- HIGH: 0
- MEDIUM: 5
- LOW: 8
- INFO: 7
- Test gaps: 15

## Top-3 priorities

1. **M-1: Add `block.chainid` + `address(this)` to salt** — protects against cross-chain DoS by squatters; trivial fix, no behavior change for single-chain deploys.
2. **M-2: Add paginated variants of `getBestBuyPool` / `getBestSellPool`** — current functions become unusable at scale and have no off-chain replacement; routers will fail.
3. **M-3: Add registry membership check + `nonReentrant` to `claimPoolFeesBatch`** — closes attacker-controlled fake-pool reentry surface and improves observability.
