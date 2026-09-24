# Agent 68 — Function Selector Clashes / Signature Collisions / Fallback Invoke

**Lens:** Custom-error/function selector collisions, fallback() abuse, ABI-encoded routing, hardcoded selector silent-success vectors.
**Scope:** All Solidity in `contracts/src/` (32 files including base/, lib/).
**Method:** Parsed every `function`, `error`, and `event` signature from cleaned source (comments stripped), computed keccak256 4-byte selectors and 32-byte event topic0 hashes, cross-checked for collisions internally and against ~80 common DeFi/ERC-20/ERC-721/ERC-777/ERC-1820/ERC-1271/ERC-4626/UUPS/Aave/Curve/Uniswap V2-V4/Multicall/Safe selectors. Verified every hardcoded numeric `bytes4` constant (e.g. `0x23b872dd`, `0x6352211e`, `0xaabbb8ca`, `0x01ffc9a7`, `0xe58e113c`, `0x150b7a02`, `0x80ac58cd`) against the canonical signature.

---

## Summary

**Zero exploitable findings.** The codebase is clean against the selector-clash / fallback-invoke / signature-collision attack class. Every hardcoded selector verified to its canonical signature; every deprecated-name reverter is a documented hard-revert (no silent no-op); every ERC721 raw-call site is properly paired with a bounded `ownerOf` post-condition; no `fallback() external` exists anywhere in the codebase, so uncovered selectors revert (the safe default).

---

## F-68-K1 — INFORMATIONAL — `applyPairFee(address,uint256,bool)` ABI-bait reverter is publicly callable
**File:** `contracts/src/SwapFeeRouter.sol:1259`
**Selector:** `0x1989fde7`

```solidity
function applyPairFee(address, uint256, bool) external pure {
    revert DeprecatedUseInputTokenFee();
}
```

**Issue:** Legacy-alias function is `external pure` — has NO `onlyAdmin` / `onlyOwner` modifier. Anyone can call it.
**Exploit:** None. The function is `external pure` and immediately reverts via `DeprecatedUseInputTokenFee()` (selector `0x14a32cf2`). It cannot mutate state, cannot leak data, cannot consume more than ~200 gas before reverting. The keep-the-selector-on-ABI-as-loud-revert pattern is the textbook Aragon-style migration aid documented at `contracts/src/SwapFeeRouter.sol:1247-1258`.
**Verdict:** Working as intended. No action.

---

## F-68-K2 — INFORMATIONAL — `enableCommitReveal()` ABI-bait reverter has `onlyOwner`
**File:** `contracts/src/VoteIncentives.sol:1786`
**Selector:** `0xe844dc58`

```solidity
function enableCommitReveal() external onlyOwner {
    revert UseProposeEnableCommitReveal();
}
```

**Issue:** Same migration-aid pattern as F-68-K1. Owner-gated, immediately reverts with typed error `UseProposeEnableCommitReveal()` (selector `0x9af7d97e`). Forces caller to migrate to the timelocked `propose/applyEnableCommitReveal` flow.
**Verdict:** Working as intended. The `onlyOwner` here is technically redundant (the function reverts unconditionally before any auth check matters), but harmless. No action.

---

## Notes / Dead Ends

### N1 — No `fallback() external` anywhere in the codebase.
Grep `^\s*fallback\s*\(` across `contracts/src/` returns zero hits. Only `receive() external payable` exists (in 9 contracts). `receive()` fires only on plain ETH sends (zero calldata) — it cannot be triggered by an "uncovered selector". An uncovered selector against any contract in this codebase reverts (Solidity 0.8.x default). The "fallback() invoked by uncovered selector → unintended state change" exploit class is structurally unreachable.

### N2 — Every `receive() external payable` body is selector-independent.
Examined receive() in CommunityGrants:287, ReferralSplitter:227, POLAccumulator:308, RevenueDistributor:315, TegridyFeeHook:848, SwapFeeRouter:2060, TegridyNFTPool:804 (factory-restricted), TegridyNFTPoolFactory:676, TegridyRouter:90 (WETH-restricted), VoteIncentives:1451. All bodies do at most:
- `totalETHReceived += msg.value` (monotonic counter; no auth bypass possible)
- `emit ETHReceived(msg.sender, msg.value)`
- `if (msg.sender != ...) revert ...` (auth check)

None of these process `msg.sig` or branch on calldata, so a malicious selector cannot reach them.

### N3 — Custom-error → function-selector collision check: clean.
Every `error X(args);` declaration was extracted (~140 errors) and its 4-byte hash compared against (a) every other function in the codebase, (b) ~80 common DeFi function selectors. **Zero matches.** A malicious `revert X()` cannot be confused for a function-call return value to any consumer in this codebase or any standard DeFi consumer.

### N4 — Function selector collision check: clean.
Every `function X(args)` (excluding `constructor`/`fallback`/`receive`) was extracted (~600 functions) and its 4-byte hash compared. Zero internal collisions; zero collisions with the ~80 common DeFi selectors. Solidity's compiler would refuse to compile internal collisions anyway, but the wider check rules out cross-contract proxy/delegate confusion (e.g. an attacker calling `someTegridyContract.unknownFunc()` whose selector happens to match `transferFrom` would NOT silently dispatch to a transferFrom — there is no such collision).

### N5 — Event topic0 collision check: clean.
Every `event X(args);` (~250 events) hashed to topic0 (full keccak256). Zero collisions. Off-chain indexers branching on `topic0` cannot misroute logs from this codebase.

### N6 — Hardcoded `bytes4` selector constants: all verified.
| Constant | Location | Canonical signature | Match? |
|---|---|---|---|
| `0x01ffc9a7` | `TegridyFactory.sol:323` | `supportsInterface(bytes4)` | OK |
| `0xe58e113c` | `TegridyFactory.sol:323` (param) | ERC-777 token interface ID | OK (NOT a selector — it's an `interfaceId` parameter to `supportsInterface`) |
| `0xaabbb8ca` | `TegridyFactory.sol:356` | `getInterfaceImplementer(address,bytes32)` | OK |
| `0x23b872dd` | `lib/SafeERC721Call.sol:33` | `transferFrom(address,address,uint256)` | OK |
| `0x6352211e` | `lib/SafeERC721Call.sol:35` | `ownerOf(uint256)` | OK |
| `0x80ac58cd` | `TegridyNFTLending.sol:1029` | ERC721 interface ID | OK (interfaceId arg) |
| `0x150b7a02` | `TegridyStaking.sol:1402` (comment) | `onERC721Received(...)` | OK |
| `keccak256("granularity()")` | `TegridyFactory.sol:334` | `granularity()` = `0x556f0dc7` | OK (computed at compile time) |

No silent-success vector exists from a mistyped selector.

### N7 — `SafeERC721Call.safeTransferFromBounded` silent-success vector: closed.
The library uses `outsize=0` raw `call`, which means `ok=true` even if the callee was a contract with a `fallback()` that returns success without doing anything (the documented NFTLEND-NEW-H2 / LD-NEW-H2 attack class). Both call sites (`TegridyNFTLending.sol:857-877`, `TegridyLending.sol:1332-1343`) correctly pair the call with `safeOwnerOfBounded` and verify `newOwner == to`. A malicious ERC721 that no-ops `transferFrom` is detected and the function returns `moved=false`. Defense intact.

### N8 — `WETHFallbackLib` selector usage: safe.
`abi.encodeWithSelector(IWETH.deposit.selector)` and `abi.encodeWithSelector(IWETH.transfer.selector, ...)` use Solidity-resolved selectors from the `IWETH` interface defined in the same file. `IWETH.deposit` resolves to `0xd0e30db0` and `IWETH.transfer` to `0xa9059cbb` — both match canonical WETH9. The `weth` address parameter is restricted to "trusted, immutable address set in the constructor" by docstring at line 60-61, and every consumer passes an immutable storage var. No selector-substitution vector.

### N9 — `POLAccumulator` `staticcall(abi.encodeWithSignature("getReserves()"))` and `token0()`: safe.
At `POLAccumulator.sol:891,895`. The signature strings match canonical Uniswap V2 Pair selectors `0x0902f1ac` and `0x0dfe1681`. Caller checks `okR && dataR.length >= 96` and `okT0 && dataT0.length == 32` before decoding — a fallback-only contract returning short data is rejected. No silent-success.

### N10 — `CommunityGrants` `abi.encodeWithSelector(IERC20.transfer.selector, ...)`: safe.
At `CommunityGrants.sol:975`. Used as a dry-run probe against a candidate `feeReceiver` to detect blacklisting (1-wei test transfer). Failure is gracefully handled (`emit FeeReceiverChangeRejected` and `return` — no revert). Even if the target was a malicious contract that always returns success without state change, the worst outcome is rotating to a "blackholing" `feeReceiver` — but that's user-controlled (the feeReceiver address came from the timelocked `proposeFeeReceiver` call, attacker would need governance access).

### N11 — `TegridyFeeHook` Uniswap V4 hook selectors: all return canonical interface selectors.
`beforeInitialize/afterInitialize/beforeAddLiquidity/afterAddLiquidity/beforeRemoveLiquidity/afterRemoveLiquidity/beforeSwap/afterSwap/beforeDonate/afterDonate` all return `IHooks.<name>.selector` directly. PoolManager validates these exactly per V4 spec — a wrong selector would revert the swap, not silently succeed. Hook is correct.

### N12 — No delegatecall proxies in scope.
`TegridyLaunchpadV2`, `TegridyDropV2`, `TegridyNFTPool`, `TegridyNFTPoolFactory` use OpenZeppelin `Clones` (EIP-1167 minimal proxy) which is delegatecall-based, but the implementation contracts have stable, non-conflicting selectors (no upgrade surface, no admin slot). No selector-clash bite vector.

### N13 — No `msg.sig` branches.
Zero hits for `msg\.sig` across `contracts/src/`. No fallback-style selector-routing logic to bypass.

---

## Tooling notes

Selector-extraction script (used for this audit, deleted after run):
- Walked `contracts/src/` recursively.
- Stripped `//` and `/* */` comments before regex-matching.
- Multi-line signatures handled via `re.S` flag and parenthesis-depth comma-splitter.
- Type normalization stripped `memory`/`calldata`/`storage`/`indexed`/visibility/mutability/`override`/`virtual`.
- Hashing via pycryptodome `Crypto.Hash.keccak`.
- Common-selector reference set drawn from ERC-20, ERC-721, ERC-777, ERC-1820, ERC-1271, ERC-4626, UUPS, OZ Ownable/Pausable, Uniswap V2/V3/V4 Pair+Router+Factory+Hooks, Aave V3, Curve, Multicall3, GnosisSafe, plus all interfaces imported by this codebase.

---

## Verdict

The Tegriddy Farms protocol has **no exploitable selector-clash, signature-collision, fallback-invoke, or hardcoded-selector silent-success vulnerabilities** as of this commit. The two `INFORMATIONAL` findings (F-68-K1, F-68-K2) are intentional ABI-migration helpers, not bugs.
