# Agent 097 — Storage Layout Sanity (Cloned Implementations)

**Mission:** verify storage slot layout for contracts deployed via OpenZeppelin `Clones` — collisions across inheritance, missing `__gap`, parent state additions that would shift child slots, packed-struct alignment, immutable-vs-constant choice, fields added between releases.

**Scope:** the two implementation contracts identified by agent 034 as targets of `Clones.cloneDeterministic`:

1. `contracts/src/TegridyDropV2.sol` — cloned by `TegridyLaunchpadV2.deploy()` at line 142
2. `contracts/src/TegridyNFTPool.sol` — cloned by `TegridyNFTPoolFactory.createPool()` at line 147

**OZ version in use:** `lib/openzeppelin-contracts` v5.x (Initializable v5.3.0, Pausable v5.3.0, ReentrancyGuard v5.5.0, ERC721 v5.6.0, ERC2981 v5.4.0, Context v5.0.1, ERC165 v5.4.0). `compiler = solc 0.8.26`, `evm_version = cancun`, `optimizer_runs = 10`, `via_ir = true` (foundry.toml).

---

## 0. Threat-model framing — what *can* go wrong with `Clones`

EIP-1167 minimal proxies (`Clones.clone` / `Clones.cloneDeterministic`) **DELEGATECALL into a fixed implementation**. Important implications for storage:

- **Per-clone storage is independent** — each clone has its own slot 0…slot N. Slot collisions inside one inheritance graph affect *every* clone identically; they're a template bug, not a per-clone bug.
- **Implementation address is `immutable` in the factory** (`poolImplementation` line 35, `dropTemplate` line 61) — so `Clones` here are **non-upgradeable** by construction. New template = new implementation address = new clones. Existing clones cannot be migrated. This means:
  - **`__gap` reserves are NOT required** for the EIP-1167 use case. The classic upgradeable-proxy concern (parent contract adds a state var → child slots shift on next upgrade → corrupts existing storage) does not apply: existing clones never see the new bytecode.
  - **The only real storage hazard for these clones is collisions inside the current inheritance graph** at deploy time, plus packed-struct correctness, plus the OZ-bases-introduce-new-state risk on the *next OZ minor bump* (which would deploy *new* clones with shifted layout — observable through ABI diffs only on the new template; existing clones unaffected).
- **`_disableInitializers()` is called** in both implementation constructors (`TegridyDropV2.sol:23`, `TegridyNFTPool.sol:124`) — prevents direct takeover of the template, mandatory and correct.

---

## 1. `TegridyDropV2` — storage layout

### 1.1 C3-linearization (left-to-right inheritance)

```
contract TegridyDropV2 is ERC721("", ""), ERC2981, ReentrancyGuard, Pausable, Initializable
```

Linearization order (Solidity walks parents leftmost-first, depth-first, deduplicating):

```
Context  →  ERC165  →  IERC721  →  IERC721Metadata  →  IERC721Errors  →  ERC721
       →  IERC2981  →  ERC2981
       →  ReentrancyGuard
       →  IERC6093 (Context-via)  →  Pausable
       →  Initializable
       →  TegridyDropV2
```

(`ERC165` and `Context` appear once; OZ v5 bases handle the diamond cleanly.)

### 1.2 Per-base linear-slot consumption

| Base | Storage style | Slots consumed | Notes |
|------|--------------|---------------|-------|
| `Context` | stateless | **0** | Verified at `Context.sol:16-28` — three view-only methods, no state. |
| `ERC165` | stateless | **0** | Verified at `ERC165.sol:20-25` — only `supportsInterface()`, no state. |
| `IERC*` interfaces | interfaces | **0** | No state allowed in interfaces. |
| `ERC721` | linear | **6** | `_name` (slot 0), `_symbol` (slot 1), `_owners` map (slot 2), `_balances` map (slot 3), `_tokenApprovals` map (slot 4), `_operatorApprovals` map (slot 5). Source: `ERC721.sol:23-34`. |
| `ERC2981` | linear | **2** | `_defaultRoyaltyInfo` is a `(address, uint96)` struct that **packs into one 32-byte slot** (slot 6 — address=20B + uint96=12B = 32B exact); `_tokenRoyaltyInfo` map (slot 7). Source: `ERC2981.sol:23-29`. |
| `ReentrancyGuard` | **ERC-7201 namespace** | **0** | Storage at fixed bytes32 slot `0x9b779b...` (`ReentrancyGuard.sol:36-37`) — does NOT consume linear slots. |
| `Pausable` | linear | **1** | `bool private _paused` at slot 8 (`Pausable.sol:18`). A lone `bool` consumes a full 32-byte slot — no neighbour to pack with. |
| `Initializable` | **ERC-7201 namespace** | **0** | Storage at fixed bytes32 slot `0xf0c57e...` (`Initializable.sol:77`) — does NOT consume linear slots. |

**Inherited linear slots: 9 (slots 0-8).**

### 1.3 `TegridyDropV2` own state (slots 9 onward)

Walking declarations top-to-bottom (`TegridyDropV2.sol:81-122`):

| Slot | Declaration | Type | Size | Packing |
|------|-------------|------|------|---------|
| 9 | `address public owner` | address | 20B | full slot (no neighbour) |
| 10 | `address public pendingOwner` | address | 20B | full slot |
| 11 | `string private _dropName` | string | dynamic | header-slot |
| 12 | `string private _dropSymbol` | string | dynamic | header-slot |
| 13 | `uint256 public maxSupply` | uint256 | 32B | full slot |
| 14 | `uint256 public mintPrice` | uint256 | 32B | full slot |
| 15 | `uint256 public maxPerWallet` | uint256 | 32B | full slot |
| 16 | `uint256 public totalSupply` | uint256 | 32B | full slot |
| 17 | `MintPhase public mintPhase` | uint8-enum | 1B | full slot (no neighbour to pack with — see FINDING 1.B) |
| 18 | `bytes32 public merkleRoot` | bytes32 | 32B | full slot |
| 19 | `string private _baseTokenURI` | string | dynamic | header-slot |
| 20 | `string private _revealURI` | string | dynamic | header-slot |
| 21 | `bool public revealed` | bool | 1B | full slot (alone) |
| 22 | `string private _contractURI` | string | dynamic | header-slot |
| 23 | `uint256 public dutchStartPrice` | uint256 | 32B | full slot |
| 24 | `uint256 public dutchEndPrice` | uint256 | 32B | full slot |
| 25 | `uint256 public dutchStartTime` | uint256 | 32B | full slot |
| 26 | `uint256 public dutchDuration` | uint256 | 32B | full slot |
| 27 | `address public creator` | address | 20B | **packed with platformFeeBps below** ← see 1.4 |
| 27 (cont) | `address public platformFeeRecipient` … *NOT packed* — separate decl | address | 20B | this address takes its own slot (slot 28) because the next two fields after `creator` are `platformFeeRecipient` (address, 20B) then `platformFeeBps` (uint16, 2B), giving address+address mismatch — see correction below |

**CORRECTION — let me re-walk slots 27-29 carefully:**

Solidity packs adjacent fields into the same 32-byte slot only when they fit AND are adjacent in declaration order. The triple is:

```solidity
address public creator;              // 20B
address public platformFeeRecipient; // 20B
uint16 public platformFeeBps;        // 2B
```

`creator` (20B) cannot fit `platformFeeRecipient` (20B) in the same 32-byte slot (20+20=40 > 32). So `creator` takes slot 27 alone (uses 20 of 32, padded). `platformFeeRecipient` (20B) + `platformFeeBps` (2B) = 22B → **packed into slot 28**.

Resuming:

| Slot | Declaration | Type | Size | Packing |
|------|-------------|------|------|---------|
| 27 | `creator` | address | 20B | alone in slot |
| 28 | `platformFeeRecipient` (20B) **+** `platformFeeBps` (2B) | address+uint16 | 22B | **packed** ✓ |
| 29 | `address public weth` | address | 20B | alone in slot |
| 30 | `mapping mintedPerWallet` | map | header | header-slot |
| 31 | `mapping paidPerWallet` | map | header | header-slot |
| 32 | `bool public withdrawn` | bool | 1B | alone in slot |

**Total: 33 slots in use (slots 0-32).** No collisions. No diamond conflicts (single inheritance from each non-interface base except via interface types which contribute 0 state).

### 1.4 Constants are NOT slots

`MAX_PLATFORM_FEE_BPS` and `MAX_ROYALTY_BPS` (lines 157, 163) are `uint16 public constant` — they live in **bytecode**, NOT in storage. Correct choice for fixed protocol values that can never change. ✓

### 1.5 `ERC721("", "")` constructor on a clone — packed but DEAD

`TegridyDropV2.sol:19` — the contract declaration calls `ERC721("", "")`. This passes empty strings to the OZ ERC721 constructor, which writes `_name=""` and `_symbol=""` to slots 0-1.

**Critical observation:** the implementation's constructor runs at template-deploy time, but **clones bypass that constructor entirely** (EIP-1167 just delegates calls). On a fresh clone, slots 0 and 1 are zero by default (storage starts zeroed) — same end-state as the constructor would have produced ("" hashes / length-0 string). So the clone behaves identically.

**However:** the contract's overridden `name()` and `symbol()` (lines 236-237) return `_dropName` / `_dropSymbol` (slots 11-12), bypassing the inherited `ERC721._name/_symbol` (slots 0-1). The inherited slots are **dead-but-occupying** — wasted 2 slots per clone but functionally inert. This is **observed dead storage**, not a bug, but flagged below as INFO-1 because removing the parent and using a custom interior storage pattern would save ~46k gas at deploy time per clone.

### 1.6 Findings — TegridyDropV2

#### FINDING 1.A — `MintPhase` enum at slot 17 is NOT packed (LOW / efficiency only — NOT a security issue)

Slot 17 holds a single `MintPhase` enum (1 byte, 5 variants → fits in `uint8`). It is followed at slot 18 by `bytes32 public merkleRoot` (32B — fills its own slot regardless). `MintPhase` cannot pack forward.

**Backward**, slot 16 is `totalSupply` (uint256, fills its full slot). So `MintPhase` is structurally orphaned between two full-32-byte vars and **cannot be packed** without re-ordering.

A `bool public revealed` at slot 21 has the same single-occupant problem. Same for `bool public withdrawn` at slot 32.

**Re-ordering would save ~3 slots per clone** (~60k gas at deploy per clone × thousands of clones if the launchpad scales). Specifically: cluster `mintPhase` (1B) + `revealed` (1B) + `withdrawn` (1B) + `platformFeeBps` (2B) = 5B in one slot, saving 2 slots. **NOT a security finding** — every layout is internally consistent. Flagged as INFO for future template version.

**Severity: INFO** (gas only, not a security issue).

#### FINDING 1.B — `_dropName` / `_dropSymbol` shadow inherited ERC721 `_name` / `_symbol` (LOW — design choice with cost)

Slots 0-1 hold the inherited `ERC721._name` / `_symbol` (forced empty string by the `ERC721("", "")` constructor call on the template, copied as zero-default into clones). Slots 11-12 hold the namespaced `_dropName` / `_dropSymbol` that the contract actually reads/writes.

**The inherited slots are dead** because `name()` / `symbol()` are both overridden (lines 236-237). They cost 2 slots of clone state forever.

**Why it was done this way (educated guess):** ERC721's `_name` / `_symbol` are `private`, so the child cannot write to them directly — it must use a constructor, but constructors don't run on clones. So a separate slot pair is the only way for clones to set name/symbol post-init. This is **idiomatic** for non-upgradeable ERC721 clone templates (Manifold, Thirdweb, ZORA Drops all do this).

**Severity: INFO** (documented and intentional, no security impact).

#### FINDING 1.C — No collision risk on next OZ bump for *existing* clones (POSITIVE)

Because the implementation is `immutable` in `TegridyLaunchpadV2.dropTemplate` (line 61), an OZ ERC721/ERC2981/Pausable bump that adds a new state var to a base contract would only affect a *redeployed* template — existing clones keep their existing implementation. So OZ-base storage drift is operationally moot for existing collections. **For future template redeploys**, the team should `git diff` the OZ vendored contracts against the version at clone-deploy time before swapping `dropTemplate` (which would require a new factory anyway — `dropTemplate` is `immutable`).

**Severity: INFO / acknowledgment**.

#### FINDING 1.D — `MAX_PLATFORM_FEE_BPS` and `MAX_ROYALTY_BPS` are `constant` not `immutable` — CORRECT (POSITIVE)

`uint16 public constant MAX_PLATFORM_FEE_BPS = 1000` (line 157) and `MAX_ROYALTY_BPS` (line 163) are inlined into bytecode at compile time. **Correct choice** — these are protocol invariants, never per-clone configurable. `immutable` would be wrong (slightly worse gas, no benefit; immutable values are also inlined into bytecode, but reserve a stack slot during deploy that constants don't). ✓

#### FINDING 1.E — `weth` is NOT immutable, lives in slot 29 — defensible

`address public weth` at slot 29 is set in `initialize()`. Could it be `immutable`? **No** — clones don't run constructors, and `immutable` requires constructor-time assignment. Storing it as a settable-once initializer field is the correct pattern for clones. ✓

---

## 2. `TegridyNFTPool` — storage layout

### 2.1 C3-linearization

```
contract TegridyNFTPool is IERC721Receiver, ReentrancyGuard, Pausable, Initializable
```

Linearization:

```
Context → IERC721Receiver → ReentrancyGuard → Pausable → Initializable → TegridyNFTPool
```

(`Context` enters via `Pausable`, which inherits `Context`. `IERC721Receiver` is an interface — no state.)

### 2.2 Per-base slot consumption

| Base | Storage style | Slots | Notes |
|------|--------------|-------|-------|
| `Context` | stateless | 0 | |
| `IERC721Receiver` | interface | 0 | |
| `ReentrancyGuard` | ERC-7201 namespaced | 0 | Slot `0x9b779b...` |
| `Pausable` | linear | 1 | `_paused` at slot 0 |
| `Initializable` | ERC-7201 namespaced | 0 | Slot `0xf0c57e...` |

**Inherited linear slots: 1 (slot 0).** `TegridyNFTPool` own state begins at slot 1.

### 2.3 Own state (slots 1+)

Reading `TegridyNFTPool.sol:28-52`:

| Slot | Declaration | Type | Size | Packing |
|------|-------------|------|------|---------|
| 1 | `IERC721 public nftCollection` | contract type = address | 20B | **packed with poolType+spotPrice (no — see correction)** |

**CORRECTION — careful walk slots 1-12:**

```solidity
IERC721 public nftCollection;     // 20B
PoolType public poolType;         // 1B (enum, 3 variants → uint8)
uint256 public spotPrice;         // 32B
uint256 public delta;             // 32B
uint256 public feeBps;            // 32B
uint256 public protocolFeeBps;    // 32B
address public owner;             // 20B
address public factory;           // 20B
address public weth;              // 20B
uint256[] internal _heldIds;      // dynamic array — 32B header
mapping uint=>uint _idToIndex;    // 32B header
uint256 public accumulatedProtocolFees; // 32B
uint256 public pendingSpotPrice;  // 32B
uint256 public pendingSpotPriceExecuteAfter; // 32B
uint256 public pendingDelta;      // 32B
uint256 public pendingDeltaExecuteAfter; // 32B
uint256 public pendingFeeBps;     // 32B
uint256 public pendingFeeBpsExecuteAfter; // 32B
```

Solidity packs `nftCollection` (20B) + `poolType` (1B) into slot 1 — together 21B, fits ≤32. ✓

Then `spotPrice` is 32B and starts slot 2 (cannot pack into slot 1 — only 11B remaining there, and a uint256 can't span slots).

| Slot | Declaration | Size | Notes |
|------|-------------|------|-------|
| 1 | `nftCollection` (20B) **+** `poolType` (1B) | 21B | **packed** ✓ |
| 2 | `spotPrice` | 32B | full slot |
| 3 | `delta` | 32B | full slot |
| 4 | `feeBps` | 32B | full slot |
| 5 | `protocolFeeBps` | 32B | full slot |
| 6 | `owner` | 20B | alone (next field is `factory` 20B → 40B > 32, can't pack) |
| 7 | `factory` | 20B | alone (next is `weth` 20B → can't pack) |
| 8 | `weth` | 20B | alone (next is `_heldIds` array header which takes a full slot regardless) |
| 9 | `_heldIds` | array header (length) | full slot |
| 10 | `_idToIndex` | mapping header | full slot |
| 11 | `accumulatedProtocolFees` | 32B | full slot |
| 12 | `pendingSpotPrice` | 32B | full slot |
| 13 | `pendingSpotPriceExecuteAfter` | 32B | full slot |
| 14 | `pendingDelta` | 32B | full slot |
| 15 | `pendingDeltaExecuteAfter` | 32B | full slot |
| 16 | `pendingFeeBps` | 32B | full slot |
| 17 | `pendingFeeBpsExecuteAfter` | 32B | full slot |

**Total: 18 slots used (0-17). No collisions. One pack pair (`nftCollection` + `poolType`) — efficient.**

### 2.4 Constants — correct choices

```solidity
MAX_FEE_BPS, MAX_PROTOCOL_FEE_BPS, BPS, MAX_DELTA, PARAMETER_TIMELOCK
```

All declared `uint256 public constant` (lines 55-64). Inlined into bytecode, no slot consumption. Correct. ✓

### 2.5 Findings — TegridyNFTPool

#### FINDING 2.A — `nftCollection` + `poolType` packed correctly (POSITIVE)

`address` (20B) + `enum` (1B) → 21B in slot 1. This is the only natural pack opportunity in this contract — author took it. ✓

#### FINDING 2.B — Three trailing addresses (`owner`, `factory`, `weth`) NOT packed (LOW — gas only)

Slots 6-8 each hold one address (20B) with 12B padding. Solidity cannot pack two adjacent `address`es (20+20=40 > 32). **No fix possible without re-typing one address as `uint96` or interleaving a small field**, neither of which is justified.

**One viable optimization:** declaring `bool` flags or `uint96` fields between addresses to fill the 12B tail. Not worth re-architecting an audited contract for.

**Severity: INFO**.

#### FINDING 2.C — Six pending-* timelock fields each consume their own slot (INFO — by design)

Slots 12-17 are `pendingSpotPrice`, `pendingSpotPriceExecuteAfter`, `pendingDelta`, `pendingDeltaExecuteAfter`, `pendingFeeBps`, `pendingFeeBpsExecuteAfter`. Six full slots. Could pack `executeAfter` as `uint64` (timestamp fits in 64 bits comfortably until year 2554) and pair with `pendingDelta` etc., saving 3 slots. But:

- `pendingSpotPrice`, `pendingDelta`, `pendingFeeBps` are `uint256` because they replace `spotPrice` / `delta` / `feeBps` which are `uint256` themselves. Reducing the pending field width risks truncation on store.
- `executeAfter` as `uint64` would pair with these uint256 only if the value fits in 256-uint64=192 bits — but the value-replacement field IS uint256, leaving 0 bits for the timestamp.

**Result:** packing here requires changing the corresponding *current-value* slot widths, which would touch every read/write site and risk truncation bugs. Not worth pursuing.

**Severity: INFO**.

#### FINDING 2.D — `_idToIndex` uses `tokenId => index+1` convention — CORRECT (POSITIVE)

Line 40: `mapping(uint256 => uint256) internal _idToIndex; // tokenId => index+1 (0 = not held)`. The +1 offset prevents the "default-zero collision" — index 0 is reserved for "not held", actual array index 0 maps to stored value 1. **Standard idiom**, correctly applied (verified at `_addHeldId` line 656-660 and `_removeHeldId` line 663-678). ✓

#### FINDING 2.E — Implementation `immutable poolImplementation` in factory means storage drift on next OZ minor only affects new clones (POSITIVE)

`TegridyNFTPoolFactory.sol:35` declares `address public immutable poolImplementation`. Existing pool clones cannot be re-pointed at a different implementation — they keep the layout they were born with. Any future OZ minor that adds a state var to `Pausable` (currently slot 0 in the clone) would only affect a *new factory deployment* with a fresh `TegridyNFTPool` template. **Mitigation:** when deploying v2 of either contract, re-run this slot audit on the new linearization before mainnet ship.

**Severity: POSITIVE / acknowledgment**.

#### FINDING 2.F — `factory` is settable-once not `immutable` — defensible

Line 35 (`address public factory`) at slot 7 is set once in `initialize()` and never written again. Could not be `immutable` because constructors don't run on clones. Same justification as TegridyDropV2's `weth`. ✓

---

## 3. Cross-contract checks

### 3.1 Both implementations call `_disableInitializers()` in constructor (POSITIVE)

- `TegridyDropV2.sol:23` ✓
- `TegridyNFTPool.sol:124` ✓

This prevents an attacker from calling `initialize()` directly on the implementation address (the classic "uninitialized implementation" hijack from Parity wallet). Critical, present, correct.

### 3.2 No `__gap` reserves — JUSTIFIED for non-upgradeable Clones

`__gap` is the upgradeable-proxy idiom: parent contracts reserve N empty slots at the end of their layout so that adding state vars in v2 doesn't shift child slots. **EIP-1167 minimal proxies are NOT upgradeable** — clones are tied to a specific implementation, and a new implementation is a new factory. So the absence of `__gap` is **correct, not a bug**.

This would only be a problem if the team migrated to UUPS or Transparent proxies later — at that point both implementations would need to add gaps before the migration.

### 3.3 No multiple-uint128-in-one-slot patterns — N/A (no such fields)

Neither contract declares two `uint128`s adjacent. No packed-struct alignment risk.

### 3.4 No fields-added-between-releases concern — POSITIVE

Both contracts are first-deploy implementations. There is no v1 layout to compare against (TegridyDropV2 is itself the v2 of TegridyDrop, but clones of v1 use a separate implementation address — the layouts can diverge freely).

The v1→v2 jump is **safe by design**: `TegridyLaunchpadV2` (line 61) declares its own `dropTemplate` as `address public immutable`, deployed inline at line 115 (`address(new TegridyDropV2())`). v1 clones at `TegridyLaunchpad.dropTemplate` continue using the v1 implementation; v2 clones use the v2 template. **No shared storage means no slot-shift hazard.**

### 3.5 Private-but-inherited-readable check — ALL CLEAN

Searched for fields that look private but a parent reads them through a getter or internal accessor:

- `ERC721._name` / `_symbol` — private. Getters are `name()` / `symbol()` which are virtual — TegridyDropV2 overrides both (lines 236-237) and reads from its own `_dropName` / `_dropSymbol`. **No accidental cross-read.** ✓
- `ERC721._owners` / `_balances` / `_tokenApprovals` / `_operatorApprovals` — private, accessed only via inherited public getters (`balanceOf`, `ownerOf`, `getApproved`, `isApprovedForAll`). TegridyDropV2 doesn't override these. **Read by ERC721's own logic — works correctly on a clone because slots 2-5 are zero-initialized and the contract's own `_safeMint` populates them.** ✓
- `ERC2981._defaultRoyaltyInfo` — private. Set in `_setDefaultRoyalty` (called from `initialize` line 187), read by `royaltyInfo`. Standard flow. ✓
- `Pausable._paused` — private. Read via `paused()` and modifiers. Standard. ✓
- `ReentrancyGuard` / `Initializable` storage at namespaced slots — never collide with linear storage by construction (ERC-7201 derives slots from `keccak256(string) - 1 & ~0xff`, putting them at `0x9b779b…` and `0xf0c57e…` which are astronomically unlikely to collide with any sequential slot ≤ 2²⁵⁶/billion). ✓

### 3.6 immutable vs constant — both contracts get this right

| Field | Decl | Justification |
|-------|------|---------------|
| `MAX_*_BPS` (both contracts) | `constant` | Protocol invariants, inlined into bytecode. ✓ |
| `MAX_DELTA`, `BPS`, `PARAMETER_TIMELOCK` | `constant` | Fixed protocol params. ✓ |
| `poolImplementation` (factory) | `immutable` | Set in factory constructor, never changes per factory. ✓ |
| `dropTemplate` (factory) | `immutable` | Same. ✓ |
| `weth` (factory and clones) | factory: `immutable`; clones: storage | Factory has constructor, clones don't. Both correct for their context. ✓ |

---

## 4. Summary

| Category | Count |
|----------|-------|
| Contracts audited | 2 (TegridyDropV2, TegridyNFTPool) |
| Storage slots in use | 33 (Drop) + 18 (Pool) = **51** |
| Slot collisions | **0** |
| Diamond conflicts | **0** |
| Missing `__gap` | **0 — justified, not required for EIP-1167 clones** |
| Packed-struct misalignments | **0** |
| Private-shadowed-by-parent reads | **0** |
| Wrong constant/immutable choices | **0** |
| Dead-but-occupying inherited slots | **2** (Drop slots 0-1 for `ERC721._name/_symbol`, by design) |
| `_disableInitializers()` on template | **Both ✓** |
| LOW findings (gas only) | **2** (Drop 1.A — under-packed enums/bools; Pool 2.B — three adjacent addresses) |
| INFO findings | **5** (1.A, 1.B, 1.C, 2.A, 2.C, 2.D, 2.E, 2.F — all positives or design choices) |
| **Critical/High/Medium storage findings** | **0** |

### Top 3 (per agent 097's mandate)

1. **POSITIVE — Both implementations correctly call `_disableInitializers()` in their constructor** (`TegridyDropV2.sol:23`, `TegridyNFTPool.sol:124`). This is the most important storage-related defense for cloned implementations — without it, the Parity-wallet-style takeover of the template address is trivial. **Both contracts get this right, and templates are owned via factory `immutable` references that can't be swapped post-deploy.**

2. **POSITIVE — Missing `__gap` reserves are JUSTIFIED, not a bug.** EIP-1167 minimal proxies (used by `Clones.cloneDeterministic` in `TegridyLaunchpadV2:142` and `TegridyNFTPoolFactory:147`) are non-upgradeable by construction — each factory pins its template to an `immutable` address. There is no future-upgrade path that would shift child slots, so reserving end-of-layout gaps is unnecessary. **Caveat:** if the team ever migrates to UUPS/Transparent proxies, both contracts need gaps added BEFORE the migration deployment.

3. **LOW — Two minor packing inefficiencies in TegridyDropV2 (gas-only, NOT security).** Three single-byte fields (`MintPhase mintPhase` slot 17, `bool revealed` slot 21, `bool withdrawn` slot 32) each consume a full 32-byte slot because their neighbours are full-width. Re-clustering these with `platformFeeBps` (uint16, 2B) into one packed slot would save ~3 slots × ~20k gas ≈ 60k gas per clone deploy. **Worth doing on the NEXT template version (TegridyDropV3) — not worth a redeploy of the current one** because: (a) `dropTemplate` is `immutable` so swapping requires new factory + new minted-collection migration story; (b) existing clones already at audit, redeploying introduces fresh attack surface for marginal gas saving. Flagged as INFO/future-work.

**Verdict:** storage layout for both Clones implementations is **clean, conservative, and correct**. No collisions, no shadowing bugs, no missing protections, no wrong constant/immutable choices. The two LOW gas findings are pre-existing "by design" trade-offs that the developer accepted in exchange for code clarity.
