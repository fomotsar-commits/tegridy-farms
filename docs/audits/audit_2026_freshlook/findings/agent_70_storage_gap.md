# Agent 70 — Upgradeable Storage Gap / ERC-7201 Namespace Audit

**Date:** 2026-05-07
**Lens:** UPGRADEABLE STORAGE GAP / `__gap` missing / OZ ERC-7201 namespace correctness / clone storage layout assumptions
**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`
**Scope:** All Solidity in `contracts/src/`

---

## Top-line conclusions (read this first)

1. **No UUPS / Transparent / Beacon proxies exist anywhere in `contracts/src/`.** Verified by:
   - `Grep` for `UUPSUpgradeable | TransparentUpgradeableProxy | ERC1967 | ProxyAdmin | _authorizeUpgrade | upgradeToAndCall | upgradeTo(` → **zero matches** in `contracts/src/`.
   - `Grep` for `@openzeppelin/contracts-upgradeable` import → **zero matches** in `contracts/src/`.
   - All OZ imports use the **non-`Upgradeable`** variants (`@openzeppelin/contracts/...`).
2. **Two contracts use OZ `Clones` (EIP-1167 minimal proxy):** `TegridyDropV2`, `TegridyNFTPool`. EIP-1167 minimal proxies are **NOT upgradeable** — the implementation address is hardcoded into the proxy bytecode, so per-clone storage layout drift is a non-issue once a clone is deployed.
3. **The two factories holding clone templates expose the implementation as `immutable`:** `TegridyLaunchpadV2.dropTemplate` (line 110) and `TegridyNFTPoolFactory.poolImplementation` (line 67). There is **no setter and no proxy** in front of these factories. So even *future* clones cannot inherit a swapped implementation — the only "upgrade" available is to deploy a brand-new factory + template pair on a fresh address, which is a hard fork, not a delegatecall upgrade.
4. **The remainder of the contracts are constructor-deployed standalone** (e.g. `TegridyFactory`, `SwapFeeRouter`, `PremiumAccess`, `TegridyLending`, `RevenueDistributor`, `CommunityGrants`, `MemeBountyBoard`, `POLAccumulator`, `GaugeController`, `TegridyStaking*`, `VoteIncentives*`, `Toweli`, `TegridyTWAP`, `TegridyRouter`, `TegridyLPFarming`, `TegridyRestaking`, `ReferralSplitter`, `TegridyNFTLending`, `TegridyFeeHook`). Some (`TegridyFeeHook`) deploy via Arachnid's deterministic deployer for hook-flag salt mining, but this is plain CREATE2 to a singleton — no delegatecall, no upgrade path, **storage gaps are not applicable.**
5. **`TegridyPair` is deployed via raw CREATE2 from `TegridyFactory`, not via clones.** Each pair runs its own constructor (`ERC20("Tegridy LP", "TGLP")` and `factory = msg.sender`), holding a fully deployed bytecode copy. Storage layout is per-deployment and not shared via delegatecall — `__gap` is structurally unnecessary.

**Conclusion:** This codebase has **no live upgradeable-storage attack surface**. There are no UUPS implementations whose v2 could shift slots; the only delegatecall-bearing instances are EIP-1167 minimal proxies whose implementation is locked at factory-deploy time. The "kept for storage layout" comments scattered across the code (e.g. `PremiumAccess._deprecated_paidFeeRate_slot`, `TegridyDropV2.unclaimedRefundPool`, `TegridyFactory.pendingGuardian`) refer to ABI / Etherscan / Foundry-cheat continuity for **already-deployed** instances — not to upgrade safety, since none of these contracts can be upgraded anyway.

The findings below document what I checked and the **two informational notes** worth carrying forward.

---

## F-70-1 (INFORMATIONAL / NON-FINDING) — No `__gap` declared in any base contract

**Files checked:**
- `contracts/src/base/OwnableNoRenounce.sol`
- `contracts/src/base/TimelockAdmin.sol`
- `contracts/src/lib/SequencerCheck.sol`
- `contracts/src/lib/VotePowerOracle.sol`
- `contracts/src/lib/SafeERC721Call.sol`
- `contracts/src/lib/WETHFallbackLib.sol`

**Observation:** None of the protocol's own abstract bases (`OwnableNoRenounce`, `TimelockAdmin`) declare a `uint256[N] private __gap;` storage gap. `Grep` for `__gap | storage gap` across `contracts/src/` returns **zero matches**.

**Why this is NOT a finding:**
- `OwnableNoRenounce` has zero state variables of its own (it inherits `Ownable2Step` whose `_owner` and `_pendingOwner` are non-namespaced slots in OZ v5 non-upgradeable). It is purely an override of `renounceOwnership` and `_transferOwnership`.
- `TimelockAdmin` has its own state (`_executeAfter`, `_proposalExpiresAt`, `_proposalDelay`, optional pending values), but **none of the contracts that inherit it are upgradeable.** Every consumer (`TegridyFactory`, `RevenueDistributor`, `PremiumAccess`, `CommunityGrants`, `MemeBountyBoard`, `POLAccumulator`, `GaugeController`, `TegridyStaking*`, `VoteIncentives*`, `TegridyLending*`, `TegridyTWAP`, `TegridyDropV2`, `TegridyNFTLending`, `ReferralSplitter`) is deployed monolithically (constructor) or as a non-upgradeable clone with an immutable factory template.
- `SequencerCheck.sol`, `VotePowerOracle.sol`, `SafeERC721Call.sol`, `WETHFallbackLib.sol` are pure libraries with no state — `__gap` is structurally not applicable.

**Scenario where it would matter:** If someone later wraps `PremiumAccess` (or any other `OwnableNoRenounce + ReentrancyGuard + Pausable + TimelockAdmin` consumer) behind a UUPS proxy, *then* the absence of `__gap` in the protocol's two abstract bases would allow a v2 of a single inheritance leg (e.g. adding a state variable to `TimelockAdmin`) to silently shift every subsequent slot in every child contract. But that scenario does not exist today — and switching to upgradeable would require migrating all OZ imports to `@openzeppelin/contracts-upgradeable`, which would be its own audit-grade task. Recommendation if upgradeability is ever introduced: add `uint256[50] private __gap;` to `TimelockAdmin` and any new inheritable base before the first upgradeable consumer ships.

---

## F-70-2 (INFORMATIONAL / NON-FINDING) — OZ v5 storage layout: namespaced vs. non-namespaced

**Verified library version:** `@openzeppelin/contracts v5.6.1` (`contracts/lib/openzeppelin-contracts/package.json` line 4).

The protocol uses **non-`Upgradeable`** OZ variants. In OZ v5, the per-base storage policy is mixed:

| OZ v5 contract | File | Storage style | Slot footprint |
|---|---|---|---|
| `Initializable` | `proxy/utils/Initializable.sol` (v5.3.0) | **ERC-7201 namespaced** at slot `0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00` | 0 regular slots |
| `ReentrancyGuard` | `utils/ReentrancyGuard.sol` (v5.5.0) | **ERC-7201-style** namespaced at slot `0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00`, marked `@custom:stateless` (deprecated in v6.0) | 0 regular slots |
| `Pausable` | `utils/Pausable.sol` (v5.3.0) | Regular `bool private _paused` (slot 0 of its own range) | 1 regular slot |
| `Ownable` | `access/Ownable.sol` | Regular `address private _owner` | 1 regular slot |
| `Ownable2Step` | `access/Ownable2Step.sol` | Regular `address private _pendingOwner` (atop `Ownable`) | 1 regular slot |
| `ERC20` | `token/ERC20/ERC20.sol` | Regular slots: `_balances`, `_allowances`, `_totalSupply`, `_name`, `_symbol` | 5 regular slots |
| `ERC721` | `token/ERC721/ERC721.sol` | Regular slots: `_name`, `_symbol`, `_owners`, `_balances`, `_tokenApprovals`, `_operatorApprovals` | 6 regular slots |
| `ERC2981` | `token/common/ERC2981.sol` | Regular slots: `_defaultRoyaltyInfo`, `_tokenRoyaltyInfo` | 2 regular slots |

**Why this is NOT a finding:**
The fact that `Initializable` and `ReentrancyGuard` are namespaced (and the others are not) only matters in an **upgradeable** context. Since no contract here is upgradeable, the mix is harmless — every clone of `TegridyDropV2` and `TegridyNFTPool` simply gets the deterministic concatenation of these layouts because `Clones` deploys a minimal proxy whose delegatecall target (the implementation) has a fixed layout that is locked-in once the factory's `immutable` template address is set.

**Scenario where it would matter:** Same as F-70-1. If `TegridyDropV2` were ever moved from an EIP-1167 clone to an EIP-1967 / UUPS proxy (so that the implementation can be upgraded), then a future OZ minor release that **adds a regular-slot field to `Pausable`, `Ownable2Step`, or `ERC2981`** would shift every regular slot inheriting those, including `TegridyDropV2`'s own slots. The currently-namespaced `Initializable` / `ReentrancyGuard` storage would survive untouched, but the pre-namespace contracts would corrupt. This is the well-known "OZ v5 layout-stability caveat" — `@custom:storage-location erc7201:...` on `Initializable` and `ReentrancyGuard` was OZ's first step toward fully-namespaced bases, which is **not yet complete** in v5. Watch the v6 changelog for more namespacing migrations.

---

## F-70-3 (INFORMATIONAL / NON-FINDING) — `TegridyDropV2` clone storage layout (`Initializable` last)

**File:** `contracts/src/TegridyDropV2.sol:21`
**Inheritance order:**
```solidity
contract TegridyDropV2 is ERC721("", ""), ERC2981, ReentrancyGuard, Pausable, Initializable, TimelockAdmin
```

**Effective storage layout (left = first slot):**
```
ERC721 (6 regular slots: _name="", _symbol="", _owners, _balances, _tokenApprovals, _operatorApprovals)
ERC2981 (2 regular slots: _defaultRoyaltyInfo, _tokenRoyaltyInfo)
ReentrancyGuard (0 regular slots; namespaced)
Pausable (1 regular slot: _paused)
Initializable (0 regular slots; namespaced)
TimelockAdmin (3 regular slots + per-key mappings: _executeAfter, _proposalExpiresAt, _proposalDelay)
TegridyDropV2 own state (~30+ slots, see lines 177-377)
```

**Verified clone-safety of this layout:**
- `ERC721("", "")` constructor writes `""` (empty strings) to `_name` and `_symbol` slot positions 0 and 1 in the *implementation* — but on a clone, these slots are zero (default), and the contract overrides `name()` / `symbol()` (lines 461-462) to read from its own `_dropName` / `_dropSymbol` slots which **are** written inside `initialize()`. So the empty implementation values are intentionally never read. **Correct.**
- `_disableInitializers()` is called in the implementation's constructor (line 25), preventing the implementation itself from being initialized. **Correct.**
- The clone's `_storage` pointer for `Initializable` resolves to the namespaced slot, which is independent of regular-slot drift in `Pausable` / `ERC721`. **Correct.**
- `Clones.cloneDeterministic` includes `block.chainid + address(this) + msg.sender + collectionIndex + name + symbol` in the salt (LaunchpadV2:213-215), so cross-chain CREATE2 collisions are prevented and `abi.encode` (not `encodePacked`) blocks the dynamic-string collision class.

**Why this is NOT a finding:** The implementation contract address is `immutable` at `TegridyLaunchpadV2.dropTemplate` (line 110). No setter exists, so existing clones cannot have their delegatecall target swapped. The factory itself has no proxy in front of it (it's constructor-deployed, see `TegridyLaunchpadV2.constructor` at line 177: `dropTemplate = address(new TegridyDropV2());`). Therefore no one — not even the protocol owner — can rotate the implementation that existing clones delegate-call into. Storage drift between v1 and v2 implementations is irrelevant since v2 would be a separate factory deploy with separate clones.

---

## F-70-4 (INFORMATIONAL / NON-FINDING) — `TegridyNFTPool` clone storage layout

**File:** `contracts/src/TegridyNFTPool.sol:30`
**Inheritance order:**
```solidity
contract TegridyNFTPool is IERC721Receiver, ReentrancyGuard, Pausable, Initializable
```

**Effective layout:**
```
IERC721Receiver (interface, 0 slots)
ReentrancyGuard (0 regular slots; namespaced)
Pausable (1 regular slot: _paused)
Initializable (0 regular slots; namespaced)
TegridyNFTPool own state (lines 34-115)
```

`_disableInitializers()` is called in the implementation constructor (line 216). `initialize()` at line 219 is gated by `initializer` modifier. Same clone-safety reasoning as F-70-3: `poolImplementation` is `immutable` (line 67), set at factory construction (line 181: `poolImplementation = address(new TegridyNFTPool());`). No setter. No upgrade.

**Salt construction (line 229-238):** `abi.encodePacked(block.chainid, address(this), msg.sender, _allPools.length, nftCollection, uint8(_poolType))`. Note this uses `encodePacked`, but the args here are all fixed-length (`uint256` chainid, two `address`es, `uint256` counter, one more `address`, and a `uint8`), so the encodePacked dynamic-collision class doesn't apply. **Correct.**

---

## F-70-5 (INFORMATIONAL / NON-FINDING) — `TegridyPair` rolls its own `_initialized` flag

**File:** `contracts/src/TegridyPair.sol:44`
**Inheritance:**
```solidity
contract TegridyPair is ERC20, ReentrancyGuard
```

**Observation:** Has a custom `bool private _initialized` (line 47) instead of inheriting OZ `Initializable`. Constructor at line 98 sets `factory = msg.sender`; `initialize(_token0, _token1)` at line 103 uses a manual one-shot guard.

**Why this is correct given the deployment model:** `TegridyFactory.createPair()` at lines 186-200 deploys via raw CREATE2 with `type(TegridyPair).creationCode`, then calls `initialize`. Each pair is **its own deployed contract** (full bytecode), not a minimal proxy — the constructor runs at every pair address, populating `factory`. The `_initialized` guard exists to prevent re-init by anyone other than the factory (which is also enforced by `require(msg.sender == factory)`). Using OZ `Initializable` here would be overkill (and would force the constructor to call `_disableInitializers()` to prevent direct init, which is irrelevant when the factory's own contract address is the only valid `msg.sender`). **Correct as-is.**

---

## F-70-6 (INFORMATIONAL / NON-FINDING) — Stale "storage layout" comments

Several contracts contain comments asserting they preserve storage layout for "deployed instances":
- `contracts/src/PremiumAccess.sol:62-64` — `_deprecated_paidFeeRate_slot` "kept for storage compat".
- `contracts/src/TegridyDropV2.sol:265-272` — `unclaimedRefundPool` "kept ONLY for storage-layout / ABI backward compatibility with existing clones".
- `contracts/src/TegridyFactory.sol:115-119` — `pendingGuardian` "appended at the end of the storage layout to preserve slot positions for existing test cheats".
- `contracts/src/TegridyStaking.sol:230` / `:335` — `Storage layout: APPENDED — does NOT reshuffle any existing slots.`
- `contracts/src/SwapFeeRouter.sol:309-321` — explicitly notes "SwapFeeRouter is constructor-deployed standalone (no UUPS / proxy / Initializable pattern), so storage layout is not a constraint here."

**Observation:** These are **conscientious notes** for maintaining ABI / Foundry `vm.store` cheat / Etherscan-decoder continuity for **already-deployed** instances. None of them imply an actual upgrade pathway. The `SwapFeeRouter` comment is the most explicit evidence of this — the team is aware that storage layout is not a security constraint here and removed dead slots accordingly.

**Edge case worth carrying forward:** `TegridyDropV2.unclaimedRefundPool` (line 272) is a `uint256` permanently-zero slot retained "for existing clones". Since clones cannot be upgraded, the only "existing clones" are those already deployed and frozen at the previous `dropTemplate` address — they can never delegatecall into the new layout, so the layout-preservation argument is somewhat orphaned (those clones literally don't see the new code). Likely the comment is precautionary for off-chain indexers reading slot N via raw `eth_getStorageAt`. Not a security issue; minor stylistic note.

---

## F-70-7 (DEAD-END) — No ERC-7201 namespaced storage in protocol code

`Grep` for `@custom:storage-location erc7201 | namespaced storage | StorageSlot.getStruct` across `contracts/src/` returns no protocol-level usage. The protocol does not implement ERC-7201 itself; only the OZ bases that already use it (`Initializable`, `ReentrancyGuard`) provide namespaced slots. This is consistent with the no-upgradeability stance and is **not** a finding.

---

## F-70-8 (DEAD-END) — `keccak256(abi.encode(...))` patterns are NOT ERC-7201

Multiple matches showed up under the `keccak256(abi.encode` query:
- `ReferralSplitter.sol:208/537/547/557/573` — `keccak256(abi.encode("CALLER_GRANT", _caller))` for permission key derivation.
- `CommunityGrants.sol:742` — `keccak256(abi.encode(CANCEL_APPROVED_KEY, _proposalId))` for cancel-approval ID.
- `TegridyFactory.sol:194` — CREATE2 salt for pair deployment.
- `TegridyFeeHook.sol:248` — pool-key hash for allowlist.
- `TegridyDropV2.sol:539` — merkle leaf hash.
- `VoteIncentives.sol:1487` — claim-signature digest.

**Observation:** These are application-domain hashing (mapping keys, salts, leaves), **NOT** ERC-7201 storage-location derivation. The ERC-7201 derivation uses the specific formula `keccak256(abi.encode(uint256(keccak256(<id>)) - 1)) & ~bytes32(uint256(0xff))` and produces a `bytes32` *constant* used as the slot pointer. None of the protocol code uses this pattern. **Not a finding.**

---

## F-70-9 (DEAD-END) — `TegridyTokenURIReader` and other periphery

Read inheritance/imports across `TegridyTokenURIReader.sol`, `TegridyRouter.sol`, `TegridyStakingJbacVault.sol`, `Toweli.sol`, `RevenueDistributor.sol`, `POLAccumulator.sol`, `VoteIncentives.sol`, `GaugeController.sol`, `CommunityGrants.sol`, `MemeBountyBoard.sol`, `TegridyLending*`, `TegridyLPFarming`, `TegridyRestaking`, `TegridyStaking*`, `TegridyTWAP`, `TegridyNFTLending`, `ReferralSplitter`, `TegridyFeeHook`, `SwapFeeRouter*`, `VoteIncentivesAdmin`, `TegridyNFTPoolFactory`. All are constructor-deployed standalone contracts inheriting non-`Upgradeable` OZ. None use proxy patterns. None expose an `_authorizeUpgrade` or `upgradeTo` selector. Storage gap is structurally irrelevant.

---

## Summary table of clone-target / proxy-like deployments

| Contract | Deployment | Storage-layout hazard? |
|---|---|---|
| `TegridyDropV2` | EIP-1167 minimal proxy via `Clones.cloneDeterministic` | **No** — `dropTemplate` is `immutable`, no swap path |
| `TegridyNFTPool` | EIP-1167 minimal proxy via `Clones.cloneDeterministic` | **No** — `poolImplementation` is `immutable`, no swap path |
| `TegridyPair` | Raw CREATE2 (full bytecode, own constructor) | **No** — full deploy, not a proxy |
| `TegridyFeeHook` | Arachnid deterministic deployer (full bytecode CREATE2) | **No** — full deploy, not a proxy |
| All others | Constructor (monolithic) | **No** — single, non-upgradeable instance |

---

## Recommendations carried forward (NOT findings)

These are deferred-only, contingent on a future architectural shift:

1. **If upgradeability is ever introduced**, migrate to `@openzeppelin/contracts-upgradeable` (which uses fully-namespaced ERC-7201 storage on every base), and add a `uint256[50] private __gap;` to `TimelockAdmin` and any new inheritable base before the first proxy ships.
2. **Watch the OZ v6 release** for further namespacing of `Pausable`, `Ownable2Step`, `ERC721`, etc. The v5.5.0 deprecation note on `ReentrancyGuard` (`IMPORTANT: Deprecated. This storage-based reentrancy guard will be removed and replaced by the {ReentrancyGuardTransient} variant in v6.0.`) signals that an OZ bump to v6 will require a controlled storage-layout migration audit, regardless of upgradeability stance.
3. **The `TegridyDropV2.unclaimedRefundPool` permanent-zero slot** (line 272) could be removed in any future "v3" template (since the orphaned slot only matters to old clones that cannot delegatecall into the new code anyway). Cosmetic only.

---

## Verification log (commands run)

- `Grep "__gap | Initializable | initialize\\s*\\( | UUPSUpgradeable | Upgradeable | proxy | Proxy"` across `contracts/src/` — listed 13 files, all using only `Initializable` (not `UUPSUpgradeable`).
- `Grep "@openzeppelin/contracts(-upgradeable)?/"` across `contracts/src/` — confirmed all imports are non-upgradeable variants.
- `Grep "UUPSUpgradeable | TransparentUpgradeableProxy | ERC1967 | ProxyAdmin | _authorizeUpgrade | upgradeToAndCall | upgradeTo("` across `contracts/src/` — **zero matches**.
- `Grep "contracts-upgradeable"` across `contracts/` — only matches in `lib/openzeppelin-contracts/CHANGELOG.md` and v4 sub-libs, not in `src/`.
- `Grep "LibClone | Clones\\.clone | cloneDeterministic | create2 | CREATE2 | clone\\( | Clones\\."` — confirmed only `TegridyDropV2` and `TegridyNFTPool` are clones; all others use raw CREATE2 or constructor.
- `Grep "__gap | storage gap | layout"` — zero `__gap` declarations; layout comments are about ABI continuity, not upgrade safety.
- `Grep "ERC7201 | namespaced | bytes32 (private |internal )?constant.*[Ll]ocation | bytes32 (private |internal )?constant.*SLOT | keccak256\\(abi\\.encode"` — no protocol-level ERC-7201 usage; `keccak256(abi.encode(...))` matches are all application-domain hashing.
- `Grep "setImplementation | updateImplementation | setDropTemplate | setPoolImplementation | template[A-Z] | dropTemplate"` — both factory templates (`dropTemplate`, `poolImplementation`) are `immutable`, no setter.
- Read OZ source: `Initializable.sol` (namespaced, slot `0xf0c57e16...`), `ReentrancyGuard.sol` (namespaced, slot `0x9b779b17...`, marked `@custom:stateless`/deprecated v6), `Pausable.sol` (regular `bool _paused`), `Ownable.sol` (regular `address _owner`), `Ownable2Step.sol` (regular `address _pendingOwner`), `ERC20.sol` and `ERC721.sol` (regular slots).
- Verified OZ version: `5.6.1` (`contracts/lib/openzeppelin-contracts/package.json:4`).

---

## Final verdict

**No exploitable findings under this lens.** The codebase deliberately avoids the upgradeable-storage attack surface by:
1. Refusing UUPS / Transparent proxies entirely.
2. Locking clone-template addresses as `immutable` in their factories.
3. Using OZ non-`Upgradeable` variants throughout (acceptable because no upgrade path exists).
4. Maintaining defensive layout-stability comments for off-chain ABI / cheat continuity, **not** for upgrade-driven slot pinning.

The only forward-looking risk vector is a **future architectural shift** to upgradeability without first auditing for `__gap` placement and ERC-7201 migration on bases like `TimelockAdmin`. That risk is dormant today.

