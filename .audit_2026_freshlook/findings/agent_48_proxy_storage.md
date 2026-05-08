# Agent 48 — Proxy / Storage / __gap Discipline Audit

**Lens**: Storage collision, proxy upgrade safety, __gap discipline, clone-impl drift.
**Scope**: All contracts under `contracts/src/`.
**Date**: 2026-05-07.
**Method**: Read-only inspection. No edits.

---

## TL;DR

The protocol uses ONLY EIP-1167 minimal proxies (OZ `Clones.cloneDeterministic`) for two contracts:
1. `TegridyDropV2` (templated by `TegridyLaunchpadV2`)
2. `TegridyNFTPool` (templated by `TegridyNFTPoolFactory`)

It uses **no UUPS, no Beacon, no Transparent proxy, no ERC-1967 storage slots, and no `delegatecall`** anywhere in `contracts/src`. The implementation address of every clone is hardcoded into the EIP-1167 bytecode and **cannot be upgraded**. This eliminates the entire class of upgrade-storage-drift vulnerabilities.

Both clone implementations correctly invoke `_disableInitializers()` in the implementation constructor. Both factory deployments are atomic (clone + initialize in the same transaction, no intermediate uninitialized state). OZ 5.6.1 is used; `Initializable` and `ReentrancyGuard` use ERC-7201 namespaced storage which structurally cannot collide with ordinary Solidity slot storage.

The remaining concerns are LOW or INFORMATIONAL — design footguns and indexer-fragility hazards, not on-chain exploitable bugs. Nothing CRITICAL or HIGH was uncovered through the storage / proxy / __gap lens.

---

## Findings

### F-48-A — `acceptOwnership` defensive-style asymmetry between the two clones (INFORMATIONAL)

**Files**:
- `contracts/src/TegridyDropV2.sol:1092-1095`
- `contracts/src/TegridyNFTPool.sol:548-563`

**Detail**: TegridyNFTPool's `acceptOwnership()` explicitly guards `msg.sender == address(0)` (line 560). TegridyDropV2's `acceptOwnership()` checks only `msg.sender != pendingOwner` (line 1093). On the IMPL contract, `pendingOwner == address(0)`. If `msg.sender` could ever equal `address(0)`, an attacker would seize ownership of the IMPL of TegridyDropV2.

**Impact**: Inert in current EVM semantics — `msg.sender` is never 0 in any executable transaction (the protocol forbids zero-address signing). This is a pure consistency observation: one clone uses a belt-AND-suspenders explicit zero check; the other doesn't.

**On-upgrade hazard**: If a future protocol upgrade ever introduces an EIP that could relax this invariant (none currently planned), TegridyDropV2's IMPL would be ownable — though the IMPL is functionally inert (`_initialized = type(uint64).max` blocks `initialize()`, `mintPhase == CLOSED` blocks `mint()`, etc., so the seized ownership would not extract value, only enable annoyance like `pause()`).

**Recommendation**: Add `if (msg.sender == address(0)) revert NotOwner();` to TegridyDropV2's `acceptOwnership` for parity with the sibling clone.

---

### F-48-B — `renounceOwnership()` declared without inheriting Ownable (INFORMATIONAL)

**File**: `contracts/src/TegridyDropV2.sol:1131-1133`

**Detail**: TegridyDropV2 has its own `address public owner` and `pendingOwner` (lines 177-178) — it does NOT inherit OZ's `Ownable` / `Ownable2Step`. The `renounceOwnership() external view onlyOwner { revert("RENOUNCE_DISABLED"); }` at line 1131 is a STANDALONE function that simply reverts; it is NOT an `override` of any inherited function.

**Impact**: None. The function reverts on every call. Documenting only because reading the line in isolation suggests an inheritance pattern that does not exist in this contract.

---

### F-48-C — No `__gap` storage reservation in clone implementations (LOW)

**Files**:
- `contracts/src/TegridyDropV2.sol` (entire file — no `__gap`)
- `contracts/src/TegridyNFTPool.sol` (entire file — no `__gap`)
- `contracts/src/base/TimelockAdmin.sol` (no `__gap`)
- `contracts/src/base/OwnableNoRenounce.sol` (no `__gap`)

**Detail**: Grep for `__gap` across the entire `contracts/src/` tree returns zero matches in any contract or base library. No reserved storage gap arrays exist.

**Why this normally matters**: Upgradeable proxy patterns (UUPS / Transparent) reserve `__gap` arrays so future versions can add state variables without shifting the slots of derived contracts. Without `__gap`, adding a state variable in a base contract would shift every derived contract's storage layout — corrupting all upgraded clones.

**Why this is LOW (not HIGH) here**: 
- The codebase uses ONLY EIP-1167 minimal proxies. Each clone is structurally bound to a single immutable implementation address (the address is baked into the 45-byte clone bytecode).
- A NEW factory deployed with NEW TegridyDropV2 bytecode produces clones that point to the new IMPL — old clones still point to the old IMPL. There is NO path to "upgrade" an existing clone in-place. So drifting storage layouts across versions cannot corrupt any deployed clone.
- BUT: off-chain indexers, multisig dashboards, and Tenderly-style monitoring tools that read storage by slot via `eth_getStorageAt(clone, N)` will silently observe wrong fields if the storage layout drifts between factory versions. The protocol currently relies entirely on auto-generated public ABI getters; if any indexer ever moves to direct slot reads (a common optimization), it will break across factory revs.

**Reproducer concern**: TegridyDropV2 declares state variables in scattered locations (lines 177, 322, 359, 375, 700) — this is a maintenance footgun. Inserting a new field "between" existing fields shifts every later slot. With no gap, there is no future-proofing buffer.

**Recommendation**: Append `uint256[50] private __gap;` at the END of state-var declarations in:
1. `TegridyDropV2` after `pendingMerkleRoot` (line 700)
2. `TegridyNFTPool` after the last storage var
3. `TimelockAdmin` after `_executeAfter`
4. `OwnableNoRenounce` (after Ownable2Step's `_pendingOwner` — though OZ already has its own gap conventions)

This costs zero gas (uninitialized storage) and gives future-version state-var insertion a non-shifting buffer.

---

### F-48-D — Implementation's `_paused` slot starts at 0 in clones (vs constructor-initialized to false in IMPL) (INFORMATIONAL — non-issue)

**Files**:
- `contracts/src/TegridyDropV2.sol` (inherits `Pausable`)
- `contracts/src/TegridyNFTPool.sol` (inherits `Pausable`)

**Detail**: OZ 5.x `Pausable` declares `bool private _paused;` as a regular state variable (NOT ERC-7201 namespaced). The IMPL's `_paused` slot is implicitly initialized to `false` (zero-init). Clones also start at `false`. No drift.

**Why I flagged it**: `Pausable` is a plain (non-upgradeable) module, and reads its `_paused` from a normal slot. If any future inheritance reordering places `Pausable` at a different position, the slot offset of `_paused` would change — but since both impl and clones share the same bytecode runtime, this can only matter for off-chain indexer consistency across factory versions. Not on-chain exploitable.

---

### F-48-E — OZ 5.5+ ReentrancyGuard's first-call gas cost slightly higher on clones (INFORMATIONAL)

**Files**:
- `contracts/src/TegridyDropV2.sol`
- `contracts/src/TegridyNFTPool.sol`

**Detail**: `OZ 5.5+ ReentrancyGuard` constructor (`constructor() { _reentrancyGuardStorageSlot().getUint256Slot().value = NOT_ENTERED; }` — `lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol:58-60`) writes `1 (NOT_ENTERED)` to the ERC-7201 namespaced slot during IMPL construction. This is intentional: subsequent `nonReentrant` calls toggle 1→2→1, which gets the SLOAD-refund on the back-edge.

For CLONES, the slot starts at 0 (clones never run any constructor — neither the impl's nor any of the inherited bases'). So the first `nonReentrant` call on a clone toggles 0→2→1, missing the gas refund on that one call. Subsequent calls are 1→2→1 normally.

**Impact**: ~5k gas higher on the FIRST `nonReentrant` call to each clone, ever. No security impact; functional behavior is identical (the entered check is `value == 2`, which 0 satisfies as "not entered" just as 1 does).

**Recommendation**: None. This is a known property of EIP-1167 + OZ 5.5+ ReentrancyGuard and is not worth working around for ~5k gas one-time per clone.

---

### F-48-F — Inheritance order asymmetry across contracts (INFORMATIONAL)

**Files**: All admin contracts in `contracts/src/`.

**Detail**:
- Most contracts use `OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin` order.
- `TegridyNFTPoolFactory` uses `OwnableNoRenounce, Pausable, TimelockAdmin, ReentrancyGuard` (TegridyNFTPoolFactory.sol:22).
- `TegridyFeeHook` uses `IHooks, OwnableNoRenounce, Pausable, ReentrancyGuard, TimelockAdmin` (TegridyFeeHook.sol:50).

**Impact**: Functionally none — `ReentrancyGuard` and `Initializable` use ERC-7201 namespace storage so they contribute zero to slot layout. The other bases (Pausable: 1 slot, TimelockAdmin: 1 slot, Ownable+Ownable2Step: 2 slots) are all sequenced consistently across these orderings, so the slot layout for each contract's OWN fields starts at the same offset.

The asymmetry only matters for code-review readability. Not a vulnerability.

---

### F-48-G — Atomic clone+init verified for both factories (PASS)

**Files**:
- `contracts/src/TegridyLaunchpadV2.sol:217-235` — `cloneDeterministic` immediately followed by `initialize()` in same `createCollection()` call.
- `contracts/src/TegridyNFTPoolFactory.sol:239-255` — `cloneDeterministic` immediately followed by `initialize()` in same `createPool()` call.

**Detail**: There is no observable on-chain window between clone deployment and `initialize()`. An MEV searcher cannot front-run with their own `initialize(...)` call to seize the clone's owner / config slots.

**Pattern**: Matches Sudoswap V2 / Manifold ERC721LazyPayableClaim / 0xSplits. No issue.

---

### F-48-H — `TegridyPair` is NOT a clone, fully deployed via CREATE2 with own `_initialized` flag (PASS)

**Files**:
- `contracts/src/TegridyPair.sol:47, 103-111`
- `contracts/src/TegridyFactory.sol:194-200`

**Detail**: TegridyPair is deployed via raw `create2(0, add(bytecode, 32), mload(bytecode), salt)` (TegridyFactory.sol:196) using `type(TegridyPair).creationCode`. Each pair is a fully constructed contract with its own runtime bytecode and storage. TegridyPair uses a custom `bool private _initialized` flag (line 47) rather than OZ Initializable.

**Why this is fine**: Each pair has its OWN deployed bytecode → its own storage layout, no impl/clone separation. The `_initialized` flag prevents a second `initialize()` call (line 105). Constructor sets `factory = msg.sender` (line 99); `initialize()` requires `msg.sender == factory` (line 104) — which the TegridyFactory satisfies because it's the deployer AND the immediate caller.

**No `_disableInitializers` needed** — there's no impl/clone pair to lock.

---

### F-48-I — Storage layout summary for TegridyDropV2 (INFORMATIONAL — for indexer reference)

**File**: `contracts/src/TegridyDropV2.sol`

Inheritance: `ERC721("",""), ERC2981, ReentrancyGuard, Pausable, Initializable, TimelockAdmin`.

```
Slots from base contracts (read-only for TegridyDropV2-internal logic):
  slot 0 : ERC721._name
  slot 1 : ERC721._symbol
  slot 2 : ERC721._owners (mapping)
  slot 3 : ERC721._balances (mapping)
  slot 4 : ERC721._tokenApprovals (mapping)
  slot 5 : ERC721._operatorApprovals (mapping)
  slot 6 : ERC2981._defaultRoyaltyInfo (struct, address+uint96, packed)
  slot 7 : ERC2981._tokenRoyaltyInfo (mapping)
  [ReentrancyGuard: 0 slots, ERC-7201 namespace 0x9b779b...55f00]
  slot 8 : Pausable._paused (bool, 1 byte, padded)
  [Initializable: 0 slots, ERC-7201 namespace 0xf0c57e...6a00]
  slot 9 : TimelockAdmin._executeAfter (mapping)

TegridyDropV2 own state:
  slot 10 : owner (address)
  slot 11 : pendingOwner (address)
  slot 12 : _dropName (string head)
  slot 13 : _dropSymbol (string head)
  slot 14 : maxSupply (uint256)
  slot 15 : mintPrice (uint256)
  slot 16 : maxPerWallet (uint256)
  slot 17 : totalSupply (uint256)
  slot 18 : mintPhase (MintPhase enum, 1 byte, padded)
  slot 19 : merkleRoot (bytes32)
  slot 20 : _baseTokenURI (string head)
  slot 21 : _revealURI (string head)
  slot 22 : revealed (bool, padded)
  slot 23 : _contractURI (string head)
  slot 24 : dutchStartPrice
  slot 25 : dutchEndPrice
  slot 26 : dutchStartTime
  slot 27 : dutchDuration
  slot 28 : creator (address, padded)
  slot 29 : platformFeeRecipient (address, 20 bytes) + platformFeeBps (uint16, 2 bytes) packed
  slot 30 : weth (address, padded)
  slot 31 : mintedPerWallet (mapping)
  slot 32 : paidPerWallet (mapping)
  slot 33 : totalProceeds
  slot 34 : allowlistClaimed (mapping)
  slot 35 : cancelledAt
  slot 36 : withdrawn (bool, padded)
  slot 37 : unclaimedRefundPool
  slot 38 : baseURIFrozen (bool, padded)
  slot 39 : sequencerFeed (address, padded)
  slot 40 : pendingMintPrice
  slots 41-44 : pendingDutchConfig (struct, 4 uint256)
  slot 45 : pendingMerkleRoot (bytes32)
```

**Note on `unclaimedRefundPool` (slot 37)**: TegridyDropV2.sol:265-272 documents this as a DEPRECATED slot kept for ABI/storage-layout backward compatibility. Permanently zero on new clones. Verified: no write paths in the post-DEEP-DROP-05 codebase.

---

### F-48-J — Implementation contracts are inert under direct external calls (PASS)

Both impl contracts (TegridyDropV2 and TegridyNFTPool) have their `_initialized = type(uint64).max` after constructor's `_disableInitializers()`. Direct external calls to the impls:

| Function | TegridyDropV2 IMPL | TegridyNFTPool IMPL |
|----------|---------------------|----------------------|
| `initialize()` | reverts: InvalidInitialization | reverts: InvalidInitialization |
| `pause()` | reverts: NotOwner (owner=0) | reverts: NotOwner |
| `transferOwnership()` | reverts: NotOwner | n/a (uses `proposeOwnerChange`) |
| `acceptOwnership()` | reverts: NotOwner (pendingOwner=0, msg.sender ≠ 0) | reverts: NotPendingOwner (explicit zero check) |
| `mint()` | reverts: MintClosed (mintPhase=CLOSED) | n/a |
| `swapETHForNFTs()` | n/a | reverts on `factory.emergencyPaused()` (factory=0) decoding empty return |
| `swapNFTsForETH()` | n/a | reverts on `factory.emergencyPaused()` (factory=0) decoding empty return |
| `claimProtocolFees()` | n/a | reverts: NotFactory (factory=0, msg.sender ≠ 0) |
| `claimPriorOwnerLPFees()` | n/a | reverts: NoPriorOwnerCredit (priorOwnerOwed=0) |
| `withdrawETH() / withdrawNFTs()` | n/a | reverts: NotOwner |

No path to seize, drain, or perturb the implementation contract from a direct external call.

---

### F-48-K — TegridyTokenURIReader and other standalone contracts (PASS)

`TegridyTokenURIReader` and all other contracts under `contracts/src/` (CommunityGrants, MemeBountyBoard, POLAccumulator, ReferralSplitter, RevenueDistributor, SwapFeeRouter, GaugeController, PremiumAccess, TegridyLending, TegridyNFTLending, TegridyLPFarming, TegridyStaking, TegridyStakingJbacVault, TegridyTWAP, TegridyRestaking, VoteIncentives, etc.) are deployed via the standard `new ContractName(...)` pattern in tests and `script/Deploy*.s.sol`. They are NOT clones and NOT proxied. Each contract has its own deployed runtime bytecode and storage. Storage drift across versions is a redeploy concern only, not an upgrade concern.

`SwapFeeRouter.sol:316-317` explicitly notes: "SwapFeeRouter is constructor-deployed standalone (no UUPS / proxy / Initializable pattern), so storage layout is not a constraint here."

---

## Notes / Dead-Ends Explored

1. **Searched for `delegatecall`** across `contracts/src/` — only one match in `.slither.deadcode-suppress.md` (a comment about how dead-code suppression should be used for `delegatecall`-only-reachable functions). No actual `.delegatecall(...)` invocations in any Solidity source. Confirmed by grep with multiline disabled and case-insensitive: zero hits.

2. **Searched for ERC1967 / UUPS / Beacon / TransparentUpgradeable** in source — zero hits. Confirms no upgradeable-proxy infrastructure is used.

3. **Checked OZ version**: `lib/openzeppelin-contracts/package.json:4` → `5.6.1`. Initializable.sol is `v5.3.0`, ReentrancyGuard.sol is `v5.5.0`, Pausable.sol is `v5.3.0`. All use ERC-7201 namespaced storage where applicable.

4. **Checked Solady ERC721 storage hitchhiking** in `lib/solady/src/tokens/ERC721.sol:91-124`. Uses `_ERC721_MASTER_SLOT_SEED = 0x7d8825530a5a2e7a << 192` to derive slots via keccak256. The seed is large enough that derived slots cannot collide with sequential slot 0/1/2/... allocations (probability 2^-256).

5. **TegridyPair clone vs CREATE2**: Confirmed at `contracts/src/TegridyFactory.sol:186-198` that pairs are deployed via raw CREATE2 with `type(TegridyPair).creationCode`, not via Clones.cloneDeterministic. Each pair is a fully-constructed contract.

6. **`predictDeterministicAddress`** — zero usage in `contracts/src/`. Factories don't pre-compute clone addresses. The only path to a clone address is the `PoolCreated` / `CollectionCreated` event, emitted AFTER initialize(). No off-chain race-reservation.

7. **`reinitializer(...)` modifier** — zero usage in `contracts/src/`. Both clone implementations only use the basic `initializer` modifier. No multi-version init scheme. No way to re-run a partial init.

8. **`__gap` arrays** — zero usage. See F-48-C for analysis.

9. **`_disableInitializers()`** — verified at `TegridyDropV2.sol:25` and `TegridyNFTPool.sol:216`, both inside the implementation's constructor. Correctly locks the impl from any future `initialize()` call.

10. **Public state variable inheritance order** — verified that ReentrancyGuard and Initializable contribute zero slots (both ERC-7201 namespaced), so reordering them in inheritance lists doesn't shift slots. Pausable (1 slot), TimelockAdmin (1 slot), Ownable+Ownable2Step (2 slots) consistently appear at consistent positions across all contracts' inheritance lists.

11. **Beacon backdoor** — n/a. No beacon pattern used.

12. **Constructor-set immutable expected per-clone** — verified that NEITHER clone implementation declares any `immutable` state variable. TegridyDropV2.sol:218 explicitly documents: "Cannot be `immutable` — this contract is deployed as a clone via OZ Clones.clone() and clones cannot inherit immutable values from the implementation. Single-write in initialize() and never touched again gives the same security posture." The factory contracts (TegridyLaunchpadV2 and TegridyNFTPoolFactory) DO use `immutable` for their templates / weth / sequencerFeed — appropriate since they are NOT clones themselves.

13. **Re-init in clone re-bootstraps differently than constructor would have** — n/a. No reinit path exists. The single `initialize()` is one-shot under OZ's Initializable modifier. The IMPL constructor calls `_disableInitializers` which is irreversible (`_initialized = type(uint64).max`).

---

## Conclusion

The proxy / storage / __gap surface is **clean**. The protocol's deliberate choice to use ONLY EIP-1167 minimal proxies (no UUPS / Beacon / Transparent) eliminates the entire upgrade-storage-drift attack class. Both clone implementations are correctly locked at IMPL deploy via `_disableInitializers()`. Both factories perform atomic clone+initialize.

The most actionable finding is F-48-C (no `__gap` arrays) — LOW severity, indexer-fragility concern, structurally not exploitable on-chain because clones cannot be upgraded. F-48-A is INFORMATIONAL parity asymmetry between the two clones; F-48-B is a documentation cleanup; F-48-D / F-48-E / F-48-F are observations with no security impact.

**No CRITICAL, HIGH, or MEDIUM findings** in the proxy / storage / __gap dimension.
