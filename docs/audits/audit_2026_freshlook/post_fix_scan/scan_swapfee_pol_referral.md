# Confirmatory exploit scan — SwapFeeRouter / SwapFeeRouterAdmin / POLAccumulator / ReferralSplitter

**Date:** 2026-05-09
**HEAD:** `d5ca554` on `main` (post Wave-A + minimal-MED commit + Wave-B revert)
**Mandate:** `memory/feedback_minimal_surface.md` — custom code IS the exploit source.
**Scope:**
- `contracts/src/SwapFeeRouter.sol` (2,064 lines)
- `contracts/src/SwapFeeRouterAdmin.sol` (431 lines)
- `contracts/src/POLAccumulator.sol` (964 lines)
- `contracts/src/ReferralSplitter.sol` (803 lines)

**IMPORTANT:** the prior `fix_review/agent_review_SwapFeeRouter.md` (2,333-line / 525-line files, dated 2026-05-08) was **reviewing the reverted Wave-B code**. The current contracts are smaller and DELIBERATELY do NOT contain the F-06-A `unwrapAndDistributeWETHFees`, the F-06-B `withdrawTokenFees` WETH-reject, the F-06-F 7-day sequencerFeed timelock, the F-06-I `pendingDistribution` drain-check, or the F-67-1 5-minute caller-credit cooldown. Those are all part of the Wave-B that `e441133` reverted. The acceptance posture is recorded in `.audit_2026_freshlook/POST_MANDATE_STATE.md` lines 39-40.

This scan therefore does NOT re-classify those Wave-B constructs as JUSTIFIED / QUESTIONABLE / REDUNDANT. They are NOT IN THE CODE. Instead I confirm the user's per-marker concern about residual on-chain exploits in the actually-shipped (smaller) code.

---

## 1. Per-marker confirmation against the as-deployed code

### M-5 / F-06-A — "SwapFeeRouter WETH path bypasses staker share" — accepted-as-design
**As-shipped behaviour (verified):**

`swapExactTokensForTokens(WETH, X, …)` (line 793) lets a user run a WETH-input token-token swap. Fee is taken from `path[0]` and booked at `accumulatedTokenFees[path[0]]` (line 825). When `path[0] == WETH`, that is `accumulatedTokenFees[WETH]`.

**The ONLY exit for `accumulatedTokenFees[WETH]`:**
1. `convertTokenFeesToETH(WETH, …)` and `convertTokenFeesToETHFoT(WETH, …)` REVERT with `ZeroAddress()` at lines 1518 and 1646 (`if (token == address(0) || token == WETH)`).
2. `withdrawTokenFees(WETH)` (line 1440) is `onlyOwner`, has NO WETH-reject, and sends 100% to treasury at line 1447.
3. `sweepETH()` (line 1421) reserves only `accumulatedETHFees + totalPendingDistribution` (line 1424), so WETH-balanced ERC20 funds in this slot are NOT directly drained by `sweepETH`. But the WETH is also held as ERC20 dust on top, and `sweepTokens(WETH)` at line 1722 reserves `accumulatedTokenFees[WETH]` and only sweeps the EXCESS — so it cannot drain the booked WETH either.

**On-chain residual:** the only path that can move `accumulatedTokenFees[WETH]` is `withdrawTokenFees(WETH)`, which is `onlyOwner` + treasury-destination. The owner's treasury rotation is gated by the 48h `TREASURY_CHANGE_DELAY` on `SwapFeeRouterAdmin` (line 74). A captured-key attacker would need to (1) propose a treasury rotation, (2) wait 48h, (3) `executeTreasuryChange`, (4) `withdrawTokenFees(WETH)`. The attack window is bounded by the timelock; the protocol's social trust posture is the actual mitigation, exactly as POST_MANDATE_STATE.md line 39 documents.

**No new exploit found.** The accepted-as-design posture is correct: the operational mitigation is to never apply fees on WETH-input token-token swap paths and/or to drain `accumulatedTokenFees[WETH]` to the timelocked treasury. No staker funds at risk via M-5 in the current code; all OTHER swap-paths route fees via `accumulatedETHFees` (lines 716, 782, 967) which DOES flow through the timelocked staker/POL/treasury split.

---

### M-6 / F-06-B — `withdrawTokenFees` "drain-to-treasury for any token" — accepted-as-design
**As-shipped behaviour (verified):**

`withdrawTokenFees(address token)` at line 1440-1449 is `onlyOwner` + `nonReentrant` and:
- Checks `token != address(0)` only (line 1441).
- Does NOT reject `WETH`.
- Does NOT gate on `factory.getPair(token, WETH) == 0`.
- Zero-then-transfer (CEI: line 1446 zero, line 1447 transfer).

**Therefore the user's Q ("verify gate is at apply path, not just propose") is not applicable here** — there is no propose/execute split for `withdrawTokenFees`; the function is direct-fire owner-only. The gate the user is asking about does not exist in the current code.

**On-chain residual:** owner CAN call `withdrawTokenFees(ANY_TOKEN)` (including WETH and tokens with a liquid WETH pair) and route the fee 100% to treasury — bypassing the staker share that `convertTokenFeesToETH` would have captured. Same trust-window posture as M-5: the attacker needs the owner key plus the 48h treasury timelock to redirect the destination first. POST_MANDATE_STATE.md line 40 accepts this.

**No new exploit found.** The relevant invariant — that `convertTokenFeesToETH` is the path that DOES flow through stakers — is intact (line 1621 `accumulatedETHFees += ethReceived;`). Stakers are protected on every fee path that can be converted; the trust assumption only matters for `withdrawTokenFees`, which is admin-only and timelock-anchored.

---

### M-39 / F-94-04 — POL captured-owner harvest 10%/30d — accepted-as-design
**Question:** confirm the harvest path uses canonical price-impact bound (e.g. TWAP-min-out).

**Verification — `executeHarvestLP` at POLAccumulator.sol:655-713:**
- Line 663: `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);`
- Line 676: `(uint256 floorToken, uint256 floorETH) = _twapHarvestMinOut(lpAmount);`
- Lines 677-678: `effMinToken = max(minToken, floorToken)`; `effMinETH = max(minETH, floorETH)` — caller can only TIGHTEN.
- Lines 682-684: `router.removeLiquidityETH(toweli, lpAmount, effMinToken, effMinETH, address(this), deadline)`.
- Line 688: post-call sanity `address(this).balance - ethBefore >= ethOut`.

**`_twapHarvestMinOut` at lines 859-950:**
- TWAP staleness gate via `getLatestObservation(lpToken)` (lines 861-862, `OracleStale` revert).
- Post-resume freshness gate (lines 864-867, `OracleObservationPredatesResume` revert).
- TWAP-bypass cooldown (`lastBypassUsed`, lines 875-879, mirrors TegridyLending).
- Spot-vs-TWAP deviation gate at `HARVEST_TWAP_DEVIATION_BPS = 50` (lines 932-937, `ReservesDeviateFromTWAP` revert) — narrowed from 200bps to match `TWAP_SAFETY_BPS` per AUDIT FIX MEDIUM-5.
- Fair-LP-price computation via Alpha-Homora-V2 / RAI K-invariant pattern: `K = r0*r1`, `fairToweli = sqrt(K * toweliUnit / twapEthPer1eToweli)`, `fairEth = K / fairToweli` (lines 939-943).
- Per-leg floor: `floor = (share * (BPS - TWAP_SAFETY_BPS)) / BPS` with `TWAP_SAFETY_BPS = 50` (50 bps = 0.5%) (lines 945-949).

**Verdict — JUSTIFIED.** The harvest uses a canonical TWAP-min-out anchor (Alpha-Homora / RAI fair-price). The 10%/30d cap is enforced at propose-time at line 639-640 (`require(lpAmount <= (totalLPCreated * MAX_HARVEST_BPS) / 10000)`, `MAX_HARVEST_BPS = 1000` = 10%). The 30-day delay at `POL_HARVEST_DELAY = 30 days` (line 626).

The accepted-as-design wording in POST_MANDATE_STATE.md M-39 is "tightening to a rolling annual cap would add new state (mandate violation); accept the documented bound." — that is the cap question, NOT the price-impact question. Price-impact is FULLY canonicalized.

---

### F-25-K-* ReferralSplitter — `receive()` invariant check
**Source:** `contracts/src/ReferralSplitter.sol:227`
```solidity
receive() external payable {}
```

**Invariant analysis:**
- Bare empty `receive()` — no body, no events, no SSTORE. Gas: ~2,300 (just CALLDATALOAD + STOP).
- All in-protocol fee ingress to ReferralSplitter goes through `recordFee(_user)` at line 353 (a `payable onlyApproved nonReentrant` function), NOT through the bare `receive()`.
- Treasury / referrer / caller-credit accounting is keyed on `recordFee`-side state writes (lines 366, 374, 415, 420). The bare `receive()` has zero accounting impact.
- ETH that lands via the bare `receive()` (donations, dust, accidental sends) is "unaccounted balance" — `sweepUnclaimable` (line 777) reserves `totalPendingETH + accumulatedTreasuryETH + totalCallerCredit` (line 780) and sweeps the EXCESS to treasury. Donations therefore route to treasury, which is the documented intent.

**Cross-reference to user concern:** the user asks "does the bare receive() break protocol invariants?" — **No.** The three invariants:
1. `pendingETH[r]` accounting = sum of `recordFee` referrer-shares minus `claimReferralRewards` payouts. Bare `receive()` does not touch this.
2. `callerCredit[c]` accounting = sum of `recordFee` non-referral-shares minus `withdrawCallerCredit` payouts. Bare `receive()` does not touch this.
3. `accumulatedTreasuryETH` = sum of forfeited / unqualified shares minus `withdrawTreasuryFees` payouts. Bare `receive()` does not touch this.

All three are conserved. The bare `receive()` is a no-op accumulator for "donated" ETH which is correctly reserved against by `sweepUnclaimable`'s 3-line reservation.

**Verdict — JUSTIFIED.** The bare `receive()` is the canonical pull-pattern fee accumulator shape (Curve FeeDistributor / Aerodrome BribeVotingReward). No invariant breakage.

---

## 2. Cross-cutting verification — receive() shapes across the three downstream contracts

The user's concern: "Verify all three downstream contracts have a `receive()` that accepts ETH AND that the H-11 prewarm (RevDist) is the only one that needed the cold-SSTORE workaround (POL + ReferralSplitter receive() should be either no-op or already cheap)."

**Receive() shapes (verified):**

| Contract | Source line | Body | Cold-first-call gas |
|---|---|---|---|
| `RevenueDistributor` | 379-382 | `unchecked { _totalETHReceivedRaw += msg.value; } emit ETHReceived;` | ~22.1k zero→non-zero SSTORE *averted by H-11 prewarm to 1 in constructor* (line 338-364); first POST-prewarm call is ~5k |
| `POLAccumulator` | 308-318 | `totalETHReceived += msg.value; emit ETHReceived;` | ~22.1k cold zero→non-zero SSTORE on first ingress, ~5k thereafter |
| `ReferralSplitter` | 227 | `{}` empty | ~2.3k (CALL dispatch only) |

**SwapFeeRouter's outbound stipends to those receivers:**
- `distributeFeesToStakers()` at lines 1334, 1348: `revenueDistributor.call{value, gas: 50_000}` and `polAccumulator.call{value, gas: 50_000}` — 50k stipend amply covers cold-SSTORE (22.1k) + LOG2 (~1.7k) + dispatch (~3k) on EITHER receiver.
- Treasury / pending-distribution paths use `WETHFallbackLib.safeTransferETHOrWrap` at lines 1364, 1427, 1763. The lib's stipend is `ETH_TRANSFER_GAS_STIPEND = 30_000` (lib line 57) — explicitly bumped from 10k to 30k for exactly this cold-SSTORE concern (lib doc lines 38-57 cite "RevenueDistributor / SwapFeeRouter / POLAccumulator receive()" as the motivating sites).

**Verdict on the user's framing:**
- ✓ All three downstream contracts have a `receive()` that accepts ETH.
- ✓ H-11's prewarm is on RevDist specifically because RevDist gets pushed via the WETHFallbackLib path under SOME flows where 30k still wasn't comfortable enough for cold-SSTORE + LOG2 + future EIP creep — the prewarm is belt-and-braces on the most ETH-receiving contract in the system.
- ✓ POL's `receive()` is gas-cheap enough (single SSTORE + event) to fit comfortably under both the 30k WETHFallbackLib stipend AND the 50k direct stipend in `distributeFeesToStakers`.
- ✓ ReferralSplitter's `receive()` is bare empty — no SSTORE. Even a 2.3k stipend would suffice. (In practice, ReferralSplitter does NOT receive ETH via its bare `receive()` from any in-protocol path; all ETH ingress is via `recordFee(_user) payable` which is its own gas-bound path.)

**No exploit.** The user's mental model is correct: the H-11 prewarm is RevDist-specific; POL gets by on the 50k direct stipend or 30k lib stipend; ReferralSplitter's bare `receive()` is too cheap to need workarounds.

---

## 3. Storage layout verification

**Storage layouts read from `.audit_2026_freshlook/storage_layout/{SwapFeeRouter,SwapFeeRouterAdmin,POLAccumulator,ReferralSplitter}.txt`. All four match the on-disk source code:**

### SwapFeeRouter (30 slots, 0-29)
- Slot 0-2: OwnableNoRenounce (`_owner`, `_pendingOwner`, `ownershipTransferExpiresAt`)
- Slot 3: `_paused` (1 byte) packed with `swapFeeRouterAdmin` (20 bytes) — packing OK (21 bytes, leaves 11 free).
- Slot 4-29: contract-specific state, ending at `totalETHReceived` (slot 29).
- No gaps, no uninitialized slot leaks.
- The `_paused`/`swapFeeRouterAdmin` packing is intentional and stable.

### SwapFeeRouterAdmin (16 slots, 0-15)
- Slot 0-2: OwnableNoRenounce.
- Slot 3: `_executeAfter` mapping (TimelockAdmin).
- Slot 4-15: pending-state slots for the timelocked parameter changes.
- All slots are full-width — no packing.

### POLAccumulator (21 slots, 0-20)
- Slot 0-3: OwnableNoRenounce + Pausable's `_paused` (slot 3, 1 byte but no neighbour packs in this layout).
- Slot 4: `_executeAfter` mapping (TimelockAdmin).
- Slot 5-20: contract-specific state, ending at `pendingSweepToken` (slot 20).
- Slot 14 = `totalETHReceived` matches the `receive()`-bumped counter at line 181.

### ReferralSplitter (27 slots, 0-26)
- Slot 0-2: OwnableNoRenounce.
- Slot 3: `_executeAfter` mapping.
- Slot 4-26: contract-specific state, ending at `pendingCallerGrant` mapping (slot 26).
- Slot 21 = `setupComplete` (1 byte, in its own slot — could pack with neighbours, but isolation costs 0 once written).

**No layout drift. No upgrade-pattern concerns** — these contracts are constructor-deployed standalone (no UUPS / proxy / Initializable). Storage layout is a one-shot frozen contract at deploy.

---

## 4. Summary

| User Concern | As-shipped State | Verdict |
|---|---|---|
| M-5 — WETH path bypasses staker share | Accepted-as-design; only path to drain is `withdrawTokenFees(WETH)` which is `onlyOwner` + 48h treasury rotation timelock. | **No new on-chain exploit.** Documented operator concern only. |
| M-6 — `withdrawTokenFees` drain | Accepted-as-design; same `onlyOwner` + 48h timelock posture. There is NO propose/execute apply-path here — the function is direct-fire admin. | **No "gate-at-apply-path" question to answer; gate doesn't exist in current code, by design.** |
| M-39 — POL harvest price-impact | `_twapHarvestMinOut` uses Alpha-Homora-V2 / RAI fair-LP-price (K-invariant + TWAP), 50bps safety + 50bps spot-deviation gate. | **JUSTIFIED — canonical TWAP-min-out anchor is in place.** |
| F-25-K-* ReferralSplitter `receive()` | Bare empty `{}`; donated ETH routes through `sweepUnclaimable` reservation. No accounting touch. | **JUSTIFIED — protocol invariants conserved.** |
| Receive() across three contracts + H-11 prewarm | RevDist has H-11 prewarm; POL has cheap SSTORE-only receive (50k stipend amply sufficient); ReferralSplitter is no-op. | **All correct per user's framing.** |
| Storage layouts | All four match the on-disk source; no drift, no leaks. | **JUSTIFIED.** |

**Bottom line:** the codebase as it actually ships under the minimal-surface mandate has NO new on-chain exploits in the four contracts of scope. The two accepted-as-design items (M-5 / M-6) are correctly bounded by the 48h treasury rotation timelock and require operator/governance discipline (which POST_MANDATE_STATE.md documents). The Wave-B fixes that the prior `agent_review_SwapFeeRouter.md` was reviewing are NOT in the deploy path — they were reverted in `e441133` because the meta-review judged the added complexity to itself BE the exploit surface. That decision is consistent with the mandate.

**Outstanding recommendation:** the prior `fix_review/agent_review_SwapFeeRouter.md` reviews code that is no longer in scope. If a future audit cycle revisits the same surface, that file should be replaced (or moved to `archive/`) to avoid re-confusing future reviewers about the as-shipped state.
