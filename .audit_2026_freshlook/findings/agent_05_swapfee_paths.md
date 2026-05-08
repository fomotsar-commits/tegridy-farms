# Agent 05 — SwapFeeRouter Path & External-Call Audit

**Scope:** `contracts/src/SwapFeeRouter.sol` (2064 lines) plus related sister contracts (SwapFeeRouterAdmin, POLAccumulator, RevenueDistributor) for context.
**Lens:** swap path manipulation, arbitrary external call vectors, route safety, ERC20 approve residue, recipient validation, sandwichable internal swaps, deadline / slippage abuse.
**Date:** 2026-05-07
**Auditor:** Agent 05/100 fresh-eyes pass.

## Summary

The SwapFeeRouter has been hardened over many audit waves. The router is **immutable** at construction, all swap destinations are hardcoded `address(this)` for internal swaps, the conversion path is explicitly validated with multi-hop owner-gating, and TWAP-floor anchoring against the direct token/WETH pair defends single-block sandwich on the conversion entrypoints. The `to == address(this)` and `to == address(0)` checks are present on every user-facing swap. ERC20 approvals are bracketed `forceApprove(amount)` … `forceApprove(0)` so residue is not exploitable.

I find **no fresh code-level critical or high-severity exploit primitive**. I record below a small number of low/info-level observations and several explicit dead-ends I considered.

---

## F-05-1 (LOW / Info) — `applyFeeSplit` allows `polShareBps > 0` while `polAccumulator == address(0)`

**Location:** `contracts/src/SwapFeeRouter.sol:1373-1380`, with consumer at `:1346-1358`.

**Finding:** `applyFeeSplit(stakerShareBps_, polShareBps_)` checks the share-band invariants but does NOT check that `polAccumulator != address(0)` before allowing `_polShareBps > 0`. The reciprocal guard exists on `applyPolAccumulator` (line 1389-1394: `if (_newAccumulator == address(0) && polShareBps > 0) revert PolShareNonZero();`), but nothing enforces the converse direction.

**Impact:** If governance executes `applyFeeSplit` to set `polShareBps > 0` BEFORE setting a non-zero `polAccumulator`, then for the window between the two timelocks, every `distributeFeesToStakers()` call would silently route the POL slice to treasury via the fallback at line 1356:
```
treasuryAmount += polAmount;
polAmount = 0;
```
This violates the timelocked fee-split invariant the same way the DEEP-R-M04 fix on `applyPolAccumulator` was meant to prevent — but from the other direction. The window is bounded by however long an admin takes to schedule both timelocks (potentially weeks if mis-sequenced) and only matters during the active fee-split window.

**Severity:** LOW. Funds are not at risk (the fallback to treasury is an explicitly-acknowledged behaviour, line 1342-1345); only the share allocation is silently bent. Bound is human-process: admins are expected to set the accumulator first, then the split.

**Recommendation:** Add an analogous check in `applyFeeSplit`:
```
if (_polShareBps > 0 && polAccumulator == address(0)) revert PolShareNonZero();
```

---

## F-05-2 (INFO) — Stale comment on `receive()` claims "donated ETH gets distributed proportionally"

**Location:** `contracts/src/SwapFeeRouter.sol:2039-2049`, contradicted by `:1311-1369` and `:1421-1429`.

**Finding:** The block comment on the `receive()` function says:
> Anything else that lands here (donations, accidental sends, mistransferred refunds) becomes "unaccounted" balance that gets distributed proportionally on the next `distribute()` along with the legitimate fee balance.

This is **factually wrong**. `distributeFeesToStakers()` only operates on `accumulatedETHFees` (line 1313), not on `address(this).balance`. Stray ETH donations sit in the contract's balance until `sweepETH()` (owner-only, treasury-only) drains the diff via `balance - accumulatedETHFees - totalPendingDistribution`. So donations end up at TREASURY, not split to stakers/POL/treasury.

**Impact:** Doc bug only — has misled at least one prior auditor (per the comment chain). May cause future devs to think the comment is correct and design accordingly. No runtime effect.

**Severity:** INFO.

**Recommendation:** Update the comment to:
> Anything else that lands here is "unaccounted" balance, retrievable only via `sweepETH` (owner-only → treasury). It does NOT enter the staker/POL/treasury split.

---

## F-05-3 (INFO) — Hardcoded `gas: 50_000` on `revenueDistributor` / `polAccumulator` call

**Location:** `contracts/src/SwapFeeRouter.sol:1334`, `:1348`.

**Observation:** The 50k gas stipend is documented (line 1323-1330) and the rationale is sound for the current minimal `receive()` shims on RevenueDistributor and POLAccumulator. However, both of those contracts have grown features over audit waves (e.g., POLAccumulator's `receive()` at 308-318 emits `ETHReceived(sender, msg.value)` and bumps a counter; RevenueDistributor at 315 does similar). Future feature growth on either contract's `receive()` could push past the 50k stipend, silently failing the direct call and routing through the `pendingDistribution` queue.

**Impact:** No funds-at-risk — the queue catches the failure. But each silent push to `pendingDistribution` requires a follow-up `withdrawPendingDistribution(recipient)` call (permissionless, but operationally noisy). A future EIP that bumps the cost of `CALL` or specific opcodes (e.g., a redo of EIP-2929 cold-access pricing) could turn this into a chronic reroute.

**Severity:** INFO / monitoring.

**Recommendation:** No code change required. Consider an off-chain monitor on `DistributionDeferred` events with alerting when more than (say) 3 deferrals fire within 24 h.

---

## F-05-4 (INFO) — `withdrawPendingDistribution` doesn't bind to original recipient codehash

**Location:** `contracts/src/SwapFeeRouter.sol:1757-1765`.

**Observation:** Already documented in-code as `DEFERRED: DEEP-R-L01` (line 1751-1756). The argument made there is correct — without CREATE2 metaproxies in this protocol's codebase, codehash binding adds storage cost without realistic threat. Re-confirming: the queued ETH is sent to the SAME address that was originally chosen at queue time, so there's no attacker-steering window unless the original deployment is attacker-CREATE2-replaced. None of the protocol's deployment contracts use CREATE2 metaproxies as of this audit.

**Severity:** INFO / acknowledged by prior audit.

**Recommendation:** None — re-verify if any future contract starts using CREATE2 metaproxies to deploy fee destinations.

---

## F-05-5 (INFO) — Multi-hop conversion floor `MIN_MULTIHOP_ETH_OUT_WEI = 1e14` (~$0.30)

**Location:** `contracts/src/SwapFeeRouter.sol:248`, enforced at `:1572` and `:1682`.

**Observation:** The hardcoded floor is governance-immutable and intentionally restrictive (DEEP-R3-M01). The convert-to-ETH path is owner-only on multi-hop, so the floor is defence-in-depth against owner-key compromise / operator script error. With `MIN_TOKEN_FEE_FOR_CONVERSION = 1e18` of input token and a token worth, say, $1 / unit, the input is $1 and the realistic ETH output may be $0.99-ish; the 1e14 wei floor (~$0.30) admits up to ~70% slippage on this hypothetical, which is large but documented as a worst-case bound for owner-key compromise rather than legitimate flow.

**Impact:** Acknowledged design trade-off. Owner trust + multi-hop infrequency bound the realistic loss.

**Severity:** INFO.

**Recommendation:** Consider per-token `MIN_TOKEN_FEE_FOR_CONVERSION` overrides if the protocol ever conserves fees in a 6-decimal stablecoin (the current 1e18 floor is ~$1T for USDC/USDT, locking permissionless conversion permanently for those). This is already noted in the in-code commentary at line 211-216.

---

## Dead-ends considered (no finding)

1. **`recoverCallerCreditFrom(oldSplitter)` arbitrary call.** The owner-only pull against an arbitrary external splitter is gated by (a) `onlyOwner`, (b) `nonReentrant`, (c) the only state effect is `accumulatedETHFees += recovered` (same lane as legitimate fee ingress). A hostile splitter can return less ETH than expected but cannot drain the contract. Documented at line 1823-1832.

2. **Approval residue on `IERC20(token).forceApprove(address(router), 0)`.** Even if a token's `approve(0)` reverts and leaves a non-zero allowance, the residue is not exploitable: the V2 router's swap functions call `transferFrom(msg.sender_to_router, ...)` — i.e., they pull from whoever called the router. An external EOA can't make `msg.sender_to_router == SwapFeeRouter`. Only SwapFeeRouter calling the router itself uses the allowance, and inside SwapFeeRouter the next swap of that token re-runs `forceApprove(amount)` which clears any stale allowance.

3. **Path with malicious intermediate token.** A user-supplied path containing an attacker-deployed pair affects only that user's swap (their tokens go to/from the malicious pair). The fee accounting is on `path[0]` (input side) for non-FoT and on `path[length-1]` (output side) for FoT — both well-defined regardless of intermediate hops. The contract's accumulated fees and balances are isolated from the user's swap by the `balBefore` / delta-measurement pattern.

4. **`amountOutMin = 0` on user swaps.** Users CAN pass `amountOutMin = 0`, leaving themselves exposed to sandwich. This is the user's choice and matches Uniswap UX. The contract just relays the user's slippage tolerance. Not a SwapFeeRouter finding.

5. **Reentrancy via FoT token transfer hook to `to`.** All swap entrypoints have `nonReentrant`. The FoT hooks could re-enter other contracts but cannot re-enter SwapFeeRouter functions.

6. **Inner Uniswap V2 router immutable.** Set in constructor at line 504 (`router = IUniswapV2Router02(_router);`), `immutable`. Cannot be swapped out post-deploy. Even an admin-replacement (via `proposeAdminReplacement`) only swaps the SwapFeeRouterAdmin sister, not the underlying Uniswap router.

7. **Sequencer feed one-shot setter.** `setSequencerFeed` (line 532-537) reverts if `sequencerFeed != address(0)`, so a captured-key attacker cannot swap a benign feed for a malicious one post-deploy. Mainnet stays at `address(0)` (no-op), L2 owner sets once at deploy.

8. **TWAP bootstrap front-run.** First conversion of any token is owner-only (line 1996), so no permissionless caller can manipulate the bootstrap snapshot. Subsequent conversions inherit the on-chain TWAP floor.

9. **`_validateNoDuplicates` cycle check for swap paths.** Catches `[A, B, A]`-style cycles and identity `[A, A]`. Combined with `path[0] == WETH` / `path[length-1] == WETH` checks on directional variants, the path shape is well-bounded.

10. **Premium discount fail-open.** If `premiumAccess.hasPremiumSecure` reverts (paused, broken, OOG), the user pays the BASE fee without the discount (line 631-643) — a fail-open posture acknowledged in the docstring. No ability for an attacker to drive the discount higher.

11. **`distributeFeesToStakers` permissionless caller.** Anyone can call. No funds at risk because (a) destinations are governance-set with timelock, (b) gas-bounded calls, (c) pull-pattern fallback. No incentive for an attacker to call (no caller fee). MEV resistance is provided by the fact that the call doesn't change any oracle-readable state — it just moves ETH along pre-set paths.

12. **`recoverCallerCredit` global cooldown grief.** Documented at length (line 1782-1801). Attacker can race honest keepers for the event-puller designation but cannot capture funds (recovered ETH always lands in `accumulatedETHFees`). Pure griefing for the event log only — bounded by gas cost (~62k per attempt).

13. **`convertTokenFeesToETH` deadline-too-far edge.** `MAX_DEADLINE = 2h` (line 128). Forwarded to inner router as-is. Cannot be bypassed.

14. **`swapExactTokensForTokens` final-token validation.** No `path[length-1]` whitelist, but that's correct — the user chooses the output token. The contract holds the user's input and approves the router only for `amountAfterFee`. The output goes to the user's specified `to`.

15. **`receive()` stray ETH inflation.** `totalETHReceived` (line 2058) is monotonic and informational. `accumulatedETHFees` is the only authoritative slot used in distribute/sweep, so stray ETH cannot inflate distributions.

---

## Concise verdict

No critical or high-severity exploit primitive identified by this fresh-eyes pass. The previously-disclosed audit findings (SFR-H-01 TWAP, NEW-A4 deadline, NEW-A5 cooldown, M-2 premium fail-open, R-014 input-token override semantics, M-04 zero-before-transfer, C1 token-fee conversion path, DEEP-R*-M01..M06, etc.) are all in evidence with proper enforcement.

The single LOW (F-05-1) is a sibling-miss to DEEP-R-M04 worth fixing in the next admin-flow batch. The INFO items are doc-cleanup or monitoring suggestions.
