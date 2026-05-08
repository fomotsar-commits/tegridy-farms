# Agent 49/100 — Fresh-Eyes Initializer / Re-Initialization Audit
**Lens:** INITIALIZER / RE-INITIALIZATION across all contracts (clone hijack, post-deploy init grab, constructor-vs-init split)
**Scope:** `contracts/src/**.sol` (29 contracts incl. base/ + lib/)
**Date:** 2026-05-07
**Result:** **No exploitable initialization vulnerabilities identified.**

---

## Inventory of Initialize Patterns

### Cloned templates (3)
| Contract | Cloned via | Init function | `_disableInitializers` | `initializer` modifier | Owner field |
|---|---|---|---|---|---|
| `TegridyDropV2.sol:377` | `Clones.cloneDeterministic` (TegridyLaunchpadV2:217) | `initialize(InitParams)` | YES (constructor:25) | YES (`external initializer`) | `address public owner` set inside `initialize()` (line 397) |
| `TegridyNFTPool.sol:219` | `Clones.cloneDeterministic` (TegridyNFTPoolFactory:239) | `initialize(...)` | YES (constructor:216) | YES (`external initializer`) | `address public owner` set inside `initialize()` (line 249) |
| `TegridyPair.sol:103` | NOT cloned — full CREATE2 deploy each pair (TegridyFactory:196) | `initialize(token0,token1)` | N/A (constructor runs each deploy) | Custom `_initialized` bool + `factory` ACL | `factory = msg.sender` set in constructor (line 99) |

### CREATE2 pair deploy
- `TegridyFactory.createPair`: deploys `TegridyPair` via CREATE2 (full bytecode), then calls `initialize(token0, token1)` in same external call (TegridyFactory.sol:194-200). No window between deploy and init.
- Salt = `keccak256(abi.encode(block.chainid, address(this), token0, token1))` — includes deployer + chain. No cross-deployer/cross-chain collision possible.

### Non-cloned admin contracts
All admin / treasury / staking contracts inherit `OwnableNoRenounce(msg.sender)` in constructor. Owner is set at deploy time, no init-grab surface.

### One-shot post-deploy "wire-up" setters (`onlyOwner`-gated)
| Contract:line | Setter | Gate |
|---|---|---|
| `TegridyLending.sol:134` | `setLendingAdmin` | onlyOwner + `lendingAdmin == 0` |
| `TegridyStaking.sol:1878` | `setStakingAdmin` | onlyOwner + `stakingAdmin == 0` |
| `VoteIncentives.sol:145` | `setVoteIncentivesAdmin` | onlyOwner + `voteIncentivesAdmin == 0` |
| `SwapFeeRouter.sol:532` | `setSequencerFeed` | onlyOwner + `sequencerFeed == 0` |
| `SwapFeeRouter.sol:1061` | `setSwapFeeRouterAdmin` | onlyOwner |
| `TegridyNFTLending.sol:390` | `setSequencerFeed` | onlyOwner + `sequencerFeed == 0` |
| `ReferralSplitter.sol:524` | `setApprovedCaller` | onlyOwner + `!setupComplete` |

All gated by `onlyOwner` where owner is set by constructor. No race window.

---

## Threat-Model Walkthrough

### 1. Clone factory deploys: is initialize bundled atomically with deploy?
**Result: SAFE.** All three cloned/deployed contracts initialize atomically in the same external call:

- `TegridyLaunchpadV2.createCollection` (line 217-242): `Clones.cloneDeterministic(...)` followed immediately by `TegridyDropV2(collection).initialize(...)` in the same function frame.
- `TegridyNFTPoolFactory.createPool` (line 239-255): `poolImplementation.cloneDeterministic(salt)` followed immediately by `TegridyNFTPool(pool).initialize(...)`.
- `TegridyFactory.createPair` (line 196-200): CREATE2 deploy + `TegridyPair(pair).initialize(...)` in the same function frame.

There is **no separable hijack window**. An attacker observing the `createCollection` / `createPool` / `createPair` tx in the mempool cannot front-run the init step — both calls land in the same tx atomically (revert-as-unit if either fails).

### 2. `_disableInitializers()` on impl?
**Result: SAFE.**
- `TegridyDropV2.sol:24-26`: `constructor() { _disableInitializers(); }`
- `TegridyNFTPool.sol:215-217`: `constructor() { _disableInitializers(); }`
- `TegridyPair.sol:98-100`: not Initializable — uses bool sentinel + `factory` ACL on initialize.

Implementation contracts cannot be re-initialized.

### 3. `initializer` modifier present and effective? `reinitializer(N)`?
**Result: SAFE.**
- TegridyDropV2 / TegridyNFTPool both use `external initializer` (OZ Initializable v5).
- TegridyPair uses bespoke `_initialized` bool + `require(msg.sender == factory)` — equivalent guarantee under its non-cloned threat model.
- **Zero `reinitializer(N)` usage in the codebase** (grepped — no matches). No re-init via stale-N risk.

### 4. Constructor + initializer split: implicit assumption that immutable in constructor differs from clone?
**Result: SAFE.** No `immutable` keywords in any of the cloned contracts. The dev team explicitly documents this awareness:
- `TegridyDropV2.sol:217-220`: "Clones cannot use the immutable keyword; this comment is the equivalent security guarantee."
- `TegridyDropV2.sol:318-321`: same note for `sequencerFeed`.

`TegridyDropV2` inherits `ERC721("", "")`. The constructor sets internal `_name`/`_symbol` to empty on the implementation only — clones store empty strings in those slots. `name()` / `symbol()` are overridden (line 461-462) to return `_dropName` / `_dropSymbol` set in `initialize()`. Override is correct because OZ ERC721's `_name`/`_symbol` are private and only read by the now-overridden public getters.

### 5. Owner set in constructor (not initialize) but clone has no owner = freely initialize-able?
**Result: SAFE.** Cloned contracts (TegridyDropV2, TegridyNFTPool) do **not** inherit `OwnableNoRenounce`. They use a bespoke `address public owner` field set inside `initialize()`. Constructor in the implementation only calls `_disableInitializers()` — no owner assignment that would be skipped on clone.

Implementation contracts that DO inherit `OwnableNoRenounce` (TegridyLaunchpadV2, TegridyNFTPoolFactory, etc.) are **never cloned** — they're singleton deployments. Their constructor runs once at deploy and sets ownership cleanly.

### 6. ERC721 name/symbol set in constructor for clone — wrong?
**Result: HANDLED CORRECTLY.** TegridyDropV2 inherits `ERC721("", "")` (empty strings on impl). `name()` / `symbol()` are overridden to return `_dropName` / `_dropSymbol` set in `initialize()`. See section 4.

### 7. After-deploy public function that does fundamental setup (one-time)?
**Result: SAFE.** The set of one-shot "wire-up" setters is enumerated in the table above. Every one is `onlyOwner` (with owner set in constructor) — no race window between deploy and the wire-up call.

### 8. Initialize race: factory deploys then transfers ownership but attacker grabs init in between.
**Result: NOT APPLICABLE / SAFE.** No factory-deploy-then-transfer-ownership pattern exists. Cloned contracts set ownership atomically inside `initialize()` (TegridyDropV2.sol:397, TegridyNFTPool.sol:249) which itself is called atomically with the clone deploy. Singleton admin contracts set ownership in their constructor.

### 9. Re-init via `reinitializer(N)` with attacker-controlled N.
**Result: NOT APPLICABLE.** Codebase uses zero `reinitializer(N)` calls. Single-shot init only.

---

## Findings

### F-49-1: NOTES / DEAD-ENDS (no exploitable issues)

The following were investigated and confirmed safe:

| Concern | Verdict | Location |
|---|---|---|
| TegridyPair init lacks `initializer` modifier — uses `_initialized` bool | SAFE — `factory == msg.sender` ACL is stronger than OZ Initializable for this CREATE2-deployed contract; only the factory can ever call initialize, and the factory is hard-set in constructor | `TegridyPair.sol:103-111` |
| TegridyPair CREATE2 + initialize sequencing | SAFE — both in same external call frame; no separable hijack | `TegridyFactory.sol:196-200` |
| Salt predictability for clones | SAFE — even if attacker predicts the deterministic clone address, init is called atomically by the factory in the same tx; attacker cannot deploy first (different `msg.sender` = different CREATE2 address) | `TegridyLaunchpadV2.sol:213-217`, `TegridyNFTPoolFactory.sol:229-239` |
| ReentrancyGuard `_status == 0` on fresh clone | SAFE — OZ ReentrancyGuard 5.x checks `_status == _ENTERED (2)` so storage default 0 passes the first call check, then state machine engages correctly | All cloned contracts |
| ERC721 name/symbol baked-empty on clone storage | SAFE — `name()`/`symbol()` are virtual-overridden to read `_dropName`/`_dropSymbol` set in initialize | `TegridyDropV2.sol:461-462` |
| ERC2981 `_setDefaultRoyalty` called inside initialize | SAFE — no constructor-only ERC2981 state required; OZ ERC2981 stores royalties in mapping that defaults to zero | `TegridyDropV2.sol:401` |
| `_disableInitializers()` on clone-template only | SAFE — protects implementation from direct init; clones get fresh `_initialized` storage | `TegridyDropV2.sol:25`, `TegridyNFTPool.sol:216` |
| TegridyLaunchpadV2's `dropTemplate = new TegridyDropV2()` deploys a fresh implementation | SAFE — implementation's own constructor disables initializers; only Launchpad's clones can be initialized | `TegridyLaunchpadV2.sol:177` |
| Same-tx `pool.call{value:...}` after init in createPool | SAFE — `receive()` enforces `msg.sender == factory`, factory is the caller, init has already completed in same frame | `TegridyNFTPool.sol:804-806`, `TegridyNFTPoolFactory.sol:264-267` |
| `setApprovedCaller`/`setLendingAdmin`/etc. one-shot post-deploy setup | SAFE — onlyOwner gated; owner is set in constructor with no race window | enumeration in table above |
| TegridyDropV2 inherits ERC721 with empty strings; `_dropName`/`_dropSymbol` storage | SAFE — overridden getters return the clone-set values; OZ ERC721 internal access to `_name`/`_symbol` is limited to the now-overridden public getters | `TegridyDropV2.sol:21, 461-462` |
| TegridyPair owner-equivalent (`factory`) set in constructor only | SAFE — pair is full-CREATE2-deployed, not cloned; constructor runs each pair, `factory = msg.sender` is set every time | `TegridyPair.sol:98-100` |
| TimelockAdmin / OwnableNoRenounce inheritance into cloned contracts | NOT APPLICABLE — TegridyDropV2 inherits TimelockAdmin (stateless lib, only mapping `_executeAfter`), no constructor state. TegridyNFTPool does NOT inherit either base. | — |
| `reinitializer(N)` attacker-controlled N | NOT APPLICABLE — zero `reinitializer` usage in codebase | grep result |
| `setupComplete` flag race in ReferralSplitter | SAFE — `setApprovedCaller` is onlyOwner; deployer can configure approved callers atomically before calling `completeSetup()` | `ReferralSplitter.sol:524-529` |

---

## Methodology
1. Enumerated every Solidity contract under `contracts/src/` (29 files including base/ + lib/).
2. grep'd for `initialize|Initializable|_disableInitializers|reinitializer|onlyInitializing|initializer\b` — narrowed to 4 contracts with init functions.
3. grep'd for `clone|Clones|cloneDeterministic|delegatecall|Proxy` — confirmed the 3 cloned/CREATE2-deployed contracts.
4. Reviewed each cloned contract's constructor + initialize for:
   - `_disableInitializers()` presence
   - `initializer` modifier on init function
   - Atomicity of factory deploy + initialize call
   - Storage layout (immutable vs storage)
   - Owner assignment location (constructor vs initialize)
   - External calls inside initialize (none found — no reentrancy-back-to-init risk)
5. Reviewed the corresponding factory deploy paths for the same-tx atomicity guarantee.
6. Enumerated all one-shot post-deploy setter functions (`set*Admin`, `setSequencerFeed`, etc.) and confirmed each is `onlyOwner`-gated with owner pre-set in constructor.
7. Verified zero `reinitializer(N)` usage codebase-wide.

---

## Files of Interest
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyPair.sol` (lines 47, 95-111, 98-100)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyFactory.sol` (lines 163-209)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyDropV2.sol` (lines 21-26, 24-26, 377-458)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyLaunchpadV2.sol` (lines 160-178, 185-263)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTPool.sol` (lines 30, 215-217, 219-255, 803-806)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTPoolFactory.sol` (lines 165-186, 199-278)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\base\OwnableNoRenounce.sol` (singleton-only contracts; never cloned)

## Conclusion
The Tegriddy Farms init / re-init surface is well-defended across all three clone/CREATE2-deployed contracts (TegridyDropV2, TegridyNFTPool, TegridyPair). The dev team has anticipated every standard initialization-vulnerability class:
- `_disableInitializers()` on every implementation (or equivalent ACL on TegridyPair)
- atomic deploy+init in factory paths
- owner set inside `initialize()` (or via factory-ACL)
- no `immutable`s for clone-incompatible state
- no `reinitializer(N)` re-init paths
- explicit `name()`/`symbol()` overrides for clone-fresh storage
- `address(this) == factory` salt anchoring to prevent cross-deployer collisions

**No HIGH, MEDIUM, or LOW init-related findings to report.**

— Agent 49/100, fresh-eyes init lens, 2026-05-07
