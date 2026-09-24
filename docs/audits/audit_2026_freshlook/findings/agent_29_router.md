# Agent 29 — TegridyRouter Fresh-Eyes Audit

**Target:** `contracts/src/TegridyRouter.sol` (570 lines)
**Related read:** `TegridyFactory.sol`, `TegridyPair.sol`, `lib/WETHFallbackLib.sol`
**Lens:** path validation, slippage, FoT, ratio enforcement, sandwich, permit replay, WETH boundaries, ETH refund grief, reentrancy, approvals, multi-hop, exact-out vs exact-in, deadline, USDT-style transfer.

## Summary

The router has been subject to extensive prior remediation (H-04, H-05, H-09, H-15, H-17, M-02, M-03, M-25, DEEP-R-L02, DEEP-R-M05, FRESH-EYES H5, M-2, etc.). After fresh-eyes review I did **not** find a new economically exploitable vulnerability. All findings below are either (a) latent footguns the protocol has explicitly accepted via NatSpec, (b) defense-in-depth gaps mitigated downstream by the Pair contract, or (c) gas/UX observations.

No new HIGH/CRITICAL findings. Two LOW informational notes recorded.

---

## F-29-1 — INFORMATIONAL: addLiquidity / addLiquidityETH bypass _pairFor disabled-pair check

**Severity:** INFO (defense-in-depth gap; NOT exploitable)
**Location:** `TegridyRouter.sol:102, 122, 158, 181`

`addLiquidity`, `addLiquidityETH`, `removeLiquidity`, and `removeLiquidityETH` resolve their pair via the raw factory call:

```solidity
address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
require(pair != address(0), "PAIR_NOT_FOUND");
```

rather than through `_pairFor()` (which additionally checks `disabledPairs(pair)`). For `removeLiquidity*` this is **deliberate and correct** — disabled pairs must remain exitable (Pair.burn() also intentionally has no `disabledPairs` gate, only `swap`/`mint`/`skim`/`sync`/`harvest` do).

For `addLiquidity*` the disabled check is delegated to `Pair.mint()` line 130:
```solidity
require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
```

So end-state behaviour is correct: a disabled pair will still revert addLiquidity, but the revert occurs deeper in the call stack with a different revert string than the router-level `PairDisabled()` custom error users see on swaps. **No funds at risk** — the user's safeTransferFrom and WETH deposit are inside the same tx and roll back on revert. This is a consistency / UX observation only, not a vulnerability.

**Caller-visible effect:** different error surface (string `"PAIR_DISABLED"` from pair vs custom error `PairDisabled()` from router) for an otherwise-equivalent halt.

## F-29-2 — INFORMATIONAL: Recipient guard only blocks the FINAL pair, not intermediate pairs in multi-hop paths

**Severity:** INFO (user footgun; not exploitable by third-party)
**Location:** `TegridyRouter.sol:211, 231, 251, 285, 305, 327, 358, 378, 401`

All swap entry points contain:
```solidity
if (to == _pairFor(path[path.length - 2], path[path.length - 1])) revert InvalidRecipient();
```

This blocks the user from accidentally sending output to the FINAL pair (where their tokens would be donated to LPs and skimmable by anyone). However, the check does NOT enumerate INTERMEDIATE pairs. If a caller specifies `to == _pairFor(path[k], path[k+1])` for some `k < hops-1`:
- The output tokens from the FINAL hop go to that intermediate pair.
- The intermediate pair's reserves are not updated; the tokens become a donation that any caller can `skim()` away.
- The user loses their entire output amount.

This is a **user-error / footgun**, not a third-party exploit (no other actor can force the user to specify a bad `to`). Adding the check for all intermediate pairs costs an extra `_pairFor` call per hop (~hops × 5k gas overhead). The protocol has accepted similar single-pair-only check patterns elsewhere; recording for completeness.

**Mitigation already in place:** frontends MUST default `to = msg.sender` and ignore arbitrary user-supplied recipient unless explicitly approved.

## F-29-3 — INFORMATIONAL: WETH-direct transfer of pre-deposited tokens to router becomes permanently stuck (no admin sweep)

**Severity:** INFO (user-error footgun, well-known router pattern)
**Location:** entire contract (no rescue function)

TegridyRouter has `nonReentrant` + zero admin functions. Any tokens (or ETH that bypasses `receive()`'s `require(msg.sender == WETH)` — none can in practice) sent directly to the router address become permanently inaccessible. The FoT-supporting balance-delta pattern correctly handles pre-existing balances:
```solidity
uint256 balanceBefore = IERC20(WETH).balanceOf(address(this));
_swapSupportingFeeOnTransferTokens(path, address(this));
uint256 amountOut = IERC20(WETH).balanceOf(address(this)) - balanceBefore;
IWETH(WETH).withdraw(amountOut);
```
so a malicious actor pre-funding WETH to the router does NOT pollute the user's amountOut calculation. The pre-funded amount simply sits stuck.

This matches Uniswap V2 router pattern. No fix needed; recording because a future version with admin-sweep would alter the trust model.

---

## DEAD-ENDS / NOTES (verified safe, no finding)

### N-1: Fee-on-transfer detection at FINAL hop
The Pair contract enforces `balanceOf(this) == postBalance` after output transfer (lines 272-273). FoT *output* tokens are blocked at the pair level via `FOT_OUTPUT_0/1` revert, regardless of which router variant called. This means even the non-FoT-supporting variants are robust against FoT *output* tokens — they revert cleanly rather than silently undercharging.

### N-2: Multi-hop intermediate token reentrancy
`nonReentrant` on every router entry point + Pair.swap CEI ordering (state update before transfer) + rejection of ERC-777 in factory + 10000-gas stipend in WETHFallbackLib all combine to fully close ERC-777 / token-callback reentrancy. No path I traced lets a malicious intermediate token re-enter any external state.

### N-3: WETH withdraw reentrancy
`receive() { require(msg.sender == WETH, "ONLY_WETH"); }` accepts the 2300-gas callback from WETH9.withdraw with no further logic. WETH cannot trigger second-order calls. No reentrancy vector.

### N-4: ETH refund grief in `addLiquidityETH` / `swapETHForExactTokens`
Refunds use `WETHFallbackLib.safeTransferETHOrWrap(WETH, msg.sender, refund)`:
1. Try `to.call{value:_, gas:10000}("")` — succeeds for EOAs and contracts with cheap `receive()`.
2. On failure, wraps as WETH and `transfer`s the WETH token.
This guarantees no ETH lock for non-receive contracts. Refund tx never reverts on a hostile recipient.

### N-5: Cycle detection vs first-hop short-circuit
`_validatePathNoCycles` returns early for `hops < 2`, but the disabled-pair check on the single hop is still executed via `_pairFor` calls inside `getAmountsOut` (non-FoT) or directly during `safeTransferFrom(...,_pairFor(...),amounts[0])` (FoT). All disabled-pair checks fire BEFORE any token transfer.

### N-6: Path direction enforcement
`_swap` and `_swapSupportingFeeOnTransferTokens` both `_sortTokens(input, output)` and route `amount0Out`/`amount1Out` based on `input == token0`. Factory's bidirectional `getPair[A][B] == getPair[B][A]` mapping ensures a single canonical pair is always returned regardless of caller's token order. Pair direction always matches the router's hop computation.

### N-7: Exact-out vs exact-in for FoT
Documented at lines 263-274 — exact-out is incompatible with FoT input tokens (K-invariant fails). Aggregators must route FoT through `*SupportingFeeOnTransferTokens` variants. NatSpec is explicit; no on-chain detection added because either expensive or unreliable. Acceptable trade-off.

### N-8: Deadline param timing
`ensure(deadline)` requires `block.timestamp <= deadline <= block.timestamp + MAX_DEADLINE` (2 hours). The dual gate prevents both stale orders (the long-tail mempool-delay sandwich footgun) AND immediate-execution timeouts. The 2-hour cap is documented as deliberate (R016 M-1) and incompatible with CowSwap / 1inch LOP / Safe multisigs by design — those integrations must wrap with their own settlement layer. Decision recorded; no remediation needed.

### N-9: USDT-style non-bool transfer
`safeTransferFrom`, `safeTransfer` (OZ SafeERC20) used for all ERC-20 movements. `IWETH(WETH).transfer(...)` is raw (not safeTransfer) because canonical WETH is contractually known to return `bool true`. Acceptable.

### N-10: First-deposit ratio enforcement
`_calculateLiquidity` first-deposit branch (`reserveA == 0 && reserveB == 0`) uses `(amountADesired, amountBDesired)` without checking the Min values. This is standard Uniswap V2 behaviour. Combined with Pair.mint's `MIN_INITIAL_TOKENS` (1000 each) + `INSUFFICIENT_INITIAL_LIQUIDITY` (sqrt > 1,000,000) guards, the classic first-depositor-inflation attack is structurally impossible. Frontrunner can only pre-create-and-seed the pair (which then enters the ratio-enforcement branch where Min values DO apply). User-supplied `amountAMin = 0, amountBMin = 0` would re-open the ratio-attack window — frontend responsibility to default these to non-zero.

### N-11: Permit-add-liquidity / signature replay
**Not applicable.** Router does not implement EIP-2612 permit at the LP-token level (TegridyPair NatSpec note #65: "EIP-2612 permit is not supported on LP tokens"). No signature-based entrypoint exists in TegridyRouter. No replay surface.

### N-12: Token approvals to pair — residue
None. Router uses `safeTransferFrom(msg.sender, pair, amount)` directly — no router-to-pair approval ever exists. No residual allowance to drain.

### N-13: K-invariant double-check for normal vs FoT
For non-FoT swap, `getAmountsOut` pre-computes the exact `amounts[]` based on reserves; `_swap` calls `pair.swap(amount0Out, amount1Out, to, "")` with that exact amount; pair's K-check uses real balance which equals reserves + actual transferIn. Match.

For FoT swap, router computes `amountInput = balanceOf(pair) - reserveIn` (post-transfer reality), recomputes `amountOutput`. Pair's K-check uses the same balance reading internally → match.

The pair-level FOT_OUTPUT_0/1 check (line 272-273) is the strict guard. Router has no need to add an extra delta check — pair refuses to send if its post-transfer balance is wrong.

---

## Conclusion

After ~570 lines of router + supporting Pair/Factory/WETH-lib review, no NEW exploitable finding. The remaining attack surface (user-supplied bad `to`, user-misconfigured `amount*Min = 0`, intentional fund donation to router, accepted 2-hour deadline cap) is documented, structurally bounded, or downstream-mitigated.

**Output path:** `.audit_2026_freshlook/findings/agent_29_router.md`
