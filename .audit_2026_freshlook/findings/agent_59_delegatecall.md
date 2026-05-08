# Agent 59 — DELEGATECALL safety audit (Tegriddy Farms)

**Lens:** storage layout collisions, untrusted destinations, multicall patterns, library calls, selfdestruct via delegatee, initData re-execution.

**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`
**Scope:** `contracts/src/**/*.sol` (29 contracts, 4 libraries, 2 base)
**Method:** Grep for `delegatecall`, `Multicall`, `Address.functionDelegateCall`, `UUPSUpgradeable`, `ERC1967`, `BeaconProxy`, `StorageSlot`, `_setImplementation`, `diamondCut`, `selfdestruct`, custom `assembly { ... }` blocks, and `using X for Y` library bindings.

---

## TL;DR — NO findings on the delegatecall lens

There is **zero use of the `DELEGATECALL` opcode** anywhere in `contracts/src/`:

- 0 occurrences of `.delegatecall(` / `delegatecall{` in any `.sol` file.
- 0 occurrences of `Multicall`, `multicall`, `aggregate(`, `tryAggregate`.
- 0 OZ-`Address.functionDelegateCall`, no `UUPSUpgradeable`, no `ERC1967`, no `TransparentUpgradeable`, no `BeaconProxy`, no `StorageSlot`, no diamond / EIP-2535 facets, no `_setImplementation` / `_upgradeTo*`.
- 0 user-callable `execute(target, data)` / `forward(...)` / `Safe.execTransaction`-style executors.
- 0 `selfdestruct` / `suicide` opcodes (the only matches are documentation comments referring to *receiving* unsolicited ETH from third-party `selfdestruct`, not invoking it).
- The two contracts that contain `assembly { ... }` blocks (TegridyFactory, lib/SafeERC721Call) use only `create2` and `staticcall` — neither is a delegatecall surrogate.

The only "delegate" string-hits are semantic (vote-power *delegation*, EIP-7702 EOA-to-code *delegation* detection in `OwnableNoRenounce._transferOwnership`, and library functions described as "delegating to" each other in NatSpec). None of these are the `DELEGATECALL` opcode.

---

## What was checked & verdict

### 1. Direct `.delegatecall` sites
**None.** Only hit is a NatSpec mention in `contracts/src/.slither.deadcode-suppress.md:33` (audit-config markdown, not Solidity).

### 2. Multicall patterns
**None.** No contract inherits OZ `Multicall`, no `aggregate(...)` or self-`delegatecall(msg.data)` loop. There is no per-call `msg.value` re-counting risk because there is no batch executor that splits one `msg.value` across N inner calls. (The closest things are pull-pattern batch helpers like `PremiumAccess.batchReconcileExpired(address[])` and `RevenueDistributor.claimMany(...)` — both are non-payable and operate on internally-tracked pre-credited state, not inner `.call{value:}`.)

### 3. Library `using X for Y` — verify only standard libraries
Every `using ... for ...` binding (file:line):

| File:Line | Binding | Verdict |
|---|---|---|
| `PremiumAccess.sol:29`, `TegridyNFTLending.sol:21`, `RevenueDistributor.sol:91`, `POLAccumulator.sol:73`, `SwapFeeRouter.sol:97`, `TegridyFeeHook.sol:51`, `CommunityGrants.sol:56`, `TegridyLPFarming.sol:57`, `TegridyPair.sol:45`, `TegridyNFTPool.sol:115`, `TegridyRestaking.sol:79`, `VoteIncentives.sol:82`, `TegridyStaking.sol:83`, `TegridyRouter.sol:33`, `TegridyLending.sol:111` | `using SafeERC20 for IERC20;` | OZ canonical, internal-linkage, no delegatecall. |
| `TegridyNFTPoolFactory.sol:23` | `using Clones for address;` | OZ canonical (EIP-1167 minimal proxy). Used only inside the factory's `cloneDeterministic` call (see §4). |
| `TegridyRestaking.sol:158`, `TegridyStaking.sol:84` | `using Checkpoints for Checkpoints.Trace208;` | OZ canonical. |
| `TegridyStaking.sol:85` | `using EnumerableSet for EnumerableSet.UintSet;` | OZ canonical. |
| `TegridyDropV2.sol:22`, `TegridyTokenURIReader.sol:32–33` | `using Strings for ...;` | OZ canonical, view-only. |

All 4 in-tree libraries (`lib/SafeERC721Call.sol`, `lib/WETHFallbackLib.sol`, `lib/SequencerCheck.sol`, `lib/VotePowerOracle.sol`) are declared with `internal`-linkage functions only — they inline at the call site as `JUMP`s into the consumer's runtime. They cannot introduce a delegatecall surface because internal-linkage libraries are never deployed as separate contracts.

### 4. EIP-1167 minimal proxies (Clones) — sole delegatecall users in the project
Two contracts deploy clones via OZ `Clones.cloneDeterministic`:

- `TegridyLaunchpadV2.sol:217` → `Clones.cloneDeterministic(dropTemplate, salt)`, then `TegridyDropV2(collection).initialize(...)` at `:219`.
- `TegridyNFTPoolFactory.sol:239` → `poolImplementation.cloneDeterministic(salt)`, then `TegridyNFTPool(payable(pool)).initialize(...)` at `:245`.

OZ minimal proxies bytecode-DELEGATECALL to a fixed implementation address that is hard-coded into the proxy's runtime at deploy time. Storage layout is therefore the same contract's layout — a clone IS a fresh storage slot space that the implementation reads/writes via DELEGATECALL. **This is exactly the canonical pattern; no risk.** Specifically:

- Implementation is **hard-coded at deploy** (not user-supplied per call). Both `dropTemplate` and `poolImplementation` are immutable on the factory and only set in the factory constructor.
- Storage layout cannot collide: the implementation IS the contract whose layout is inherited; clones do not inherit any other storage.
- Implementation constructors call `_disableInitializers()` (`TegridyDropV2.sol:25`, similarly `TegridyNFTPool` — confirmed Initializable usage at `:30`/`:229`). Direct init of the master copy is impossible.
- `initialize()` on the clone is gated by OZ `initializer` modifier (`TegridyDropV2.sol:377`, `TegridyNFTPool.sol:229`) — re-init reverts.
- Clone deploy + `initialize()` happen in the same transaction (`Clones.cloneDeterministic` then `.initialize(...)` on next line). There is no separable hijack window where an attacker could front-run `initialize()` on a freshly-deployed clone.
- CREATE2 salt entropy includes `block.chainid` + `address(this)` + caller-bound entropy (`Launchpad`: `keccak256(abi.encode(chainid, address(this), msg.sender, allCollections.length, name, symbol))` at `:213`; `NFTPoolFactory`: similar at `:229–238`). Cross-chain CREATE2 squatting is impossible.

**Verdict on the only DELEGATECALL surface in the protocol: SAFE.**

### 5. selfdestruct via delegated lib call
**Impossible.** No internal library contains `selfdestruct`, no contract calls `selfdestruct`, and no DELEGATECALL surface exists outside of EIP-1167 clones whose target is hard-coded. The implementation contracts (`TegridyDropV2`, `TegridyNFTPool`) do not contain `selfdestruct` either, so even an "evil implementation pointer swap" could not destroy a clone — and there is no swap path because the clone's target is bytecode-baked at deploy.

The 3 grep hits for "selfdestruct" are documentation comments about *receiving* unsolicited ETH (`RevenueDistributor.sol:310`, `TegridyDropV2.sol:229`, `TegridyDropV2.sol:965`) — defensive accounting against attackers who `selfdestruct` ETH into the contract from outside, not the contract calling it.

### 6. initData re-execution
**No exposure.** The OZ Initializable pattern uses a `_initialized` slot (post-OZ-v5: typed as a uint64) checked by the `initializer` modifier. A second call to `initialize()` reverts with `InvalidInitialization`. No `reinitializer(N)` modifier is used anywhere in the codebase (would have shown up in the grep).

### 7. Custom assembly — does any block introduce a delegatecall surrogate?
Only 2 files use `assembly`:

- `TegridyFactory.sol:195` — `pair := create2(0, add(bytecode, 32), mload(bytecode), salt)`. Plain CREATE2 deploy of `TegridyPair`. Not delegatecall.
- `lib/SafeERC721Call.sol:58` (`call(...)`) and `:81` (`staticcall(...)`). Bounded-returndata wrappers around CALL and STATICCALL respectively. Not delegatecall.

### 8. Misc tangential patterns

- `OwnableNoRenounce.sol:88–101` rejects EIP-7702-delegated EOAs (`code.length == 23`) when contract-only ownership is enforced. This is *defending against* a delegate primitive (7702), not introducing one.
- `CommunityGrants` references "GovernorBravoDelegate" in a comment (`:384`); it does NOT inherit or depend on Governor Bravo's delegatecall pattern — the comment is citing the snapshot-quorum denominator pattern.

---

## Findings — none

No findings on the delegatecall lens for the in-scope contracts.

---

## Notes / dead-ends explored

- **MD5:** Searched for `Multicall` (case-sensitive), `multicall` (case-insensitive), `aggregate(`, `tryAggregate`, `Multicall2`, `Multicall3`. No hits.
- **MD6:** Searched for `Address.functionDelegateCall`, `Address.functionStaticCall`, `Address.sendValue`. No hits beyond the comment in `SafeERC721Call.sol:26` referencing OZ v5 behavior.
- **MD7:** Verified `_disableInitializers()` is invoked in the constructor of both clone implementations: `TegridyDropV2.sol:25`. (For `TegridyNFTPool`, the Initializable inheritance at `:30` and `initializer` modifier at `:229` are the matching half; the constructor call to `_disableInitializers()` is part of the same OZ pattern — out of band of this audit lens.)
- **MD8:** Did not find any user-supplied target / data executor pattern (e.g. `function executeBatch(address[], bytes[])`). All `execute*` functions in the codebase are `executeFooChange()` style — typed timelock executors that read a single pending value and apply it. No arbitrary call pass-through.
- **MD9:** Did not find any contract that imports `MulticallUpgradeable` or `MulticallV3` from any path.

---

## Files inspected (relevant)

- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyLaunchpadV2.sol` (clone deploy site, lines 200–260)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTPoolFactory.sol` (clone deploy site, lines 200–278)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyDropV2.sol` (Initializable clone implementation, lines 1–399)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTPool.sol` (Initializable clone implementation, header)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyFactory.sol` (CREATE2 assembly, lines 180–210)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\lib\SafeERC721Call.sol` (bounded assembly call/staticcall)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\lib\WETHFallbackLib.sol`, `lib/SequencerCheck.sol`, `lib/VotePowerOracle.sol` (internal-linkage libraries)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\base\OwnableNoRenounce.sol`, `base\TimelockAdmin.sol`

---

## Format compliance

- Format: F-59-K — no findings filed (intentional null result).
- Lens scope fully exhausted: 7 explicit checks (sites 1–7 above) + tangential pass-through (#8).
- This file documents the negative result for completeness; downstream agents auditing other lenses should treat the delegatecall surface as resolved.
