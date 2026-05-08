# Agent 06 — SwapFeeRouter Accounting & Distribution Fresh-Eyes Review

Scope: `contracts/src/SwapFeeRouter.sol` (~2064 lines) + `contracts/src/SwapFeeRouterAdmin.sol`
Lens: split BPS invariants, sweep / rescue, donation amplification, distribution math, recipient invariants, frozen fee paths, reentrancy, ETH receive, donation routing.

Methodology: clean-slate read of the contract surface — did NOT consult prior audit history. Findings labelled as F-06-K following requested format.

---

## F-06-A — `swapExactTokensForTokens` with `path[0] = WETH` quietly bypasses staker share (HIGH-leaning, value leak)

**Where:** `SwapFeeRouter.sol:792–835` (`swapExactTokensForTokens`)
**Plus mirror at:** `SwapFeeRouter.sol:980–1035` (`swapExactTokensForTokensSupportingFeeOnTransferTokens` — same shape with WETH at output)

**Issue.** `swapExactTokensForTokens` accepts any `path` of length 2–10 with no constraint that `path[0] != WETH`. The fee is booked as:

```solidity
accumulatedTokenFees[path[0]] += fee;   // line 825
```

When a user calls with `path = [WETH, X, Y]` (passing WETH ERC20 via `transferFrom` instead of native ETH), the fee accrues to `accumulatedTokenFees[WETH]`. The drain routes are:

1. `convertTokenFeesToETH(WETH, ...)` — explicitly reverts at the top: `if (token == address(0) || token == WETH) revert ZeroAddress();` (line 1518).
2. `convertTokenFeesToETHFoT(WETH, ...)` — same revert (line 1646).
3. `withdrawTokenFees(WETH)` — owner-only, sends 100% to treasury (line 1447).

There is **no path that folds `accumulatedTokenFees[WETH]` into `accumulatedETHFees`** even though the contract trivially could (`IWETH(WETH).withdraw(amount)`). Every WETH-input swap therefore robs the staker / POL split lanes — `MIN_STAKER_SHARE_BPS = 5000` is silently zeroed for this tranche.

Same defect in the FoT pair-output variant: `swapExactTokensForTokensSupportingFeeOnTransferTokens` books `accumulatedTokenFees[outToken]` (line 1028), and `outToken == WETH` is a perfectly valid path end. Users who route through this variant with WETH as the last hop bypass stakers identically.

**Why the existing native-ETH path doesn't help:** `swapExactETHForTokens` requires native ETH (`msg.value`) and books to `accumulatedETHFees` correctly. But aggregator integrations and contracts often hold WETH ERC20 and prefer to use `transferFrom`-style entry points; nothing on-chain steers them away. The leak is silent — no event distinguishes WETH-input from any other token-input swap.

**Magnitude.** For a protocol whose marketing line is "stakers earn fees", this is the largest realistic siphon: any whale, aggregator, or simply a user whose ERC20 holds are denominated in WETH ends up paying treasury-only fees. Estimated leak fraction depends on traffic mix; even a few % of WETH-denominated swap volume corresponds to a meaningful chunk of staker yield.

**Suggested fix.**
- Add `if (path[0] == WETH) revert InvalidPath();` to `swapExactTokensForTokens` and the FoT variant — force the user onto `swapExactETHForTokens` (which routes correctly).
- Symmetric: reject `outToken == WETH` in the FoT token-to-token variant — force the user onto `swapExactTokensForETHSupportingFeeOnTransferTokens` for that case.
- OR add `unwrapAndDistributeWETHFees()` permissionless helper that calls `IWETH(WETH).withdraw(accumulatedTokenFees[WETH])` and folds the resulting ETH into `accumulatedETHFees`. Mirrors the spirit of `convertTokenFeesToETH` but skips the swap-and-twap step entirely (no price exposure on a 1:1 unwrap).

---

## F-06-B — `withdrawTokenFees` lets owner front-run permissionless `convertTokenFeesToETH` and bypass the staker share (MEDIUM, governance siphon)

**Where:** `SwapFeeRouter.sol:1440–1449` (`withdrawTokenFees`) vs `1510–1623` (`convertTokenFeesToETH`).

**Issue.** The C1 fix specifically introduced `convertTokenFeesToETH` to route token fees through the timelocked staker/POL/treasury split. But `withdrawTokenFees` was kept as an owner-only escape hatch for tokens "that cannot be swapped to ETH". The natural-language scope is much narrower than the on-chain check: the function works for **every** token, including ones with deep liquid pairs.

Sequence (no owner-key compromise required, just normal use of admin keys):
1. Honest keeper sends a tx calling `convertTokenFeesToETH(token, [token, WETH], minOut, deadline)` to convert `accumulatedTokenFees[token]` and route via 50%+ stakers.
2. Owner mempool-front-runs with `withdrawTokenFees(token)` — pays 100% to treasury.
3. Stakers get 0% on that batch; keeper's tx now reverts with `TokenFeesBelowMinimum` (since `accumulatedTokenFees[token] = 0` after the owner's sweep).

This is a deliberately constructed back-door around the `MIN_STAKER_SHARE_BPS = 5000` guarantee. The propose-time bound is defenceless against an owner-only path that doesn't apply the split.

**Even without owner malice:** an honest owner who forgets to coordinate with the keeper bot will routinely zero out balances the bot was about to convert, simply because owner sweep is a single tx and conversion is a permissionless multi-tx flow.

**Suggested fix.**
- Gate `withdrawTokenFees(token)` on `uniFactory.getPair(token, WETH) == address(0)` — i.e., owner can only sweep tokens with NO direct WETH pair, matching the documented intent.
- Tokens with a WETH pair are forced through `convertTokenFeesToETH`, preserving the staker share.
- Multi-hop-only tokens (those convertible via owner-only multi-hop) are a residual edge case — keep an explicit timelocked drain for them rather than the bare instant `withdrawTokenFees`.

---

## F-06-C — Deferred-distribution `withdrawPendingDistribution` strands WETH on RevenueDistributor / POLAccumulator (MEDIUM, stuck funds)

**Where:** `SwapFeeRouter.sol:1757–1765` (`withdrawPendingDistribution`) → `WETHFallbackLib.safeTransferETHOrWrap` with 10000-gas ETH leg + WETH wrap fallback.

**Issue.** When `distributeFeesToStakers` fails the inner 50_000-gas `.call` to a recipient, the slice is queued in `pendingDistribution[recipient]`. The pull path then invokes:

```solidity
WETHFallbackLib.safeTransferETHOrWrap(WETH, recipient, amount);
```

`safeTransferETHOrWrap` first tries a 10_000-gas raw ETH `.call`. RevenueDistributor's `receive()` does:
```solidity
unchecked { totalETHReceived += msg.value; }
emit ETHReceived(msg.sender, msg.value);
```

Cold-init SSTORE to `totalETHReceived` is 22_100 gas (init from zero) plus base CALL (~2_300) plus LOG2 (~3_700) — comfortably exceeds 10k. The **first** pending-withdrawal will therefore fail the ETH leg and fall back to wrapping into WETH.

The wrapped WETH is delivered to RevenueDistributor as ERC20. But `RevenueDistributor.distribute` (and the entire epoch math) reads `address(this).balance` — pure ETH. The WETH balance is invisible to distribution. It can only be recovered through `proposeTokenSweep` → `executeTokenSweep` (48 h timelock, owner-only, sends ERC20 to a target address, doesn't unwrap or re-route into the staker pipeline).

Net effect: a deferred slice that lands in WETH form on RevenueDistributor is **operationally extracted from the staker pool** until owner manually unwraps and re-deposits it (or sweeps to treasury). For a protocol that nominally earmarked it for stakers, this is a silent escrow drain.

**Likelihood.** Moderate. The 50k stipend is plenty for the receiver's regular `receive()` from `distributeFeesToStakers`, so the deferred path normally only triggers on incident (paused / mid-upgrade / hostile receiver). But the failure mode is exactly when an operator pulls deferred funds — i.e., precisely the recovery scenario the C4 fix was meant to protect.

**Suggested fix.**
- In `withdrawPendingDistribution`, raise the ETH-leg gas to a level that comfortably fits the canonical receivers' `receive()` (RevenueDistributor / POLAccumulator). 50_000 matches `distributeFeesToStakers`'s own cap and is consistent with the intent.
- OR: add `withdrawPendingDistributionAsETH(address recipient, address payable forwardTo)` that tries ETH first with a higher cap and reverts (rather than wrapping) on failure, so the operator can decide instead of silently stranding WETH.
- OR: have RevenueDistributor / POLAccumulator implement a `wethSweep()` that unwraps any held WETH back to ETH and re-emits `ETHReceived`.

---

## F-06-D — `sweepTokens` emits no event, breaking off-chain reconciliation (LOW)

**Where:** `SwapFeeRouter.sol:1722–1729`.

**Issue.** `sweepTokens(token)` is the only treasury-side ERC20 outflow from the contract that does not emit a `FeesWithdrawn` (or any other) event. `withdrawTokenFees`, `sweepETH`, `withdrawPendingDistribution`, and every distribution-related path emit. Indexers monitoring `FeesWithdrawn`/`PendingDistributionWithdrawn`/`TokenFeesConverted` will see token outflows from `withdrawTokenFees` but completely miss `sweepTokens` outflows.

**Impact.** Off-chain reconciliation drift. An attacker (compromised owner) could sweep accidentally-deposited valuable tokens to treasury without leaving an obvious indexer breadcrumb; honest operators who run "treasury inflow vs router outflow" diff dashboards will see unexplained mismatches.

**Suggested fix.** `emit FeesWithdrawn(treasury, sweepable);` (or a dedicated `TokensSwept(token, treasury, amount)` event for cleaner indexer semantics).

---

## F-06-E — Stuck WETH-as-fee dust arithmetic: `withdrawTokenFees(WETH)` reverts if booked > balance after ANY external WETH-debit path (LOW, edge case)

**Where:** `SwapFeeRouter.sol:1440–1449` interacting with a hypothetical loss of WETH balance.

**Issue.** `withdrawTokenFees(token)` does:
```solidity
uint256 amount = accumulatedTokenFees[token];
...
accumulatedTokenFees[token] = 0;
IERC20(token).safeTransfer(treasury, amount);
```

If `IERC20(token).balanceOf(address(this)) < amount`, the `safeTransfer` reverts and the entire transaction (including the zeroing) is unwound. So no permanent loss happens here — the booked amount stays correct.

**However** the function provides no way to drain any **smaller-than-booked** balance. If the contract holds 80 WETH but `accumulatedTokenFees[WETH] = 100` (e.g., because some FoT mechanism on WETH ever produced a haircut, or because of an operational error), the only way out is `convertTokenFeesToETH(WETH)` which reverts at line 1518. Owner has no path to drain 80 WETH and zero the booked 100.

**Likelihood.** Very low — WETH is non-FoT and has no transfer hook on canonical mainnet/L2 deployments. But the contract guards against future FoT WETH variants explicitly (FoT swap variants exist), and the inconsistency means WETH-as-token will silently brick if any haircut ever appears.

**Suggested fix.** When introducing the F-06-A unwrap helper, also handle the underflow case (transfer `min(booked, balance)`, zero booked, log the haircut).

---

## F-06-F — `setSequencerFeed` is one-shot with no on-chain way to detect a wrong feed (LOW operational)

**Where:** `SwapFeeRouter.sol:532–537`.

**Issue.** The setter rejects `address(0)` and rejects re-set after first set:
```solidity
function setSequencerFeed(address _feed) external onlyOwner {
    if (sequencerFeed != address(0)) revert ZeroAddress(); // already set, can't change
    if (_feed == address(0)) revert ZeroAddress();
    sequencerFeed = _feed;
    emit SequencerFeedSet(_feed);
}
```

If the deploy script accidentally sets a wrong feed (Optimism feed on a Base deploy, mocked feed left in production, deprecated address) the contract is **permanently** locked into that wrong feed. The TWAP path runs `SequencerCheck.checkSequencerUp(sequencerFeed, …)` on every conversion — wrong feed could either:
1. Permanently `revert SequencerDown` on a healthy chain (DoS the conversion pipeline forever); or
2. Silently bypass the check (DoS-resistant but no longer protected against real outages).

Recovery requires a full SwapFeeRouter redeploy + every downstream consumer (RevenueDistributor, POLAccumulator, ReferralSplitter, TegridyRouter integration) repointing.

**Suggested fix.** Allow timelocked replacement via `proposeSequencerFeed` / `executeSequencerFeed` with a long delay (e.g., 7 days, parity with `ADMIN_REPLACEMENT_TIMELOCK`). The "captured key cannot swap a benign feed for a controlled one" rationale is valid but is *equally* defended by a 7-day timelock — any swap is observable for a week.

---

## F-06-G — `_validateNoDuplicates` does not reject zero-address intermediate hops (LOW, defence-in-depth)

**Where:** `SwapFeeRouter.sol:1847–1853`.

**Issue.** `_validateConversionPath` (used by `convertTokenFeesToETH{,FoT}`) rejects intermediate `address(0)` hops:
```solidity
if (i > 0 && i < len - 1 && path[i] == address(0)) revert InvalidConversionPath();
```

But `_validateNoDuplicates` (used by every public swap) does not. A user-supplied path like `[WETH, address(0), USDC]` passes the duplicate / endpoint checks and reaches the inner Uniswap router. The router then computes `pairFor(WETH, address(0))`, which resolves to a deterministic empty address; the swap reverts there.

**Impact.** Today this is self-sanitizing because no pair exists at the resolved address. But if a future attacker deploys a malicious "pair" at the deterministic CREATE2 address for the (WETH, 0x0) salt, OR if a future fork uses different `pairFor` math that doesn't hit a dead end, the contract would happily route through the rogue pair.

**Suggested fix.** Mirror the `_validateConversionPath` zero-hop guard inside `_validateNoDuplicates`, or add a separate check in every swap entry point. The cost is one comparison per path element. Cheap defence-in-depth.

---

## F-06-H — Donation routing: native ETH sent to `receive()` always benefits treasury, never stakers (DESIGN, low priority)

**Where:** `SwapFeeRouter.sol:2060–2063`.

**Issue.** `receive()` increments `totalETHReceived` (monotonic counter) but does **not** add to `accumulatedETHFees`. A donor (or an integration with a bug) sending ETH to SwapFeeRouter cannot have it routed through the staker / POL / treasury split — it sits as unaccounted balance. The only drain is `sweepETH` (owner → treasury). Stakers get 0% of donated value.

This contradicts the natural intuition that the contract's `address(this).balance` is the protocol's fee balance. The `accumulatedETHFees` separation is a deliberate accounting choice (well documented in the contract comments), but operationally:
- Anyone tipping the contract ends up tipping treasury, even if they wanted to tip stakers.
- A user accidentally sending ETH to SwapFeeRouter (instead of, say, RevenueDistributor) silently donates to treasury.

**Likelihood.** Low. Donations are rare; the protocol has explicit staker-tipping paths (RevenueDistributor's permissionless `distribute()`). But the asymmetry should be documented in user-facing docs and ideally surfaced as an event-level signal so off-chain monitors can flag accidental donations.

**Suggested fix (optional).** Either:
- (a) Document the routing in a public-facing `RECEIVE_ROUTING` constant string + add an explicit `acceptETHForStakers()` payable helper that adds `msg.value` to `accumulatedETHFees`; or
- (b) Have `receive()` itself credit `accumulatedETHFees += msg.value` — but this changes the documented invariant and could affect off-chain monitors that diff `totalETHReceived` against accounted categories. **Treat (a) as the safer change.**

---

## F-06-I — `pendingDistribution` keyed on stale `revenueDistributor` after timelocked replacement (LOW operational)

**Where:** `SwapFeeRouter.sol:1336–1338` (queue) and `1397–1402` (`applyRevenueDistributor`).

**Issue.** Distribution queues by current address:
```solidity
pendingDistribution[revenueDistributor] += stakerAmount;
```

If governance later proposes/executes a new `revenueDistributor` (`applyRevenueDistributor`), the old address remains in `pendingDistribution`. `withdrawPendingDistribution(oldDistributor)` still works permissionlessly — anyone can pull, but it pays back to the OLD distributor address, not the new one. If the old distributor was paused / decommissioned, the WETH-fallback path applies and WETH lands at the dead address. Total loss for stakers if the old contract was actually destroyed (selfdestruct / proxy clobber).

**Mitigation in place.** The 48 h `REV_DIST_CHANGE_DELAY` gives operators time to drain `pendingDistribution[oldDistributor]` before the swap. But there's no protocol-level reminder in the propose-execute flow — the SwapFeeRouterAdmin's `executeRevenueDistributor` does not even check whether `pendingDistribution[currentDistributor] > 0`.

**Suggested fix.** In `executeRevenueDistributor` (admin), pre-check `router.pendingDistribution(router.revenueDistributor()) == 0` and revert with a custom error if a residual queue exists. Forces operators to drain before rotating.

---

## F-06-J — `withdrawPendingDistribution` is permissionless even in pause (DESIGN trade-off, INFO)

**Where:** `SwapFeeRouter.sol:1757`.

**Note.** This is a deliberate design choice (DEEP-R2-M02) and the rationale is sound: the destination was already chosen at queue-time, so a paused contract shouldn't be able to indefinitely freeze legitimate queue drains.

**However.** If the queued recipient itself is **the very contract** that's being paused for an incident (e.g., RevenueDistributor was paused because of a bug), then:
- `withdrawPendingDistribution(revenueDistributor)` can still be triggered by anyone permissionlessly during the SwapFeeRouter pause.
- The 10k ETH leg fails (per F-06-C), the WETH wrap succeeds, WETH lands on the paused RevenueDistributor.
- RevenueDistributor's pause might prevent reading WETH back out via `receive()`, but the WETH ERC20 transfer doesn't go through `receive()` — it's a `WETH.transfer(to, amount)` from the lib. WETH ERC20 transfers don't call `receive()`. So WETH lands successfully even if RevenueDistributor is paused.
- The WETH then sits at a paused contract, unrecoverable until `proposeTokenSweep` (48h timelock).

This is an interaction between the pause-permissive design here and the WETH-fallback design in the lib. Not a fresh exploit, but worth noting that the pause-permissive choice IS actively load-bearing: removing it would brick legitimate drains during an incident. The right move is probably to keep the design but harden the WETH-stranding side of things (F-06-C).

---

## Notes / dead ends explored, no finding

- **Split BPS sum invariant.** `applyFeeSplit` enforces `_stakerShareBps + _polShareBps <= BPS` AND `_stakerShareBps >= MIN_STAKER_SHARE_BPS (50%)` AND `_polShareBps <= MAX_POL_SHARE_BPS (25%)`. Treasury is computed as `BPS - staker - pol` (remainder) so total always sums to exactly `amount`. No underflow / overflow / dust path. Good.
- **Distribute math rounding.** `treasuryAmount = amount - stakerAmount - polAmount` consumes any integer-division residual. Atomic, no dust loss. Good.
- **Reentrancy via inner Uniswap router.** All swap and convert functions are `nonReentrant`. The inner Uniswap router could call into a malicious token's transfer hook, which could call other contracts, but cannot reenter SwapFeeRouter. Good.
- **Reentrancy via `recordFee` to splitter.** The splitter is called with capped 700_000 gas; SwapFeeRouter is `nonReentrant`. The 700k cap is justified by `MAX_POSITIONS_PER_HOLDER = 50` math in TegridyStaking. Looks correct.
- **Multiple distribute() in same tx.** `accumulatedETHFees = 0` immediately after read. Second call reverts `ZeroAmount`. Good.
- **Donation amplification of pro-rata.** No pro-rata math inside SwapFeeRouter — splits are BPS-based. Donations cannot inflate any recipient's slice. Good.
- **Stuck-balance poisoning.** Token-fee accounting is per-token; one token cannot affect another's accounting. `withdrawTokenFees` zeroes-before-transfer (CEI). FoT lossy path is documented.
- **TWAP cumulative wraparound.** Standard Uniswap V2 modular-arithmetic pattern; survives the year-2106 wrap. Bootstrap path activates exactly at the wrap moment (owner-only). Operationally fine.
- **Cooldown stamp stuck on revert.** `_enforceConversionCooldown` writes `lastConvertedAt[token]` early, but Solidity rolls back state on outer revert. No "stamp set, swap failed" inconsistency.
- **`_recordReferralFee` fail-open.** Splitter failure folds the slice into `accumulatedETHFees` and emits `ReferralFeeRedirectedToTreasury`. Path is well-instrumented.
- **`recoverCallerCredit` global cooldown.** Cooldown only sticks on success; revert rolls back the stamp. Honest keeper interactions are unaffected; griefer pays full pull cost (~62k gas) per attempt with no economic upside (recovered ETH always goes to `accumulatedETHFees`, not the caller).
- **`MIN_MULTIHOP_ETH_OUT_WEI = 1e14` (0.0001 ETH) floor.** Already noted in DEEP-R3-M01; trade-off explicit.
- **`maxFeeBps` user param.** Functions as a CEILING. Cannot be used to under-pay fees.
- **`withdrawTokenFees` zero-before-transfer.** CEI; no FoT phantom-dust trap on this path. Documented under M-04. Good.
- **`sweepETH` reservation.** `accumulatedETHFees + totalPendingDistribution` correctly captures all protocol claims on ETH balance. Donations are correctly identified as the sweepable surplus.
- **Path validation in conversion.** `_validateConversionPath` correctly rejects malformed paths, multi-hop is owner-only, zero-address hops rejected. Good.
- **`pendingDistribution` race with `applyRevenueDistributor`.** Caught as F-06-I, but no on-contract exploit — recovery is operational.

---

## Summary

| ID | Severity (suggested) | Title |
|----|---------------------|-------|
| F-06-A | HIGH | `swapExactTokensForTokens` with `path[0] = WETH` (and FoT variant with `outToken = WETH`) silently bypasses staker/POL split |
| F-06-B | MEDIUM | `withdrawTokenFees` lets owner front-run `convertTokenFeesToETH` and bypass the staker share for any liquid token |
| F-06-C | MEDIUM | Deferred-distribution `withdrawPendingDistribution` 10k-gas ETH leg strands WETH on RevenueDistributor / POLAccumulator's cold-init `receive()` |
| F-06-D | LOW | `sweepTokens` emits no event, breaking off-chain reconciliation |
| F-06-E | LOW | `withdrawTokenFees(WETH)` reverts if booked > balance with no partial-drain escape hatch |
| F-06-F | LOW | `setSequencerFeed` is one-shot — wrong feed bricks the contract permanently |
| F-06-G | LOW | `_validateNoDuplicates` does not reject zero-address intermediate hops in swap paths (defence-in-depth) |
| F-06-H | INFO | `receive()` donation always routes to treasury via `sweepETH`, not stakers (design choice — should be documented) |
| F-06-I | LOW | `pendingDistribution` keyed on stale `revenueDistributor` after timelocked rotation; admin should pre-check residual queue |
| F-06-J | INFO | `withdrawPendingDistribution` permissionless during pause is deliberate; load-bearing design, surfaced for visibility |

**Top priority for protocol revenue integrity: F-06-A and F-06-B.** Both create silent paths for fees to bypass the `MIN_STAKER_SHARE_BPS = 5000` floor that the rest of the contract carefully guards.
