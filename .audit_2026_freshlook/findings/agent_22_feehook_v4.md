# Agent 22 — TegridyFeeHook.sol fresh-eyes audit (V4 spec / permission flags / callback recursion)

**Target:** `contracts/src/TegridyFeeHook.sol` (~849 lines)
**Lens:** Uniswap V4 hook spec compliance; permission-flag bits in deployed address; callback signatures; reentrancy via PoolManager unlock; per-pool config; native ETH currency edges; afterSwap delta direction & sign; flash-accounting interaction.

---

## F-22-K-01 — `pendingSyncCreditSnapshot` reads `poolManager.balanceOf` (ERC6909) but the hook NEVER mints ERC6909 → upward sync is permanently broken (functional, not exploit)

**Severity:** INFO (functional bug, not value-loss).
**Status:** Real, but defensive — owner cannot inflate accruedFees; only legitimate drift recovery is unreachable.

### Where
- `proposeSyncAccruedFees` line 629–640
- `executeSyncAccruedFees` line 661–690
- read site: line 634 / line 671

### Reasoning
The audit comment at line 649–651 claims:

> The hook's claimable balance in the PoolManager is tracked via ERC6909Claims; reading balanceOf(address(this), Currency.toId) gives the maximum the hook is allowed to claim.

This is **incorrect** for this hook's actual settlement pattern. In `afterSwap` (line 430), the hook calls:

```
poolManager.take(feeCurrency, address(this), feeUint);
```

`PoolManager.take()` (`PoolManager.sol:289`) does:
```
_accountDelta(currency, -(amount.toInt128()), msg.sender);
currency.transfer(to, amount);
```

It records a transient delta and **physically transfers tokens**. It does NOT call `_mint(...)`, so it does NOT increment the hook's ERC6909 claim balance. The only PoolManager function that mints ERC6909 is `mint()` (`PoolManager.sol:320`), which the hook never calls.

Therefore `poolManager.balanceOf(this, currencyId)` is **always 0** (or whatever someone external explicitly minted to the hook, which is not the swap-fee path).

### Impact
- `executeSyncAccruedFees` enforces `actualCredit > onChainCreditSnapshot` to revert on upward sync (line 672). Since `onChainCreditSnapshot == 0` for any normal currency, **every upward sync reverts AboveOnChainCredit**, including the bootstrap case where `accruedFees[currency] == 0`.
- Owner can sync DOWN (legitimate drift correction in the wrong direction — fee destruction), but never recover from under-counting drift.
- The R014 cap on `MAX_SYNC_INCREASE_BPS = 1000` (10% step) is moot because no upward sync path is reachable.

### Why this is *defensive*, not exploitable
- It eliminates the captured-owner attack surface where a compromised key could inflate `accruedFees` to drain the hook's actual on-hand balance via `claimFees` / `convertERC20FeesToETH`.
- A captured owner is still bounded by what `accruedFees[currency]` already records.
- accruedFees is never larger than the on-hand contract balance (each take() increments both equally).

### Recommendation (for owner-side ops)
Either:
1. Document explicitly that upward sync is unreachable by design (and remove the dead code path + R014 ceiling); or
2. Replace the `poolManager.balanceOf(...)` snapshot with `IERC20(currency).balanceOf(address(this))` (the actual settlement target). Only do this if the team intends to allow upward syncs; that re-opens captured-owner inflation attacks bounded only by the contract's ERC20 balance, which IS the take() destination, so it is still tamper-proof for the hook itself.

This finding is filed as informational because no value can be extracted by either party.

---

## F-22-K-02 — `sweepETH` does NOT carry `nonReentrant` and uses **unbounded gas** for the ETH transfer

**Severity:** LOW (theoretical reentrancy surface, no value-extraction path identified)

### Where
- `sweepETH` line 836–845

### Reasoning
```
(bool success,) = payable(to).call{value: balance}("");
```
- No gas stipend (contrast `WETHFallbackLib.safeTransferETHOrWrap` line 78 which uses `gas: 10000`).
- Function is `onlyOwner` but lacks `nonReentrant`.
- `to` is constrained to `revenueDistributor` (V3-AMM-H1 fix). If revenueDistributor is a contract with arbitrary receive() logic, it gets full gas and can re-enter.

### Re-entry analysis
During the receive() callback, the hook's `address(this).balance == 0`. So:
- A re-entrant `sweepETH()` call → `require(balance > 0, "NO_ETH")` reverts. Safe.
- A re-entrant `claimFees(currency, X)`:
  - `nonReentrant` modifier is on `claimFees`, but `sweepETH` is NOT inside that guard, so `claimFees` can be re-entered.
  - For `currency == address(0)`: WETHFallbackLib first tries to send `X` ETH to `revenueDistributor`. The hook's balance is 0, so `to.call{value: X, gas: 10000}` succeeds with X==0 only or fails. If `accruedFees[address(0)] >= X`, `claimFees` decrements then attempts `safeTransferETHOrWrap` which calls `to.call{value:X, gas:10000}` — but the hook has 0 ETH, so the call sends 0 (or reverts depending on gas). The library does NOT check that `address(this).balance >= amount` before calling. **A successful 0-value call would emit `ETHTransferred` for an undelivered payment**, but the recipient receives nothing and `accruedFees[address(0)]` was decremented by X — silent value destruction.

Wait — re-checking the `.call{value: X}` semantics: if `address(this).balance < X`, the EVM reverts the call with `ERR_INSUFFICIENT_BALANCE` (it doesn't silently send 0). So `to.call{value: X, gas:10000}` reverts. The library catches the revert via `ok = false`, then falls through to the WETH-wrap fallback: `IWETH(weth).deposit{value: amount}()` — which ALSO reverts on insufficient balance. The whole `safeTransferETHOrWrap` reverts.

So `claimFees(address(0), X)` during sweep re-entry will revert if `address(this).balance == 0`. The decrement of `accruedFees[address(0)] -= X` is rolled back. Safe.

For `currency == WETH`: `accruedFees[WETH] -= X` then `IWETH(WETH).withdraw(X)` — this succeeds if hook has WETH balance (independent of native ETH balance). The withdraw transfers ETH to hook (using WETH9's `to.transfer(amount)` 2300-gas pattern), then `safeTransferETHOrWrap(WETH, revenueDistributor, X)` sends ETH back to revenueDistributor. This works because the hook has WETH ERC20 balance even though native ETH is 0.

So the practical effect of re-entry is: revenueDistributor can drain the hook's WETH-in-ERC20-form during the sweep if it gets full-gas during the sweepETH call. This is not an exploit since the destination (revenueDistributor itself) is the legitimate recipient.

### Impact
None confirmed. The only theoretical concern is gas-grief: revenueDistributor's full-gas receive() can do arbitrary work (including external calls) during sweep. If revenueDistributor is upgraded to a buggy implementation, sweep could fail or consume excess gas.

### Recommendation
Mirror the WETHFallbackLib pattern: use `gas: 10000` on the `payable(to).call`, or add `nonReentrant` to `sweepETH`. Cheap, defensive.

---

## F-22-K-03 — `take()` for native ETH gives `receive()` full gas during `afterSwap` (within unlock)

**Severity:** INFO (no exploit; receive() is empty)

### Where
- `afterSwap` line 430: `poolManager.take(feeCurrency, address(this), feeUint);`
- For currency == address(0), PoolManager's `currency.transfer` is `to.call{value: amount}` with **all available gas**.

### Reasoning
- The hook's `receive() external payable {}` (line 848) is empty → no logic runs during the take.
- However, this is a structural concern: the hook is calling out to itself (via the PoolManager's transfer to address(this)) with full gas during an active V4 unlock context. Any future modification of `receive()` to do anything non-trivial (logging, state mutation, external call) would create a reentrancy surface that bypasses `nonReentrant` (since this is inside `afterSwap` — not protected by ReentrancyGuard).
- `accruedFees[creditToken] += feeUint` is set BEFORE the take(), so re-entrant reads of accruedFees see the post-credit value. CEI-safe today.

### Impact
None today. Latent footgun for future modification.

### Recommendation
Add a comment reminder above `receive()` that ANY logic added there runs inside the V4 unlock context with full gas — before `afterSwap` returns and the hookDelta accounting closes. Better: explicitly mark `receive()` no-op via short comment + lock invariant.

---

## F-22-K-04 — Constructor mask `0x3FFF` is exclusive over the full V4 14-bit flag space (correct), but the deploy script uses `0xFFFF` (slightly looser)

**Severity:** INFO (no current exploit; deploy script is downstream)

### Where
- Constructor: `require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");` (line 223)
- Deploy script: `REQUIRED_FLAGS_MASK = uint160(0xFFFF);` (`script/DeployTegridyFeeHook.s.sol:47`)

### Reasoning
- V4's `ALL_HOOK_MASK = (1 << 14) - 1 = 0x3FFF` (`Hooks.sol:26`). All 14 flag bits are at bits 0..13.
- Constructor mask `0x3FFF` correctly matches V4's flag space — exclusive over flags only.
- Deploy script mask `0xFFFF` covers bits 0..15, which adds bits 14, 15 — but V4 doesn't currently use these. The script's check is over-tight in that it requires bits 14, 15 to be ZERO (since required value is `0x0044`). If V4 ever adds flag bits 14 or 15, the deploy script would FALSELY reject a valid hook address. Constructor would still accept it (since `& 0x3FFF`) — but the deploy script gate is the one that matters (you can't deploy without satisfying it).
- Today: no V4 flags above bit 13, so deploy script's `0xFFFF` mask functionally equivalent to `0x3FFF`.

### Impact
None. Notebook entry for forward-compat.

### Recommendation
Tighten deploy script mask to `0x3FFF` to align with constructor and V4's `ALL_HOOK_MASK`. Cosmetic.

---

## F-22-K-05 — `afterSwap` returned-delta sign / direction matches V4 spec & FeeTakingHook reference exactly

**Severity:** N/A (verification result — clean)

### Verified
- `(params.amountSpecified < 0) == params.zeroForOne` correctly identifies whether currency0 is the specified side (line 369).
- Fee is taken on the UNSPECIFIED currency (matches V4 `FeeTakingHook.sol:41-43`).
- `take()` of `feeUint` to `address(this)` registers `-feeUint` hook delta in transient storage.
- Returned `int128 feeAmount` is positive — V4's `Hooks.afterSwap` (`Hooks.sol:298-302`) adds it to `hookDeltaUnspecified`, then `_accountPoolBalanceDelta(hookDelta)` (`PoolManager.sol:222`) registers `+feeAmount` against the hook. Net hook delta = 0 → no `CurrencyNotSettled` revert at unlock close.
- `swapDelta - hookDelta` reduces caller's output (exact-input) or increases caller's input (exact-output) by exactly `feeUint` of the unspecified currency (line 311 of `Hooks.sol`).
- The fee is taken on |unspecified-side delta|, so feeBps applies to the actual transferred unspecified amount. Decimals-mismatched pairs (WETH↔USDC) are correct because both sides operate in their own native units.

### Note on edge case `swapAmount == type(int128).min`
- `if (swapAmount < 0) swapAmount = -swapAmount;` would overflow on `type(int128).min` (Solidity 0.8 reverts).
- Realistically unreachable: requires a swap with |delta| > 1.7e38 in a single side. Pool liquidity for any token is far below this.

---

## F-22-K-06 — All 14 IHooks signatures match the V4 spec exactly (selectors + return shapes)

**Severity:** N/A (verification — clean)

### Verified against `lib/v4-core/src/interfaces/IHooks.sol`
| Hook | Signature | Selector returned | Return shape |
|------|-----------|--------------------|--------------|
| beforeInitialize | (address, PoolKey, uint160) | IHooks.beforeInitialize.selector | bytes4 ✓ |
| afterInitialize | (address, PoolKey, uint160, int24) | IHooks.afterInitialize.selector | bytes4 ✓ |
| beforeAddLiquidity | (address, PoolKey, ModifyLiquidityParams, bytes) | IHooks.beforeAddLiquidity.selector | bytes4 ✓ |
| afterAddLiquidity | (...) | IHooks.afterAddLiquidity.selector + ZERO_DELTA | bytes4, BalanceDelta ✓ |
| beforeRemoveLiquidity | (...) | beforeRemoveLiquidity.selector | bytes4 ✓ |
| afterRemoveLiquidity | (...) | afterRemoveLiquidity.selector + ZERO_DELTA | bytes4, BalanceDelta ✓ |
| beforeSwap | (address, PoolKey, SwapParams, bytes) | beforeSwap.selector + ZERO + 0 | bytes4, BeforeSwapDelta, uint24 ✓ |
| afterSwap | (...) | afterSwap.selector + feeAmount | bytes4, int128 ✓ |
| beforeDonate | (...) | beforeDonate.selector | bytes4 ✓ |
| afterDonate | (...) | afterDonate.selector | bytes4 ✓ |

All non-implemented hooks return the correct selector — this matters because V4 won't ACTUALLY call them (the address bits are clear) but if anyone calls them via direct EOA, they return harmlessly.

---

## F-22-K-07 — Permission flag bits (0x0044) match implemented hooks ONLY

**Severity:** N/A (verification — clean)

### Verified
- Bit 6 (AFTER_SWAP_FLAG = 0x0040) — implemented in `afterSwap` (line 320). ✓
- Bit 2 (AFTER_SWAP_RETURNS_DELTA_FLAG = 0x0004) — implemented (returns int128 delta). ✓
- All other bits (0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13) MUST be zero per `& 0x3FFF == 0x0044` exclusive equality.
- V4 `isValidHookAddress` in `Hooks.sol:108-126`:
  - "afterSwapReturnsDelta requires afterSwap" — both set ✓
  - "must have at least 1 flag set or dynamic fee" — flags set ✓
- V4 `validateHookPermissions` (`Hooks.sol:82-102`) — not called by this contract (it's a helper for BaseHook deriving implementations); the `0x3FFF == 0x0044` exclusive-equality enforces the same invariant at constructor time.

---

## F-22-K-08 — `onlyPoolManager` only on `afterSwap`; other callbacks are `pure` no-ops

**Severity:** N/A (verification — clean by design)

### Verified
- `afterSwap` (line 326) is the only state-mutating callback; gated by `onlyPoolManager`. ✓
- All other 9 callbacks (beforeInitialize, afterInitialize, beforeAddLiquidity, afterAddLiquidity, beforeRemoveLiquidity, afterRemoveLiquidity, beforeSwap, beforeDonate, afterDonate) are `external pure` returning the selector (and zero delta where applicable). Anyone can call them; result is just the selector. No state changes, no value movement. ✓
- V4 enforces flag bits — these unimplemented callbacks are NOT actually invoked by V4 because their flag bits are clear. `pure` is the correct minimal-cost stub.

### One nit
- The comment at line 279 says "all other hooks return the selector to indicate 'no-op'", but `afterAddLiquidity` and `afterRemoveLiquidity` return `(selector, BalanceDelta.wrap(0))` — also fine. Just slightly ambiguous wording in the comment.

---

## F-22-K-09 — Per-pool config (allowlist) cannot be hijacked by attacker-deployed pool

**Severity:** N/A (verification — pre-existing batch-16 fix is sound)

### Verified
- An attacker deploying their own V4 pool with `(currency0=evil1, currency1=evil2, hooks=this, fee, tickSpacing)` can attach this hook freely (V4 only checks address-bit pattern, not pool-key approval).
- For their pool to actually accrue fees, they would need `approvedPools[keccak256(abi.encode(theirKey))] == true`. Only `onlyOwner.approvePool` sets this. ✓
- If the attacker's PoolKey collides with a Tegriddy-approved key, they would need to match all 5 fields including `currency0`, `currency1`. V4 enforces `currency0 < currency1` and uniqueness via `initialize` — once initialized, no second pool can have the same key. So no collision possible.
- For unapproved pools, `afterSwap` returns `(selector, 0)` and does NOT revert (correct design — reverting would brick swaps on the unapproved pool). User's swap completes; hook does nothing.

### Salt collision on initialize?
- V4 uses `PoolId = keccak256(abi.encode(PoolKey))`. PoolKey has 5 fields (currency0, currency1, fee, tickSpacing, hooks). For a collision, two different PoolKeys would need to hash identically — keccak256 collision-resistance prevents this.
- The hook contract address is FIXED for this hook (deterministic CREATE2). So `key.hooks == address(this)` is the only `hooks` field that matters here.

---

## F-22-K-10 — Native ETH currency handling

**Severity:** N/A (verification — clean)

### Verified
- `Currency.unwrap(ADDRESS_ZERO) == address(0)` represents native ETH.
- In `afterSwap`, when `feeCurrency == Currency(address(0))`:
  - `poolManager.take(address(0), address(this), feeUint)` → PoolManager calls `currency.transfer(this, feeUint)` which is `to.call{value: feeUint}` (full gas; see F-22-K-03).
  - The hook's empty `receive()` accepts the ETH. Hook's `address(this).balance += feeUint`.
- `accruedFees[address(0)] += feeUint` tracks the ETH balance.
- `claimFees(address(0), amount)` (line 514–516) forwards via `WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount)`. ETH is on-hand. ✓
- `convertERC20FeesToETH(address(0), ...)` rejects via `if (currency == address(0)) revert ZeroAddress();` — native ETH is already-ETH and never needs conversion. ✓
- `WETH` immutable can never be set to address(0) (constructor zero-check at line 212). So the WETH-vs-native discrimination in claimFees is unambiguous.

---

## F-22-K-11 — Hook fee withdrawal authorization (claimFees / convertERC20FeesToETH / sweepETH)

**Severity:** N/A (verification — clean)

### Verified
- `claimFees`: **permissionless** (anyone can call), but funds always go to `revenueDistributor` (immutable destination during the call). Branch:
  - currency == address(0): forward ETH ✓
  - currency == WETH: unwrap and forward ETH ✓
  - else: revert MustConvertERC20First ✓ (closes the TF-INT-02 stranded-ERC20 bug)
- `convertERC20FeesToETH`: `onlyOwner` + `nonReentrant` + `whenNotPaused`. Owner-supplied router, path, deadline, minETHOut. Floor `minETHOut >= 1e14` (BATCH-L4-M6). Drains on-hand ERC20 balance. End destination is `revenueDistributor` (immutable during call).
- `sweepETH`: `onlyOwner`, recipient pinned to `revenueDistributor` only (V3-AMM-H1 fix). Captured-owner cannot sweep to attacker. ✓ (See F-22-K-02 for the gas-stipend nit.)

### Sync proposal lockout
- Both `claimFees` and `convertERC20FeesToETH` block while a sync proposal for `currency` is pending and not yet expired (`SYNC_PENDING` revert). Prevents drain-during-timelock race. ✓
- Expired-sync edge: an expired proposal does NOT block (V2-AMM-M1 fix). ✓
- Permissionless `expireSyncAccruedFees` lets anyone clean up stale state (V3-AMM-M2). ✓

---

## F-22-K-12 — Owner-as-attacker bounds (post-relaunch threat model)

**Severity:** Notebook only

### Verified
- Compromised owner CAN:
  - Pause the hook → `afterSwap` returns 0-fee silently. Swaps still work for users; protocol revenue stops. Recoverable by un-pausing.
  - Propose fee change up to MAX_FEE_BPS (1%) → 24h timelock. Recoverable by cancelling within 24h.
  - Propose distributor change → 48h timelock. Recoverable by cancelling within 48h.
  - Approve / revoke pools at will. **Approval has NO timelock** (line 257 docstring: "additive operation"). Owner can flip an attacker's malicious pool to approved → fee accrual on attacker's pool. But the hook only credits `accruedFees[attacker_token]`, which then goes through `convertERC20FeesToETH` (also onlyOwner). Attacker would need owner cooperation in BOTH steps. Owner-attack scenario already covers this.
  - Sweep ETH → constrained to `revenueDistributor` only (V3-AMM-H1).
  - Convert any ERC20 → ETH → swap is `onlyOwner`, slippage floor 1e14, destination `revenueDistributor`. Sandwich-resistant by floor; rug-resistant by destination immutability.
- Compromised owner CANNOT:
  - Inflate `accruedFees` upward (F-22-K-01 — broken-by-default).
  - Sweep funds to anything other than `revenueDistributor`.
  - Bypass timelock on fee/distributor changes.
  - Re-direct claimed value (immutable WETH; immutable revenueDistributor pre-rotation).

---

## F-22-K-13 — `approvePool` does NOT validate `key.hooks == address(this)` (cosmetic owner-mistake mode)

**Severity:** INFO

### Where
- `approvePool` line 259–263

### Reasoning
- If an owner approves a `key` where `key.hooks != address(this)`:
  - The hash includes `key.hooks`.
  - V4 only calls THIS hook's `afterSwap` for pools where `pool.hooks == address(this)` (by V4 design, the bytecode at the hooks address is what V4 calls).
  - The hash-mismatch means: when V4 calls afterSwap with `key.hooks = address(this)`, the computed hash differs from the approved hash, so `approvedPools[h] == false`, fee = 0.
- Net: owner mistake just doesn't approve anything, no exploit. But also no error feedback — the misconfigured approval silently does nothing.

### Recommendation
Add `require(address(key.hooks) == address(this), "WRONG_HOOK_ADDR");` in `approvePool`. Cheap, prevents silent misconfiguration.

---

## F-22-K-14 — `proposeSyncAccruedFees` reads `pendingSyncCreditSnapshot` from `poolManager.balanceOf` mid-construction → potential view re-entrancy?

**Severity:** None (verification — N/A)

### Reasoning
- `proposeSyncAccruedFees` is `onlyOwner` and not callable during PoolManager unlock (it is called outside swap context).
- `poolManager.balanceOf` (ERC6909.balanceOf) is a pure view — reads `_balances[owner][id]`. No reentrancy.
- Even if it could reenter, snapshot is the only state mutation aside from `_propose` and `pendingSyncCredit`, all idempotent on this path.

---

## F-22-K-15 — Hook fee + flash accounting (flash + take + settle): no interaction surface

**Severity:** None (verification)

### Reasoning
- The hook does NOT call `unlock()` itself, so no flash accounting from this contract's side.
- The hook is INSIDE V4's unlock context only during `afterSwap`. Within that, it only calls `poolManager.take(...)` exactly once. No `settle()`, no `mint()`, no `burn()`, no recursive `unlock()`.
- The hook does NOT borrow flash loans — its own ERC20/ETH flows are funded from the take() and stored on-hand for later forwarding.
- Re-entry from the take() (only meaningful for a malicious ERC20 token's transfer hook) — but the hook only allows owner-approved pools. Owner is trusted to not approve malicious-token pools. Defense is consistent with the "Owner trust model" elsewhere.

### One nit
- An ERC20 with a transfer hook (ERC777, hook tokens, etc.) could call back into `claimFees` / `convertERC20FeesToETH` from inside the take()'s `currency.transfer(this, feeUint)`. But:
  - Those functions are `nonReentrant` — except `afterSwap` itself is NOT inside ReentrancyGuard. The take() happens INSIDE afterSwap. If the malicious token's transferHook calls `claimFees(currency, X)`, it WOULD enter the ReentrancyGuard for the first time (since the GuardEntered flag is per-modifier, and no nonReentrant'd function has been called yet in this tx). Then inside `claimFees`, the modifier sets the lock and runs.
  - Inside reentrant `claimFees(currency, X)`: decrements `accruedFees[currency] -= X`. But `accruedFees[currency]` was already incremented by the in-flight `afterSwap` BEFORE the take() call (line 406). So a sufficiently large reentry could decrement to 0. Then the in-flight afterSwap continues with the take() that already returned, returns the int128, and V4 closes accounting normally.
  - **The on-hand balance after the malicious token's reentry is correctly forwarded** (claimFees CEI-cleans by decrementing accruedFees BEFORE physical transfer of remaining balance). Net economic effect: legitimate flow, just executed in interleaved order.
  - This is NOT a vulnerability; it's the documented permissionless-claimFees pattern.

---

## F-22-K-16 — `_poolKeyHash` uses `keccak256(abi.encode(key))` — identical to V4's PoolId derivation

**Severity:** N/A (verification — clean)

### Verified
- `keccak256(abi.encode(PoolKey))` (line 248) ≡ `PoolIdLibrary.toId(poolKey)` (`PoolId.sol:11–17`) which uses `keccak256(poolKey, 0xa0)` over the 5-slot struct.
- Both are bit-identical. The hook's allowlist hash is canonical V4 PoolId.

---

## F-22-K-17 — Constructor's `0x3FFF` mask is forward-compatible for V4 to add new flag bits (with caveat)

**Severity:** Notebook only

### Reasoning
- If V4 adds bit 14 (or higher) flags in a future release, the constructor's `& 0x3FFF` mask would NOT cover them. A salt-mined address with bit 14 set would PASS the constructor check (since `& 0x3FFF` masks bit 14 to zero) but might trigger NEW V4-side hook calls the contract is not prepared for.
- The audit comment at line 218–222 acknowledges this: "if V4 ever adds bits 14+, this constant must be revised in tandem with v4-core's `Hooks.permissionsToFlags`".
- Today (V4 deployed): only 14 bits used. ✓

### Recommendation
Already documented in code; agent confirms.

---

## Dead-end notes

- **Singleton vs per-pool state collisions**: `accruedFees[currency]` is keyed by token ADDRESS, not pool. Multiple approved pools sharing currency0=A, currency1=B would all increment `accruedFees[A]` and `accruedFees[B]`. This is by design — fee revenue is fungible per currency. No collision issue.
- **Salt collision on initialize**: V4 PoolId = keccak256(PoolKey). Salt-mined for hook ADDRESS, not for PoolId. PoolId collision is keccak256-resistant.
- **Hook upgrade path**: hook is non-upgradeable (no proxy). Owner can rotate `revenueDistributor` (48h timelock) and `feeBps` (24h timelock). No bytecode change possible. ✓
- **Sequencer downtime / pause behavior**: `paused()` short-circuits `afterSwap` to (selector, 0) — swaps still work, fees pause. Distinct from a SwapFeeRouter sequencer-staleness check. The hook does not query a sequencer oracle (correctly — it's mainnet-only per project, no L2 sequencer to track).
- **Salt key scrutiny**: deploy script mines salt off-chain via `cast create2 --ends-with 0044`. Mainnet — no MEV-frontrun on the deploy tx that matters since the hook is permissionless and the address is deterministic from initCode + salt + deployer.
- **Beyond-spec audit**: `sweepETH` already restricted to revenueDistributor (V3-AMM-H1). All other admin (fee, distributor, sync) gated by timelock. M-32 threat model preserved.
- **Aerodrome / AAVE-style invariants**: not applicable to this hook (no debt accounting, no LP positions, no oracle).

---

## Summary

**Critical / High:** none.
**Medium:** none.
**Low:** F-22-K-02 (sweepETH unbounded gas).
**Info:** F-22-K-01 (upward sync unreachable due to ERC6909 mis-assumption, defensive), F-22-K-03 (full-gas receive() during afterSwap, latent), F-22-K-04 (deploy script mask cosmetic), F-22-K-13 (approvePool missing key.hooks == this guard).

**V4 spec compliance:** clean. All hook signatures, flag bits, return shapes, and delta directions match canonical reference (`FeeTakingHook.sol`).

**Callback recursion safety:** clean. `take()` is the only PoolManager call from `afterSwap`; `nonReentrant` on the public claim path; `whenNotPaused` on conversion / claim. No flash-accounting interaction surface.

**Permission flag correctness:** clean. `0x0044` (afterSwap + afterSwapReturnsDelta) is exclusive over the V4 14-bit flag space and matches the implemented surface.
