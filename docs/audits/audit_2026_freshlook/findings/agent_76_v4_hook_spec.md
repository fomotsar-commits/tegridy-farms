# Agent 76 — Fresh-Eyes V4 Hook Spec Compliance Audit

**Target**: `contracts/src/TegridyFeeHook.sol` (~849 lines)
**Lens**: Uniswap V4 IHooks interface compliance, permission-flag bitmap, BalanceDelta semantics, recent V4 hook exploit patterns (2024–2026)
**Date**: 2026-05-07

---

## Web Sources Cited

- [Uniswap v4-core IHooks interface (main branch)](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IHooks.sol)
- [Uniswap v4-core Hooks library — flag constants](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol)
- [Uniswap v4-core PoolManager — take() / swap() / unlock()](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
- [Uniswap v4-core BalanceDelta type](https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol)
- [Uniswap v4-core Currency.transfer (ETH path)](https://github.com/Uniswap/v4-core/blob/main/src/types/Currency.sol)
- [v4-core canonical FeeTakingHook reference](https://github.com/Uniswap/v4-core/blob/main/src/test/FeeTakingHook.sol)
- [Cork Protocol $11M hack — Dedaub post-mortem (May 2025)](https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/)
- [Hacken — Auditing Uniswap V4 Hooks](https://hacken.io/discover/auditing-uniswap-v4-hooks/)
- [Cyfrin — Uniswap v4 Hooks Security Deep Dive](https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive)
- [DEV.to — 7 V4 Hook Attack Vectors That Cost DeFi $11M](https://dev.to/ohmygod/uniswap-v4-hook-security-7-attack-vectors-that-already-cost-defi-11m-and-how-to-defend-against-262)

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| HIGH | 0 | — |
| MEDIUM | 2 | F-76-A, F-76-B |
| LOW | 3 | F-76-C, F-76-D, F-76-E |
| INFO | 4 | F-76-F, F-76-G, F-76-H, F-76-I |
| RESOLVED-OK | 5 | (10 areas audited; 5 are clean) |

**Bottom line**: The hook is largely compliant with the V4 IHooks spec — afterSwap delta semantics are correct, the take() pattern matches the canonical FeeTakingHook reference, the permission-flag enforcement (`& 0x3FFF == 0x0044`) is exclusive, and the Cork-Protocol-style `onlyPoolManager` access control IS in place. Two MEDIUM issues remain around (1) IHooks signature mismatch — the no-op stub hooks are declared `pure` while the IHooks interface declares them `external` (no purity restriction), creating a function-selector ABI compatibility hazard if V4 tooling enforces interface mutability, and (2) the asymmetric handling of native ETH (address(0)) inside `afterSwap` vs `claimFees` — `take()` for address(0) routes raw ETH through the hook's `receive()` with full gas forward, but the hook only has an empty `receive()` (no reentrancy guard at receive-time), creating a window during multi-hook composition where a sibling hook on a sibling pool can re-enter while the unlock context is still open.

---

## F-76-A — MEDIUM — IHooks no-op stubs declared `pure`; canonical interface methods are non-pure / non-view

**File**: `contracts/src/TegridyFeeHook.sol:281-317, 440-450`

**V4 spec rule** (per [v4-core IHooks.sol](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IHooks.sol)): *"All methods are external (not pure or view). All methods return a bytes4 function selector as their primary return value."*

**Mismatch in TegridyFeeHook**: The 8 no-op stub hooks are declared `external pure`:

```solidity
281:    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
285:    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
289:    function beforeAddLiquidity(...) external pure returns (bytes4) {
295:    function afterAddLiquidity(...) external pure returns (bytes4, BalanceDelta) {
301:    function beforeRemoveLiquidity(...) external pure returns (bytes4) {
307:    function afterRemoveLiquidity(...) external pure returns (bytes4, BalanceDelta) {
313:    function beforeSwap(...) external pure returns (bytes4, BeforeSwapDelta, uint24) {
440:    function beforeDonate(...) external pure returns (bytes4) {
446:    function afterDonate(...) external pure returns (bytes4) {
```

**Why this matters**:

1. **Interface inheritance compatibility**: `IHooks` declares these methods without a state mutability restriction. Solidity 0.8.26 *allows* `pure` overrides of non-pure interface methods (`pure` is more restrictive, which is permitted). However, **the function selector is identical** — selectors are derived from name + parameter types, NOT mutability — so the V4 PoolManager's external call via `IHooks(hook).beforeInitialize(...)` will succeed at the EVM level.

2. **Real-world risk — V4 spec evolution**: V4 has shipped a `Hooks.permissionsToFlags` and a periphery `BaseHook.validateHookPermissions` pattern. If the V4 spec is ever extended to require **non-pure** lifecycle hooks (e.g., to support `tstore`/`tload` for transient flag-coordination across hooks), the upgrade would be source-incompatible with this contract. Any V4 reference test (e.g., Hacken's open-source v4-hook testing framework) that compiles a `MockHook is IHooks` and exact-matches the mutability would fail to compile against this contract.

3. **No exploit primitive in the current spec** — but this is a **forward-compatibility hazard**. The agent flags it as MEDIUM because the cost of correction is trivial (drop `pure`) and the cost of being wrong on a future V4 fork is potentially "redeploy with new salt mining" (CREATE2 address dependent on bytecode).

**Recommended fix**: Drop `pure` on the 8 no-op stubs — match the canonical IHooks declaration exactly. The hooks are stateless TODAY but the *interface contract* should be honored per spec.

**Note on `afterAddLiquidity` / `afterRemoveLiquidity`**: These ALSO return a second value `BalanceDelta`. The current declaration `(bytes4, BalanceDelta)` returning `(IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0))` is correct. ✓

---

## F-76-B — MEDIUM — `receive()` accepts unrestricted ETH inside the unlock window with no reentrancy guard at receive-time

**File**: `contracts/src/TegridyFeeHook.sol:430, 848`

**V4 spec rule** (per [PoolManager.sol take() implementation](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)): *"`take(currency, to, amount)` calls `currency.transfer(to, amount)`, which for `currency == address(0)` executes `call(gas(), to, amount, 0, 0, 0, 0)` — forwarding ALL available gas with no stipend."*

**Mismatch**:

Line 430:
```solidity
poolManager.take(feeCurrency, address(this), feeUint);
```

Line 848:
```solidity
receive() external payable {}
```

**Attack pattern (recent V4 exploit class — multi-hook callback sandwich)**:

Per the [Cyfrin V4 hook security deep dive](https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive): *"Any external call made during beforeSwap, afterSwap, or liquidity callbacks reopens the entire execution environment. This invalidates assumptions about atomicity and order. Teams must test and reason about reentrancy into the same pool where nested callbacks can overwrite internal state or read partially updated values."*

When `feeCurrency == address(0)` (native-ETH pool — V4 supports these directly without WETH wrapping), `poolManager.take(ADDRESS_ZERO, address(this), feeUint)` triggers a raw-ETH transfer to this contract via `call(gas(), to, amount, ...)` with **all remaining gas forwarded**. The `receive()` at line 848 is empty, so it:

- Has **no `nonReentrant` modifier** on receive itself
- Has **no `whenNotPaused` modifier**
- Cannot block re-entry into other contract functions

**Exploit primitive**:

Consider a contract that hooks BOTH `TegridyFeeHook` (for currency0=ETH pool) AND a separate hook on the SAME PoolManager. During Tegridy's `afterSwap`:
1. `accruedFees[ADDRESS_ZERO] += feeUint` (line 406)
2. `poolManager.take(ADDRESS_ZERO, address(this), feeUint)` (line 430) — sends ETH with full gas
3. `receive()` is invoked on this contract — but receive() can NOT directly re-enter the PoolManager (because the unlock context is owned by the original caller). HOWEVER:
   - `receive()` CAN call back into TegridyFeeHook external functions like `claimFees`, `convertERC20FeesToETH`, or admin functions — **except** all sensitive paths are gated by `nonReentrant` from the OZ ReentrancyGuard, AND `claimFees` is gated by `whenNotPaused`.
   - **The actual gap**: during the `take()` call in afterSwap, the OZ `nonReentrant` modifier is NOT set on `afterSwap` itself — only `claimFees` and `convertERC20FeesToETH` carry it. The `onlyPoolManager` modifier protects re-entry of afterSwap itself, but a malicious downstream contract receiving the ETH could re-enter `claimFees` from a different non-PoolManager context. The `nonReentrant` on `claimFees` would catch THIS, BUT `claimFees` is permissionless and a recursive call from receive() would be on a fresh tx-level call frame (the OZ nonReentrant uses transient storage post-Cancun, so it WOULD catch this).

**Verdict**: The attack is **defense-in-depth-blocked** by the existing `nonReentrant` modifiers on the value-routing paths. However:

(a) **The `receive()` itself accepts arbitrary ETH from arbitrary callers** — not just from `poolManager.take()`. A griefer can directly send ETH to inflate `address(this).balance` beyond `accruedFees[ADDRESS_ZERO]`. The only path to drain this surplus is `sweepETH(revenueDistributor)` (line 836–845) — which IS owner-gated and recipient-restricted to `revenueDistributor`. Line 841 also requires `balance > 0` (passes) but there's no upper-bound check. This is **not exploitable** but creates a **dust-attack surface** where attackers can pad the contract's ETH balance to confuse off-chain accounting.

(b) **More serious — the `take()` recipient pattern**: per the [Bunni v2 BunniHook pattern referenced in line 510](https://github.com/Bunniapp), best practice is to immediately `claim` the address(0)-balance via `poolManager.mint` to ERC-6909 instead, so the ETH stays inside PoolManager's accounting (avoiding the unlock-window gas-forward attack surface entirely). Tegriddy uses `take()` (raw ETH transfer) which is correct per `FeeTakingHook` reference, but is the **higher-risk** of the two patterns documented in v4-periphery.

**Severity**: MEDIUM — no direct value-loss primitive identified, but creates an **expanded attack surface** during the unlock window. The empty `receive()` cannot enforce the standard "only-poolManager-during-unlock" invariant.

**Recommended hardening**:

```solidity
receive() external payable {
    // Optional: emit event so off-chain accounting can detect direct-send dust attacks
    // Optional: restrict to msg.sender == address(poolManager) during normal operation,
    //          but allow direct sends from anyone (no good way to distinguish)
}
```

OR — preferred — switch from `take()` to `mint()` for the ERC-6909 claimable-balance pattern (the BunniHook approach), which keeps the funds inside PoolManager and adds them to the hook's claimable balance without invoking `receive()` at all. This requires updating `claimFees` to call `poolManager.burn` + `poolManager.take` later, but eliminates the unlock-window gas-forward surface for native-ETH pools.

---

## F-76-C — LOW — Permission-flag bitmap (0x0044) is correctly exclusive but lacks defensive width

**File**: `contracts/src/TegridyFeeHook.sol:223`

**V4 spec rule** (per [v4-core Hooks library](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol)):

| Flag | Bit | Hex |
|---|---|---|
| AFTER_SWAP_FLAG | 1 << 6 | 0x0040 |
| AFTER_SWAP_RETURNS_DELTA_FLAG | 1 << 2 | 0x0004 |
| ALL_HOOK_MASK | (1 << 14) - 1 | 0x3FFF |

The hook's address must encode `0x0040 | 0x0004 = 0x0044` in its lower 14 bits.

**Mismatch / observation**:

```solidity
require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");
```

The check is **exclusive** (`==`, not `&`), correctly rejecting any over-permissioned address (one with extra flag bits set). The 0x3FFF mask matches V4's current 14-flag bitmap. ✓

**Forward-compat risk**: The NatSpec at line 218–222 acknowledges this — *"if V4 ever adds bits 14+, this constant must be revised in tandem with v4-core's Hooks.permissionsToFlags to keep this constructor exclusive over the new flag space"*. This is correctly documented.

**LOW finding**: The `0x3FFF` mask should be a `public constant` (e.g., `HOOK_PERMISSION_MASK = 0x3FFF`) so off-chain monitoring can verify the exact flag-space the constructor enforces, AND so future-V4 forks that change the mask can be detected by reading the constant. This is purely a code-hygiene / observability fix.

**Verification of CREATE2 address requirements**: A salt-mined address ending in `...0044` (lower 14 bits) is required. The hook addresses any DESIRED extra flag (e.g., afterDonate 0x0010) would be rejected by line 223. ✓

---

## F-76-D — LOW — `afterSwap` BalanceDelta sign convention is correct, but vulnerable to a subtle int128 underflow on `-swapAmount`

**File**: `contracts/src/TegridyFeeHook.sol:382`

**V4 spec rule** (per [BalanceDelta type](https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol) and the canonical [FeeTakingHook.sol](https://github.com/Uniswap/v4-core/blob/main/src/test/FeeTakingHook.sol)):

The delta returned by `swap()` and passed to `afterSwap` is from the **swapper's** perspective:
- Negative delta = swapper paid (input)
- Positive delta = swapper received (output)

The fee is taken from the **unspecified** currency (the side the PoolManager solves for):
- `bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);`

**Mismatch / vulnerability**:

The Tegriddy implementation:

```solidity
369:    bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
370:    Currency feeCurrency;
371:    int128 swapAmount;
372:    if (specifiedIsZero) {
373:        feeCurrency = key.currency1;
374:        swapAmount = amount1;
375:    } else {
376:        feeCurrency = key.currency0;
377:        swapAmount = amount0;
378:    }
382:    if (swapAmount < 0) swapAmount = -swapAmount;
```

**This matches the FeeTakingHook reference 1:1.** ✓

**Underflow risk on line 382**: `int128` has range `[-2^127, 2^127 - 1]`. The expression `-swapAmount` UNDERFLOWS if `swapAmount == type(int128).min == -170141183460469231731687303715884105728`. This is the asymmetric-int-range issue. Solidity 0.8.26 with `unchecked` blocks would silently wrap; without `unchecked`, this would revert.

The current code is NOT inside `unchecked {}`, so a `swapAmount == type(int128).min` would revert with `Panic(0x11)` (arithmetic overflow). This bricks the swap.

**In practice**: A swap delta of `-170141183460469231731687303715884105728` corresponds to a swap of ~1.7e17 ether-equivalent — physically unreachable on any V4 pool. The mathematical possibility exists but is unreachable.

**LOW**: Recommend `if (swapAmount < 0) swapAmount = swapAmount == type(int128).min ? type(int128).max : -swapAmount;` for bullet-proofing — OR document the unreachability inline. The canonical FeeTakingHook has the same flaw, so this is V4-ecosystem-wide latent.

---

## F-76-E — LOW — `claimFees` `MustConvertERC20First` revert on `accruedFees[currency] > 0` for non-WETH/non-ETH strands fees if approvedPools is later revoked

**File**: `contracts/src/TegridyFeeHook.sol:521-522, 526`

**Context**: The pool allowlist (line 333) blocks fee accrual on unapproved pools. `claimFees` (line 491) is permissionless and rejects non-WETH/non-ETH currencies via `MustConvertERC20First`. The `convertERC20FeesToETH` path (line 555) is `onlyOwner`.

**Scenario**:
1. Owner approves a pool with currencies (USDC, ETH).
2. ~30 days of swaps accrue ~1000 USDC in `accruedFees[USDC]` and the hook's USDC balance.
3. Owner revokes the pool (line 271).
4. New swaps no longer accrue — but the **existing** USDC balance is still claimable via `convertERC20FeesToETH`.
5. **However** if the owner key is later compromised AND the attacker doesn't have a valid USDC↔WETH router path (e.g., USDC liquidity dried up on the supplied router), the funds are stranded until a working router emerges.

**LOW**: This is a known-and-accepted trade-off. The `convertERC20FeesToETH` path requires owner cooperation (and the `minETHOut >= 1e14` floor at line 572 protects against full sandwich). The "permissionless" claim path that would otherwise drain stuck ERC20s is correctly gated — there's no path for a non-owner to drain non-WETH/non-ETH fees.

**Verification**: The `onlyOwner` gate on `convertERC20FeesToETH` means a captured-owner attack could front-run with a bad router/path and lose fees to slippage, BUT the `1e14` floor + immutable `revenueDistributor` (line 612–614) caps the loss to `(twap_value − 1e14)` — bounded, not catastrophic. ✓

---

## F-76-F — INFO — `onlyPoolManager` on afterSwap correctly defends against the Cork Protocol $11M attack pattern

**File**: `contracts/src/TegridyFeeHook.sol:190-193, 326`

**V4 spec rule** (per [Cork Protocol Dedaub post-mortem](https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/)):

> *"The vulnerable beforeSwap hook function lacked an onlyPoolManager modifier, allowing anyone to call it directly with arbitrary parameters. ... Every external hook function that can modify state or is intended to be called by the PoolManager (e.g., beforeSwap, afterSwap, beforeInitialize) must implement robust access control."*

**Tegriddy's defense**:

```solidity
190:    modifier onlyPoolManager() {
191:        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
192:        _;
193:    }
326:    ) external onlyPoolManager returns (bytes4, int128) {
```

✓ — `afterSwap` is gated by `onlyPoolManager`. An attacker cannot directly call `afterSwap(...)` to fake fee accrual.

**Additional defense — pool allowlist** (line 333): Even if `onlyPoolManager` is bypassed via a future PoolManager upgrade vulnerability, the `approvedPools[_poolKeyHash(key)]` gate would silently zero-fee unapproved pools. This is **defense-in-depth** that goes beyond the single missing-modifier failure mode of Cork.

**No-op stubs** (beforeInitialize / afterInitialize / beforeAddLiquidity / etc., lines 281–317, 440–450): These are NOT gated by `onlyPoolManager`. They are `external pure` and return only the canonical selector with no state mutation. A direct call from any caller is harmless — the selector return is a constant and there's no state to corrupt. ✓

---

## F-76-G — INFO — `take()` settles the hook delta inside the unlock context — no `CurrencyNotSettled` revert

**File**: `contracts/src/TegridyFeeHook.sol:430, 437`

**V4 spec rule** (per [Unlock Callback & Deltas guide](https://docs.uniswap.org/contracts/v4/guides/unlock-callback)):

> *"The unlock function reverts if the NonzeroDeltaCount is not zero after the unlockCallback executes, throwing the CurrencyNotSettled error."*

**Tegriddy's pattern**:

1. Line 437: returns `feeAmount` as the int128 hookDeltaUnspecified — this registers a POSITIVE hook delta (= hook is owed value).
2. Line 430: `poolManager.take(feeCurrency, address(this), feeUint)` — drains `feeUint` from PoolManager into this hook's ERC20/ETH balance, registering a NEGATIVE hook delta of equal magnitude.
3. Net hook delta after unlock-close: `+feeAmount + (-feeAmount) = 0` — passes the `CurrencyNotSettled` check.

**Verification against canonical FeeTakingHook**: The pattern is identical to v4-core's `lib/v4-core/src/test/FeeTakingHook.sol:48`. The PASS7-HOOK-01 NatSpec (lines 409–423) explicitly documents the bug that would occur without the `take()` call. ✓

---

## F-76-H — INFO — PoolKey hash collision / cross-chain replay surface

**File**: `contracts/src/TegridyFeeHook.sol:247-249`

**V4 spec rule** (per [Hacken — "Auditing Uniswap V4 Hooks"](https://hacken.io/discover/auditing-uniswap-v4-hooks/) and [Cantina Kyber Hook audit](https://cantina.xyz/portfolio/eb59f23b-ef3c-4b3c-9d28-3455d5337d3f)):

> *"If the same hook instance or PoolKey is deployed on multiple networks through CREATE3-based salt mining, an attacker can lift any valid signature and nonce from one chain and replay it on another chain. ... no domain separator is included — chain ID, deployment salt, and contract identity outside the key are absent."*

**Tegriddy's PoolKey hash**:

```solidity
247:    function _poolKeyHash(PoolKey calldata key) internal pure returns (bytes32) {
248:        return keccak256(abi.encode(key));
249:    }
```

**Analysis**: The hash is over `abi.encode(PoolKey)` which contains `(currency0, currency1, fee, tickSpacing, hooks)`. The `hooks` field IS the deployed address of THIS contract — chain-specific via CREATE2. So:

- **Same-chain collision**: Impossible — currencies are unique per chain, and PoolKey is canonical.
- **Cross-chain replay**: `approvedPools` is per-deployment storage. The hash function is identical across chains, but the `approvedPools[hash] = true` write is local to each deployment. A signed message authorizing pool approval (which doesn't exist in this contract — `approvePool` is `onlyOwner` direct call, NOT signature-based) cannot be replayed.

**No signature-based authorization in this contract** — `approvePool`/`revokePool`/`proposeFeeChange`/`proposeDistributorChange`/etc. are all `onlyOwner` direct calls. The cross-chain replay risk identified by Hacken applies to **signed orders** (e.g., MEV-protected quote-RFQ patterns), which Tegriddy does not implement.

**Verdict**: ✓ — No replay surface in this contract.

---

## F-76-I — INFO — Hook upgrade path (no in-place upgrades)

**File**: `contracts/src/TegridyFeeHook.sol:50, 207-229`

**V4 spec rule**: Per the [Uniswap V4 docs](https://docs.uniswap.org/contracts/v4/concepts/hooks): *"Once a hook is deployed, the permissions cannot be changed."* — Hook permissions ARE the deployed address (via CREATE2 mining). An "upgrade" requires a new deployment to a new salt-mined address, and migration of all pools.

**Tegriddy's design**:

- Hook is `OwnableNoRenounce` + `Pausable` — non-upgradable contract pattern.
- All sensitive parameters use timelocked propose/execute (`FEE_CHANGE_DELAY = 24h`, `DISTRIBUTOR_CHANGE_DELAY = 48h`, `SYNC_DELAY = 24h`).
- The `revenueDistributor` IS upgradable via 48h timelock — this is the only post-deployment "value routing" knob.
- The `WETH` address is `immutable` — set at construction, never mutable.
- The `poolManager` is `immutable`.

**Upgrade hazard**: If a critical bug is discovered post-deployment, the migration path is:
1. Pause (instant via `pause()`).
2. Deploy new TegridyFeeHook V2 to a new salt-mined `...0044` address.
3. For each approved pool: ask LPs to migrate liquidity to a new pool with the new hook (no in-place pool migration in V4 — this is a V4-architectural limitation, not specific to Tegriddy).
4. Old pools become "stuck" — afterSwap returns 0 fee (paused), swaps still complete on the old pool but no fees accrue.

**LP-side consequence**: LPs on V1 pools get NO fee value from veTOWELI distribution post-pause — they keep their LP-fee revenue but Tegriddy's hook fee is dropped on the floor. This is a known V4 design constraint.

**Verdict**: ✓ — No technical bug, but the V4-architectural limitation is worth highlighting in deployment runbooks. The `Pausable` design correctly degrades to "swaps still work, no Tegriddy fees" rather than "swaps revert" (line 337–339), which avoids LP DoS.

---

## RESOLVED-OK — Areas audited that pass V4 spec compliance

1. **IHooks return-selector pattern** — All 10 hook methods return the correct `IHooks.<name>.selector`. ✓
2. **afterSwap return shape** — `(bytes4, int128)` matches V4 spec. ✓
3. **BalanceDelta sign convention** — Matches FeeTakingHook reference 1:1 (line 369–382). ✓
4. **Unspecified-currency determination** — Same `(amountSpecified < 0) == zeroForOne` logic as v4-core. ✓
5. **`take()` settling hook delta inside unlock** — Pattern of record (PASS7-HOOK-01 fix). ✓
6. **`onlyPoolManager` on `afterSwap`** — Cork Protocol attack mitigated. ✓
7. **Pool allowlist** — Defense-in-depth even if onlyPoolManager is breached. ✓
8. **Reentrancy guard on value-routing paths** — `claimFees` and `convertERC20FeesToETH` are `nonReentrant`. ✓
9. **Pause as circuit-breaker** — `paused() → return zero fee` (line 337–339), correctly avoiding pool DoS. ✓
10. **PoolKey hash determinism** — `keccak256(abi.encode(key))` matches V4's internal pool-id derivation. ✓

---

## Notes / Dead-ends

### Dead-end 1: Looked for asymmetric exact-input vs exact-output handling

The DEV.to article on V4 hook attacks flags asymmetric exact-input/exact-output as a common arbitrage primitive. Tegriddy's `afterSwap` correctly handles BOTH directions with the same code path (lines 369–382). The `if (swapAmount < 0) swapAmount = -swapAmount` on line 382 is symmetric. ✓

### Dead-end 2: Looked for bad delta returns from `beforeSwap`

Tegriddy's `beforeSwap` (line 313–317) returns `BeforeSwapDeltaLibrary.ZERO_DELTA` and `0` for the LP fee override. This is a no-op stub. The hook permission flag `BEFORE_SWAP_FLAG = 0x0080` is NOT set on the deployment address (only `0x0044`), so V4's PoolManager would NEVER call beforeSwap on this hook. The stub is dead code — but harmless and required by the IHooks interface inheritance.

### Dead-end 3: Looked for hook-callback recursion via PoolManager.unlock from within afterSwap

`afterSwap` is invoked from inside an active unlock context. Calling `poolManager.unlock(...)` recursively WOULD revert (transient-storage lock check). The `take()` call on line 430 is allowed because it's NOT a re-unlock — it's a sub-operation within the existing unlock. ✓

### Dead-end 4: Looked for `mint()` vs `take()` accounting differences

V4 hooks can settle their delta via either `take()` (pulls actual ERC20/ETH out of PoolManager) or `mint()` (creates an ERC-6909 claim that stays inside PoolManager). Tegriddy uses `take()`. The `mint()` pattern (used by Bunni v2) would avoid the F-76-B receive() surface for native-ETH pools but adds gas cost and complicates `claimFees`. The `take()` choice is documented as canonical (PASS7-HOOK-01 NatSpec, lines 419–420). ✓ — different trade-off, not a bug.

### Dead-end 5: Looked for the z0r0z V4 Router calldata-offset bug (March 2026)

Per the dev.to article: *"the z0r0z V4 Router lost $42K because inline assembly trusted a fixed calldata offset."* Tegriddy uses no inline assembly (`grep -n "assembly" TegridyFeeHook.sol` → 0 hits). ✓

### Dead-end 6: Looked for missing `whenNotPaused` on the receive() / sweepETH path

`receive()` is not gated — see F-76-B. `sweepETH` (line 836–845) is `onlyOwner` (no `whenNotPaused`). A paused state should arguably block sweeps too, but the current design lets the owner recover ETH during a pause — which is the recovery use-case. ✓ Acceptable.

---

## Final Severity Distribution

| Sev | Count |
|---|---|
| HIGH | 0 |
| MEDIUM | 2 (F-76-A, F-76-B) |
| LOW | 3 (F-76-C, F-76-D, F-76-E) |
| INFO | 4 (F-76-F, F-76-G, F-76-H, F-76-I) |

**Recommendation priority**:
1. **Quick win**: Drop `pure` on the 8 IHooks no-op stubs (F-76-A) — 1-line change × 8 files, zero behavioral impact, eliminates forward-compat hazard.
2. **Defense-in-depth**: Consider adding `event ETHReceived(address from, uint256 amount)` to `receive()` for off-chain dust-attack monitoring (F-76-B).
3. **Code hygiene**: Make `0x3FFF` and `0x0044` named constants (F-76-C).
4. **Documentation**: Add `int128.min` underflow note to line 382 (F-76-D).

The contract is broadly compliant with V4 spec and defends against the known 2025–2026 attack patterns (Cork Protocol, asymmetric swap handling, callback sandwich). No HIGH-severity findings.
