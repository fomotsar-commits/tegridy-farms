# Audit 034 — Initializer + Proxy Storage Collision Review

**Scope:** `contracts/src` — initializer modifiers, `_disableInitializers`, clone-init front-run windows, storage collisions, takeover vectors.

**Files inspected:**
- `contracts/src/TegridyNFTPool.sol` (Initializable + Clones template)
- `contracts/src/TegridyNFTPoolFactory.sol` (Clones.cloneDeterministic)
- `contracts/src/TegridyDropV2.sol` (Initializable + Clones template)
- `contracts/src/TegridyLaunchpadV2.sol` (Clones.cloneDeterministic)
- `contracts/src/TegridyPair.sol` (custom `_initialized` bool, NOT OZ Initializable)
- `contracts/src/TegridyFactory.sol` (CREATE2 raw — no Clones)

---

## HIGH

### H-034-1 — `TegridyPair.sol`: `initialize(_token0, _token1)` is **not protected by OZ Initializable** and uses a hand-rolled `_initialized` bool with **no `_disableInitializers()` on the implementation**

**File:** `contracts/src/TegridyPair.sol` lines 42–82
**Why:** TegridyPair inherits `ERC20, ReentrancyGuard` — *not* `Initializable`. It uses a private `bool _initialized` flag and gates `initialize()` with `require(msg.sender == factory, "FORBIDDEN");`. The `factory` is set in the **constructor** to `msg.sender`. Because `TegridyFactory.createPair` deploys via `create2` (raw assembly bytecode, NOT `Clones.clone`) and immediately calls `initialize(token0, token1)` in the same transaction, this works in practice today.

**Risks present:**
1. **No `_disableInitializers()` — but pair is full deploy (not a clone), so the implementation has its own factory==deployer storage; OK in current pattern, BUT if anyone ever swaps `create2(bytecode)` to `Clones.clone(implementation)`, the implementation contract becomes unprotected and anyone could call `initialize()` on the implementation directly.**
2. The `factory` slot is set via constructor on every deployed pair (since `create2` deploys a full bytecode each time, not a proxy) — so the `require(msg.sender == factory)` check is enforced per-pair correctly today.
3. **However**, `initialize()` is `external` with no `initializer` modifier — it relies entirely on `_initialized` boolean. A subtle bug: there is no event preventing reinitialization of `factory` itself (only `token0/token1` are guarded).

**Severity rationale:** The current factory deployment is safe in isolation — a fresh pair has `factory = msg.sender` set in its own constructor, so only the deploying factory can call `initialize`. But a future migration to `Clones.clone(pair)` would brick this guard since clones never run constructors. Flag as HIGH because the codebase mixes deployment patterns (raw CREATE2 here, `Clones.cloneDeterministic` in V2 / NFTPoolFactory) and a maintainer might "optimize" this without realizing the constructor sets `factory`.

**Recommend:** inherit `Initializable`, add `constructor() { _disableInitializers(); }`, replace `_initialized` with `initializer` modifier — even though `create2` is currently used, defense-in-depth.

---

## MEDIUM

### M-034-1 — `TegridyNFTPoolFactory.createPool` salt is **predictable and front-runnable for griefing** (CREATE2 squat)

**File:** `contracts/src/TegridyNFTPoolFactory.sol` lines 144–147
**Issue:** Salt = `keccak256(abi.encodePacked(msg.sender, _allPools.length, nftCollection, uint8(_poolType)))`.
- `_allPools.length` is **public state readable on-chain**.
- An attacker who can predict the next pool's CREATE2 address (deterministic from salt + factory address + impl) can:
  1. Send ETH/NFTs to that address before the victim's tx mines.
  2. Deploy code there via Nick's method — wait, no, CREATE2 salt + factory + impl is deterministic; attacker cannot inject code at the predicted address because they don't control the factory's CREATE2.
- **Actual exploitable concern:** salt uses `abi.encodePacked` with multiple non-string dynamic-ish fields. While these are all fixed-size (address/uint/uint8), packed encoding is fine here — no collision. ✓
- **The real medium-severity issue:** `initialize()` runs in the same transaction (line 153), so there is no **separable hijack window** for someone to call `initialize()` on the freshly-cloned pool first. ✓ Comment correctly states this.
- **However**, if `pool.call{value: msg.value}("")` (line 171) ever fails after the clone has been created and initialized, the pool is created but with no ETH liquidity. The `require(success, "ETH_TRANSFER_FAILED")` reverts the whole tx — atomic, OK. ✓

**Lower severity, but flagging:** the contract documents this issue (H-08 comment lines 138–143) and addressed it. Verify in fork test that `_allPools.length` is read from storage post-mutation in case of nested calls. **Rated MEDIUM** because the front-run vector is correctly closed today but rests entirely on atomic-init invariant.

### M-034-2 — `TegridyNFTPool.initialize()` has **no `factory` reentrancy guard**: if `_factory` is malicious during clone init, no callbacks happen — but `weth` can be poisoned

**File:** `contracts/src/TegridyNFTPool.sol` lines 138–175
**Issue:** During `initialize()`, parameters `_factory` and `_weth` are stored without verifying they are contracts. The factory caller (`TegridyNFTPoolFactory`) passes `address(this)` and an immutable `weth`. ✓
- However, **anyone can directly clone the implementation** (`poolImplementation` is `immutable public` on line 35 of the factory) and call `Clones.cloneDeterministic` themselves on the implementation address with arbitrary salt, then call `initialize()` with a fake factory and fake weth. This produces a **rogue pool not indexed by the factory** that imitates a real pool.
- **Risk:** a rogue pool indexed off-chain (via `PoolInitialized` event) could trick UIs that don't filter by factory-emitted `PoolCreated`. Frontends MUST listen only to `TegridyNFTPoolFactory.PoolCreated`, not `TegridyNFTPool.PoolInitialized`.

**Severity:** MEDIUM — depends on front-end indexing discipline.

### M-034-3 — `TegridyDropV2.initialize` storage slots vs. ERC721 base — **storage layout fragility on future upgrades**

**File:** `contracts/src/TegridyDropV2.sol` lines 19, 81–115
**Issue:** Contract inherits `ERC721, ERC2981, ReentrancyGuard, Pausable, Initializable`. The implementation uses regular constructors `ERC721("","")` for the base. This is a **clones template** (not a UUPS upgradeable proxy), so storage-layout-on-upgrade is N/A — clones are immutable code at the implementation address. ✓ However:
- `_dropName / _dropSymbol` are stored at slots determined by inheritance order. Any future change adding a base contract before `ERC721` shifts all slots and breaks every existing clone (since clones DELEGATECALL into the implementation). **Maintainers must NEVER reorder inheritance**, or every existing TegridyDropV2 clone breaks instantly.
- No `__gap` reserved slots — typical for non-upgradeable Initializable patterns, but flagging for documentation.

**Severity:** MEDIUM — operational footgun, not exploitable today.

---

## LOW

### L-034-1 — `TegridyPair.initialize()` lacks reinitializer protection if v2 ever needed
**File:** `TegridyPair.sol:74-82` — uses one-shot `_initialized`. No `reinitializer(version)` support means token0/token1 are immutable forever after init (correct), but no upgrade path. Acceptable for V2 AMM pattern.

### L-034-2 — `TegridyNFTPool.initialize()` zero-checks present but `_protocolFeeBps` not zero-checked at pool level
**File:** `TegridyNFTPool.sol:138-156` — relies on factory to bound protocolFeeBps via `MAX_PROTOCOL_FEE_BPS`. If factory was redeployed with a larger MAX, pool would still cap at its own constant (line 155). Defense-in-depth. ✓

### L-034-3 — `TegridyDropV2`: `owner = p.creator` set during init; no zero-address check on `owner` separately (creator already checked)
**File:** `TegridyDropV2.sol:166-185` — `owner` mirrors `creator`. Creator zero-checked on line 166. ✓

### L-034-4 — `TegridyFactory.createPair` uses raw CREATE2 with `keccak256(abi.encodePacked(token0, token1))` — pair address is deterministic per token pair
**File:** `TegridyFactory.sol:113-119` — Standard Uniswap V2 pattern. PAIR_EXISTS check on line 109 prevents reinit. ✓ No clone front-run because each pair is a full deployment with constructor setting `factory = msg.sender`.

---

## INFO / CONFIRMED-SAFE

- **`TegridyNFTPool` constructor calls `_disableInitializers()`** ✓ (line 124)
- **`TegridyDropV2` constructor calls `_disableInitializers()`** ✓ (line 23)
- **All initializer functions have explicit zero-address checks** ✓
- **Factories pass `address(this)` as the trusted factory address — not user-controlled** ✓
- **NFTPoolFactory salt includes `msg.sender` to prevent cross-user collisions** ✓
- **LaunchpadV2 salt uses `abi.encode` (not packed) for dynamic strings — collision-resistant** ✓

---

## SUMMARY COUNTS
- HIGH: 1
- MEDIUM: 3
- LOW: 4
- INFO: 5 (confirmed-safe patterns)
