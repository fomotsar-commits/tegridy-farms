# Agent 26 — TegridyNFTPoolFactory.sol Fresh-Eyes Audit

**Scope:** `contracts/src/TegridyNFTPoolFactory.sol` (clone factory pattern)
**Related:** `contracts/src/TegridyNFTPool.sol` (clone implementation)
**Lens:** CREATE2 salt, init params, frontrun, registry poisoning, clone correctness, deploy fee, whitelist, upgrade path

---

## Summary

Factory is a CREATE2 minimal-proxy clone deployer for sudoswap-style NFT AMM pools. Implementation has `_disableInitializers()` in its constructor; clones are initialized atomically inside `createPool` (no separable hijack window). Salt is well-constructed (chainid + factory + caller + counter + collection + poolType, all fixed-width — no ABI-collision). Reentrancy protection on `createPool` and on every privileged path. Registry uses both `_allPools[]`, `_poolsByCollection[]` and `isPool` mapping with consistent atomic writes.

Overall hardening on this file is high. Findings below are predominantly **LOW / NOTE** level — minor inconsistencies and design observations rather than exploitable defects. No criticals or highs uncovered.

---

## F-26-1 — LOW — Constructor `_protocolFeeBps == 0` invariant violated by governance path

**Where:** `TegridyNFTPoolFactory.sol:160-182` (constructor) vs `:460-465` (`proposeProtocolFeeChange`).

**Observation:**
The constructor explicitly rejects `_protocolFeeBps == 0` with `if (_protocolFeeBps == 0) revert InvalidFee();` (line 172) and the comment justifies this as "deploying with fee=0 ships a whole factory where every pool earns the protocol $0 forever."

However, `proposeProtocolFeeChange(uint256 newFeeBps)` only checks `if (newFeeBps > MAX_PROTOCOL_FEE_BPS)` — it does NOT reject `newFeeBps == 0`. Owner can therefore propose-and-execute a 0 fee post-deployment via the 48-hour timelock, defeating the constructor invariant.

**Impact:** Existing pools snapshotted `protocolFeeBps` at clone time and are unaffected. NEW pools created after a 0-fee execution would have zero protocol revenue — the exact failure mode the constructor was meant to prevent.

**Severity:** LOW. Requires owner action (already trusted with 48h delay) + new pool creation. Comment in constructor describes the intent ("deploy-time guard; ops team can raise fees via the timelocked propose path later if they want to change the default") — so the asymmetry is arguably **intentional governance flexibility**. But the assertion that fee can be raised but not lowered to 0 is not enforced. Recommend either:
- Adding `if (newFeeBps == 0) revert InvalidFee();` to `proposeProtocolFeeChange` for symmetry, or
- Updating the constructor comment to acknowledge governance can later set fee=0.

---

## F-26-2 — LOW — No ERC-721 / ERC-165 supportsInterface check on `nftCollection`

**Where:** `TegridyNFTPoolFactory.sol:206-207`:
```solidity
if (nftCollection == address(0)) revert ZeroAddress();
require(nftCollection.code.length > 0, "NOT_CONTRACT");
```

**Observation:** `code.length > 0` only verifies bytecode exists. There is no `supportsInterface(IERC721)` check. A non-ERC721 contract (or arbitrary bytecode) can be passed as `nftCollection`.

**Consequences:**
- Pool clone is deployed and indexed in `_poolsByCollection` and `isPool` regardless of whether `nftCollection` is a real ERC-721.
- If `msg.value >= MIN_DEPOSIT (0.05 ETH)` and `initialTokenIds.length == 0`, the pool is fully created with no NFT-side validation. A garbage collection address can sit in the registry.
- All swap functions (`swapETHForNFTs`, `swapNFTsForETH`) would later revert when the bogus nftCollection's `safeTransferFrom` fails — pool is functional-dead but pollutes discovery.

**Impact:** Low — economically deterred by `MIN_DEPOSIT = 0.05 ETH` × `MAX_POOLS_PER_COLLECTION = 200` = 10 ETH per target collection (consistent with existing in-code DoS comment for legitimate collections). Does NOT affect security of legitimate pools.

**Recommendation:** Optional `IERC165(nftCollection).supportsInterface(0x80ac58cd)` (ERC-721 interface ID) try-catch would catch obvious garbage early. Keeping permissionless deploy semantics is reasonable.

---

## F-26-3 — NOTE — Existing pool fee snapshot is permanent (intentional) but inconsistent with view

**Where:** `TegridyNFTPool.sol:250` clones snapshot `protocolFeeBps = _protocolFeeBps;` at init; `TegridyNFTPoolFactory.sol:460-487` lets governance change `protocolFeeBps` over time.

**Observation:** Older pools keep their original fee forever; new pools use the current factory fee. There is NO factory-level view that surfaces the "effective fee per pool" — frontends/aggregators that introspect `factory.protocolFeeBps()` and assume it applies to all pools will be wrong for any pool deployed before a fee change.

**Severity:** NOTE / observability. Not a security defect — simply a frontend integration trap. The pool itself exposes `protocolFeeBps()` so callers can read the per-pool snapshot directly.

---

## F-26-4 — NOTE — `pool.call{value: msg.value}("")` has no gas limit

**Where:** `TegridyNFTPoolFactory.sol:264-267`:
```solidity
if (msg.value > 0) {
    (bool success,) = pool.call{value: msg.value}("");
    require(success, "ETH_TRANSFER_FAILED");
}
```

**Observation:** Forwards all remaining gas to the pool's `receive()` function. The pool's `receive()` is trivial (`msg.sender != factory` check) so there is no realistic gas-griefing risk. However, this is the only ETH-forwarding path in the codebase that does NOT use `WETHFallbackLib.safeTransferETHOrWrap` (which uses a 10k-gas stipend).

**Severity:** NOTE. The pool implementation is fixed and known-good (deployed by this very factory). The asymmetry is harmless today but would matter if the implementation contract were ever upgradable — not the case here (it's `immutable`).

---

## F-26-5 — NOTE — Front-run / address-grinding analysis (concluded safe)

**Vector explored:** Attacker observes Alice's pending `createPool(collection, type, ...)` and tries to:
(a) Reproduce Alice's salt and deploy at her predicted address ahead of her, OR
(b) Block Alice's predicted address by deploying there first.

**Conclusion: not exploitable.**

Salt = `keccak256(chainid, factory, msg.sender, _allPools.length, collection, uint8(poolType))`.
- `msg.sender` binds the salt to Alice — attacker cannot forge.
- `_allPools.length` is the global pool counter at the moment of Alice's tx mining. If attacker submits their own `createPool` first, `_allPools.length` increases — Alice's salt automatically uses the new value, predicting a different (still uncolliding) address.
- `cloneDeterministic` will revert if the address is already taken — but since the salt depends on Alice's address + a counter that monotonically increases, the same `(alice, length)` pair never repeats.
- `initialize()` runs in the same transaction as `cloneDeterministic` — no separable hijack window.

**Verdict:** Salt construction and atomic init are solid. Worth keeping the existing audit comment that documents this rationale.

---

## F-26-6 — NOTE — Re-entrancy via malicious `nftCollection.safeTransferFrom` callback (concluded safe)

**Vector explored:** Inside `createPool`, after `_allPools.push(pool)` / `_poolsByCollection.push(pool)` / `isPool[pool] = true`, the factory invokes `nft.safeTransferFrom(msg.sender, pool, tokenIds[i])`. A malicious `nftCollection` could insert re-entrant calls during this safeTransferFrom.

**Possible re-entry targets evaluated:**
1. **Re-enter `createPool`** — blocked by factory's `nonReentrant`. Safe.
2. **Re-enter `claimPoolFees(newPool)`** — pool is brand-new with `accumulatedProtocolFees == 0`, no-op. Safe.
3. **Re-enter `pool.swapETHForNFTs([tokenIds[0]])` after first NFT lands** — possible IF the re-entrant callback brings its own ETH. But this is just normal swap economics: malicious actor pays current spot price to buy back the token. They're the pool owner, so this is a self-trade with no advantage.
4. **Read views** — view functions; harmless.

**Verdict:** No exploitable path. The factory's `nonReentrant` plus the pool's per-swap `nonReentrant` are sufficient. Worth noting that this depends on the pool's `_swapInFlight` / `_swapCaller` gating in `onERC721Received` (already analyzed by V2-NFTPOOL-01 / V3-NFTPOOL-01 audits).

---

## F-26-7 — NOTE — `claimPoolFeesBatch` reverts entire batch on first non-pool address

**Where:** `TegridyNFTPoolFactory.sol:573-587`:
```solidity
for (uint256 i = 0; i < pools.length; i++) {
    address pool = pools[i];
    if (!isPool[pool]) revert NotAPool(pool);  // hard revert, not skip
    ...
}
```

**Observation:** If a single non-pool address slips into the batch, the entire batch aborts and NO pool fees get claimed. Per-pool failures (try/catch on `claimProtocolFees`) ARE swallowed, but the membership check is a hard revert.

**Severity:** NOTE. Deliberate — comment 559-573 explains this is to prevent fee-claim routing through addresses the factory never deployed. Trade-off: a single typo in caller-supplied input DoSes the batch. Acceptable for a security-conscious factory; UI-side pre-validation should filter.

---

## F-26-8 — NOTE — `withdrawProtocolFees(uint256)` accepts `address(this).balance` from any source

**Where:** `TegridyNFTPoolFactory.sol:621-625`:
```solidity
function withdrawProtocolFees(uint256 amount) external onlyOwner nonReentrant {
    if (amount == 0) revert ZeroAmount();
    require(address(this).balance >= amount, "NO_FEES");
    _withdrawWithRateLimit(amount);
}
```

**Observation:** No accounting separates "fees claimed from pools" vs. "ETH from selfdestruct/forced sends". An attacker could pre-CREATE2-compute the factory address and selfdestruct ETH there before deployment (or use coinbase-block-reward mining to push ETH directly). All such ETH becomes withdrawable as "protocol fees".

**Severity:** NOTE — net-positive to the protocol (incoming "free" ETH is captured by owner-controlled withdraw). Not exploitable AGAINST users. The 24-hour rate limit caps damage even if owner key is briefly compromised.

---

## F-26-9 — NOTE — `MIN_DEPOSIT` bypassable by depositing just one cheap NFT

**Where:** `TegridyNFTPoolFactory.sol:211`:
```solidity
require(msg.value >= MIN_DEPOSIT || initialTokenIds.length > 0, "MIN_DEPOSIT");
```

**Observation:** The disjunction means an attacker who owns ANY single NFT of the target collection can deploy a pool with `msg.value = 0` and `initialTokenIds = [single_nft]`. The cost is approximately the floor price of ONE NFT of the target collection, which for low-value collections may be much cheaper than 0.05 ETH.

**Combined with:** `MAX_POOLS_PER_COLLECTION = 200`. To DoS-spam a collection's discovery endpoint, attacker needs 200 NFTs of THAT collection. That's typically infeasible (whales would notice).

**Severity:** NOTE — economically self-limiting for any collection with a meaningful floor. Worth flagging because the in-code comment claims "200-pool cap costs 10 ETH (~$25k)" but doesn't account for the cheaper-NFT bypass. For pump-and-dump or freshly-mintable collections, this could be much cheaper.

**Mitigation:** Optional — require BOTH `msg.value >= MIN_DEPOSIT` AND a non-empty `initialTokenIds` for non-BUY pools. But this complicates legitimate pool creation (BUY pools should be allowed with ETH only).

---

## F-26-10 — NOTE — Implementation contract is hard-coded immutable; no upgrade path

**Where:** `TegridyNFTPoolFactory.sol:67`, `:181`:
```solidity
address public immutable poolImplementation;
...
poolImplementation = address(new TegridyNFTPool());
```

**Observation:** A bug discovered in TegridyNFTPool requires deploying a new factory. Existing pool clones cannot be migrated (clones are minimal proxies that delegate to `poolImplementation` immutably — wait, actually `Clones.cloneDeterministic` deploys a MINIMAL PROXY that delegates ALL calls to the target. Let me re-check).

Per OpenZeppelin Clones library: `Clones.cloneDeterministic(implementation, salt)` deploys an EIP-1167 minimal proxy that delegatecalls to `implementation`. Each clone's storage is independent, but its CODE is the proxy that delegates to `poolImplementation`. So if `poolImplementation` is immutable in the factory, the proxy points to the same fixed implementation forever.

**Migration path:** Deploy new factory + new implementation. Existing pools keep working (their proxy bytecode points to OLD implementation; not affected). New pools go through new factory. Users would need to migrate liquidity manually.

**Severity:** NOTE — design decision, not a defect. Beacon proxy or upgradable implementation would change this trade-off. Current choice favors immutability over upgradability — consistent with sudoswap-V1 design philosophy.

---

## F-26-11 — NOTE — Cooldown grief on emergency-pause is asymmetric (intentional)

**Where:** `TegridyNFTPoolFactory.sol:651-673`:
```solidity
if (paused && lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
    revert EmergencyCooldown();
}
emergencyPaused = paused;
if (paused) lastEmergencyAt = block.timestamp;
```

**Observation:** Cooldown applies only to `false → true` transitions. Unpause is unrestricted. Comment confirms this matches Compound's PauseGuardian pattern.

**Verdict:** Sound. No finding — already audited (V2-NFTPOOL-02, V3-NFTPOOL-02 fixes documented in code comments).

---

## F-26-12 — NOTE — Pool emergency-pause cascade depends on factory existence

**Where:** `TegridyNFTPool.sol:266`, `:335`:
```solidity
if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
```

**Observation:** Each swap reads `factory.emergencyPaused()`. If the factory contract somehow becomes unreachable (selfdestruct, EIP-6780 forces all SELFDESTRUCT into balance-only post-Cancun, so factory CODE persists). The factory has NO selfdestruct path anyway. **Not a finding.**

---

## F-26-13 — NOTE — `createPool` ordering: registration before NFT transfer (intentional CEI inversion is acceptable)

**Where:** `TegridyNFTPoolFactory.sol:258-275`:
```solidity
_allPools.push(pool);              // register
_poolsByCollection[..].push(pool); // index
isPool[pool] = true;               // membership
if (msg.value > 0) ETH...           // external effect 1
if (initialTokenIds.length > 0) NFT... // external effect 2 (calls into nftCollection)
```

**Observation:** Registry writes complete BEFORE external effects. This is consistent with CEI (Checks-Effects-Interactions) and means a revert in steps 4/5 cleanly unwinds steps 1-3 (whole tx reverts). No partial-state risk.

**Verdict:** Pattern is correct. No finding.

---

## Dead-end / Vectors Explored, No Issue Found

- **CREATE2 salt collision via abi.encodePacked**: No dynamic types in salt; encoding is unambiguous.
- **`_disableInitializers` on impl**: Confirmed at `TegridyNFTPool.sol:215-217`.
- **Front-run direct `initialize` on freshly-cloned address**: Initialize called atomically in same tx; impossible.
- **Registry poisoning by attacker registering arbitrary address**: Only `createPool` writes to `isPool` and `_allPools` / `_poolsByCollection`. No external access path.
- **One-pool-per-collection invariant bypass**: There is intentionally NO such invariant — multiple pools per collection are by design.
- **Clone storage layout collision with implementation**: Clones don't share storage with implementation (delegatecall reads/writes to clone's own storage); `Initializable` slot is well-defined and standard.
- **Constructor args replicated correctly to clone**: Factory passes all init params explicitly to `pool.initialize(...)`. Pool's constructor only runs `_disableInitializers`.
- **Cancellation of pending deploy**: No pending-deploy concept; `createPool` is single-tx atomic. No-op.
- **Re-entrancy in fee transfer (`withdrawProtocolFees` → `WETHFallbackLib`)**: 10k gas stipend prevents cross-contract reentrancy; `nonReentrant` modifier on caller. Safe.
- **`PROTOCOL_FEE_DELAY = 48h` exceeds `TimelockAdmin.MAX_DELAY = 30 days`**: 48h < 30d. OK.
- **Salt aliasing across PoolType enum range**: `uint8(_poolType)` covers BUY=0, SELL=1, TRADE=2; encoded as 1 byte. No aliasing.

---

## Bottom Line

`TegridyNFTPoolFactory.sol` is well-hardened. Salt construction, atomic init, registry membership, and reentrancy guards all look correct. Findings are minor (LOW) consistency / observability items rather than exploitable vulnerabilities. Most defenses-in-depth (EIP-7702 detection in `OwnableNoRenounce`, 10k-gas stipend in `WETHFallbackLib`, `_swapCaller` gating in pool's `onERC721Received`) come from sibling components and reinforce the factory's safety.

No critical or high-severity issues identified by this fresh-eyes pass.
