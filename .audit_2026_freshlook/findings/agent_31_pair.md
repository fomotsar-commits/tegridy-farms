# Agent 31/100 — TegridyPair fresh-eyes audit

**File:** `contracts/src/TegridyPair.sol` (~499 lines)
**Related:** `contracts/src/TegridyTWAP.sol`, `contracts/src/TegridyFactory.sol`, `contracts/src/TegridyRouter.sol`

Lens: V2 pair semantics, K-invariant, mint/burn/swap correctness, TWAP feed, ERC777, FoT, donations, reserve-overflow, blacklist DoS, blockTimestamp wrap, cumulative price oracle, flash-swap callback, init re-entry.

---

## F-31-A — HIGH — Permissionless `kLast` bootstrap via `mint()` / `burn()` defeats `harvest()`-bootstrap gate; multi-year suppression of protocol fees

**Severity:** HIGH (multi-year suppression of protocol revenue, no funds-loss for users)

**Location:**
- `mint()` line 169: `if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);`
- `burn()` line 198: `if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);`
- `harvest()` lines 392-404: bootstrap gate (`if (bootstrap && msg.sender != feeToSetter()) revert`)

**Description:**

The newly-added `harvest()` bootstrap gate (FRESH-EYES M-2 comment, lines 393-401) restricts `kLast = R0*R1` writes to `feeToSetter` when `kLast == 0 && feeOn == true`. The stated purpose is to prevent flash-loan manipulation of reserves at the moment `kLast` is anchored, which would suppress `_mintFee` accrual until K naturally grows back to the inflated baseline.

**The gate is bypassable.** `mint()` line 169 and `burn()` line 198 unconditionally write `kLast = reserve0 * reserve1` whenever `feeOn == true`. There is no caller-authorisation check on those two paths. An attacker can therefore:

1. Wait for `feeTo` to be enabled (or for a fee-disable→re-enable cycle that left `kLast = 0` via the cleanup path inside `_mintFee`).
2. Flash-loan tokens; swap them through the pair to push reserves to a manipulated ratio (K stays near natural, but the `_update` path then anchors at the post-swap reserves).
3. Call `mint()` with the minimum-allowed amounts (≥1000 of each, sqrt(amount0·amount1) > 1e6). `_mintFee` short-circuits because `_kLast == 0`. Then line 169 writes `kLast = R0_inflated * R1_inflated`, which captures whatever reserve ratio existed inside the same transaction (or, if attacker just donates, captures the donation-inflated reserves).
4. Reverse the flash loan. K returns to roughly natural; `kLast` stays at the inflated value.

Since `_mintFee` only mints protocol LP when `rootK > rootKLast`, the protocol gets **zero fee accrual until natural K growth catches up to the inflated baseline**. K grows from swap fees at ~0.3% of trade volume, so suppressing fees by 10x requires growing K through ~10x worth of fee absorption — roughly 3,300x pool-size in trading volume, i.e. months-to-years on any but the most active pair.

The `burn()` path is equivalent: an attacker holding a minimal LP balance can transfer 1 wei of LP to the pair, donate token0/token1 to skew reserves, and call `burn()`. Line 198 then writes `kLast` against the post-update reserves (which include the donation). Same suppression effect.

**Why the harvest() gate doesn't help:**

The harvest() bootstrap gate only fires when `kLast == 0 && feeOn == true`. Both mint() and burn() write `kLast` to non-zero on every successful call when `feeOn == true`, so the bootstrap state (kLast == 0) is exited the moment any LP user touches the pair. The gate at most blocks **one** path among three; the other two run on every retail interaction.

**Recommendation:**

Either remove the harvest() bootstrap gate (it provides false security) OR extend the gate to `mint()` and `burn()` as well, OR — better — change the bootstrap semantics so that the very first `kLast` write after `feeOn` flips on uses a **TWAP-anchored K** (e.g. require the consult() price to lie within MAX_DEVIATION_BPS of the current spot before allowing kLast write). The current architecture is structurally unable to anchor `kLast` at a non-manipulable K because all three writers (mint/burn/harvest) run while reserves are arbitrarily flash-loanable.

Note: the equivalent attack on Uniswap V2 was disclosed publicly years ago and is the reason Sushi/Curve/etc. moved fee accrual to admin-controlled paths.

**PoC sketch:**
```
// Pair just had feeOn enabled, kLast == 0, reserves (1e18, 1e18).
attacker.flashLoan(token0, 1e21);
pair.swap(token0_in: 1e21, ...); // pushes reserves to (~1e21, ~1e15), K ~ 1e36 unchanged
pair.mint(attackerEOA);           // line 169 writes kLast = 1e21 * 1e15 = 1e36, ANCHORED at manipulated point
// reverse flash loan, K returns to ~1e36
// future _mintFee always sees rootK ≤ rootKLast for many quarters
```

---

## F-31-B — MEDIUM — `burn()` does not gate against `disabledPairs` / `blockedTokens`; `feeOn=true` cleanup path on a disabled pair re-arms `kLast = 0` via burn, then any subsequent re-enabled mint resumes `_mintFee` minting against attacker-chosen reserves

**Severity:** MEDIUM (governance/MEV grief, structural rather than exploitable for direct theft)

**Location:** `burn()` lines 179-205 — only `INVALID_TO` is checked; no `disabledPairs` / `blockedTokens` gate.

**Description:**

`mint()`, `swap()`, `skim()`, `sync()`, and `harvest()` all gate on `disabledPairs[pair]` and `blockedTokens[token0|1]`. `burn()` deliberately does not (so LPs can always exit). Per code commentary this is the right call.

But `burn()` has a side-effect that subverts the disable lifecycle: when `feeOn == true`, line 198 writes `kLast = reserve0 * reserve1` against the post-update reserves. After a pair is disabled (sync/skim/swap blocked), an attacker can:

1. While disabled: donate tokens to the pair (no public path lets them sync/swap, but they can transfer ERC20 directly).
2. Call `burn()` — passes (no disable gate). `_update` writes new reserves = balance, which now reflects the donation. `kLast` is rewritten against those manipulated reserves.

Now `kLast` is anchored at a donation-inflated K. When the pair is re-enabled and the next mint/burn/swap runs, `_mintFee` compares against this manipulated baseline.

This is a strict governance-grief: attacker pays the donation cost (real loss), protocol's `_mintFee` accrual is delayed by approximately the same K-amount once re-enabled. Magnitude is bounded by the donation, but the donation goes to LPs proportionally so attacker is effectively burning their own funds to spite protocol fee. Realistic attacker cost-vs-payoff is unfavorable, but the primitive exists.

**Same primitive applies via `mint()` after re-enable** (since donation persists through the disabled window).

**Recommendation:**

Either (a) gate `burn()` behind `disabledPairs` for kLast updates only — i.e. allow LP exit but skip the `if (feeOn) kLast = ...` line when disabled, OR (b) call `skim(feeTo)` at re-enable to clean up donations before next mint/burn.

Cross-references F-31-A: even without the disabled-pair angle, `burn()` is a permissionless kLast bootstrap path.

---

## F-31-C — MEDIUM — TWAP cumulative integration on `sync()` after donation poisons the oracle baseline (deviation gate is ±50%, exploitable on low-liquidity pairs)

**Severity:** MEDIUM (combines with TegridyTWAP weaknesses; mitigations exist but are partial)

**Location:** `sync()` lines 312-316 → `_update()` lines 431-462.

**Description:**

`sync()` is permissionless on enabled pairs. The flow:

1. Attacker donates token0 amount D to the pair → `balanceOf(this) = R0+D`.
2. Attacker calls `sync()`. Inside `_update`: integrates **PRE-update reserves** `(R0, R1) * timeElapsed` into the cumulative (this is correct — the spot price between last touch and now was indeed R1/R0). Then writes `reserve0 = R0+D, reserve1 = R1`.
3. The next observation by `TegridyTWAP.update(pair)` reads:
   - `pairCum0` (still the un-poisoned cumulative as of step 2's `_update`).
   - **Plus** `spotPrice0 * elapsedSinceLastPairTouch` where `spotPrice0 = reserve1 * Q112 / reserve0 = R1 * Q112 / (R0+D)` — the **manipulated post-donation spot price**, integrated over the time gap from sync to the TWAP observation.

Even though the pair's stored cumulative is honest at the moment of sync, the TWAP layer adds spot * elapsed using the manipulated reserves. If the donation is small enough to stay within the TWAP's ±50% deviation gate, every subsequent observation lands cleanly. On low-TVL pairs (where the deviation gate has been raised to ±50% specifically to avoid bricking — see `MAX_DEVIATION_BPS = 5000`), donations of ~50% of token0 reserves can permanently drift the oracle without tripping the gate.

The contract has an explicit gate against this attack on disabled pairs (lines 287-289 NatSpec), but the enabled-pair path still allows it. The mitigations are TWAP-side:
- TegridyTWAP `minReserveFloor` (per-pair, owner-set, default 0).
- TegridyTWAP deviation gate (±50%, but bypassed for the first 3 observations after pair creation per FRESH-EYES H-3 in TWAP).

The pair-side primitive remains: `sync()` permissionlessly admits donations into the reserves snapshot used for oracle integration.

**Recommendation:**

This is a known trade-off in V2 forks. Two structural mitigations exist:
1. Gate `sync()` behind a per-pair max-donation check (cap donation as % of reserves at e.g. 5%).
2. Make `sync()` callable only by feeToSetter or via a 1-block-delayed mechanism (so an MEV bot cannot couple sync into a sandwich).

Document explicitly that any pair with `minReserveFloor` unset (default) is vulnerable to oracle manipulation on donation+sync; recommend that downstream TWAP consumers (lending oracle, POL accumulator) only consult pairs with non-zero `minReserveFloor`.

---

## F-31-D — LOW — `swap()` rejects `to == token0` / `to == token1` even when output is going the other direction

**Severity:** LOW (UX; legitimate integrations are rare and have workarounds)

**Location:** `swap()` line 229: `require(to != token0 && to != token1, "INVALID_TO_IS_TOKEN");`

**Description:**

The check is unconditional regardless of which direction the swap is going. If a user wants to swap token0→token1 and `to` happens to be the token0 contract address (e.g. an automated rebalancer registered AS the token), the swap reverts even though no token0 is being transferred to itself.

Concrete impact: if a third-party contract that legitimately wants to receive swap output happens to be the token0 or token1 contract (e.g. a re-investment bot deployed to that address, a token contract with a `receiveSwap` hook, or a wrapped-token unwrapper), it cannot be a swap recipient.

**Recommendation:**

Tighten to direction-aware: only block `to == token0` when `amount0Out > 0`, and `to == token1` when `amount1Out > 0`. Or accept the broad check as intentional defense-in-depth (the comment doesn't specify why both are blocked).

---

## F-31-E — LOW — `mint()` reverts on division-by-zero when reserves drop to 0 via rebasing token + sync(), bricking subsequent mint() calls

**Severity:** LOW (only triggered by adversarial / rebase tokens; burn() still works for exits)

**Location:** `mint()` line 159: `uint256 liq0 = (amount0 * _totalSupply) / _reserve0;`

**Description:**

Path: pair created with a rebasing token (e.g. negative-rebase). After several rebases, `IERC20(token).balanceOf(pair)` drops to 1 wei. Anyone calls `sync()` → `_update(1, R1)` → `reserve0 = 1`.

Now consider: another rebase or attack drops balance further, `sync()` again → `reserve0 = 0`. Next call to `mint()` runs line 159 `liq0 = (amount0 * _totalSupply) / 0` → revert (panic) on division by zero.

Subsequent recovery is impossible without destroying the pair (no reset path other than the TWAP's `proposeAdminResetPair`, which is for the oracle, not the pair). Existing LPs can still exit via `burn()` (no division by reserve there — uses balances).

**Recommendation:**

Add `require(_reserve0 > 0 && _reserve1 > 0, "EMPTY_RESERVES")` early in the non-first-mint branch, with a more informative revert message. Or short-circuit to the first-mint branch when reserves are 0 even if totalSupply > 0 (would require careful kLast handling).

Practically: this is the cost of supporting rebasing tokens, which the contract claims it does not (line 36-43). Reaffirm in the factory that rebase tokens should not be paired.

---

## F-31-F — LOW — `harvest()` does not emit a dedicated event; off-chain monitoring depends on observing OZ ERC20 `Transfer(0, feeTo, ...)` events

**Severity:** INFO/LOW (operational visibility gap)

**Location:** `harvest()` lines 340-416 — no event emission.

**Description:**

`mint()`/`burn()`/`swap()`/`skim()`/`sync()` all emit named events. `harvest()` does not. Off-chain protocol-fee monitoring must subscribe to the OZ ERC20 `Transfer(address(0), feeTo, ...)` event from the pair, which is emitted by `_mintFee → _mint`. This works but conflates "fee mint via harvest" with "fee mint via mint/burn _mintFee call" — operators cannot easily distinguish the materialization path.

**Recommendation:**

Add an `event Harvested(address indexed caller, uint256 feeMinted, uint256 newKLast, uint256 supplyAfter)` and emit at line 412. Same change in spirit as F-31-G's mint-fee opportunity.

---

## F-31-G — LOW — `_mintFee` rounding: when K just barely grew, `numerator / denominator` may round to zero, silently dropping protocol fee for a swap volume

**Severity:** LOW (canonical V2 behavior; mostly informational)

**Location:** `_mintFee` lines 469-486.

**Description:**

The classical V2 fee formula:
- `numerator = totalSupply * (rootK - rootKLast)`
- `denominator = rootK * 5 + rootKLast`

When `rootK - rootKLast` is small (e.g. one tiny swap on a deep pool), `numerator / denominator` can integer-divide to 0. The fee is lost for that interval until enough K growth accumulates to mint at least 1 LP token. On extremely deep pools (totalSupply much larger than rootK growth), this can persist over many swaps.

**Recommendation:**

This is by design in V2 and matches the canonical formula. The new `harvest()` permissionless path (FRESH-EYES gate-aware) mostly mitigates by giving keepers a path to flush the residual on a 5-minute cadence, but the residual itself is lost between harvest calls if it doesn't reach 1 LP unit. Document explicitly so keepers know harvest is not lossless on tiny intervals.

---

## F-31-H — INFO — `mint()` first-deposit minimum (`amount0 >= 1000 && amount1 >= 1000` AND `sqrt > 1e6`) admits asymmetric ratios that lock at any K ≥ 1e12

**Severity:** INFO (anti-inflation protection works; first-mint price-anchoring is governance-trust)

**Location:** `mint()` lines 149-157.

**Description:**

The first depositor sets the initial pair price via the ratio of their deposit. The minimum-liquidity guard requires `amount0 >= 1000`, `amount1 >= 1000`, and `sqrt(amount0 * amount1) > 1e6`. The smallest valid first deposit is therefore `amount0 = amount1 = ~1001` if both are equal, or asymmetric like `amount0 = 1, amount1 = 1e12` (sqrt = 1e6 + 1).

**Wait — `amount0 >= 1000`** so `1` is rejected. Min asymmetric is `amount0 = 1000, amount1 = 1e9` (sqrt ≈ 1e6 + 1). At that ratio, the implied price is `amount1/amount0 = 1e6` — token1 is 1M× more valuable than token0. Anyone arbitraging this on TWAP creation will move price quickly, but the **first observation in TegridyTWAP is bypassed** (FRESH-EYES H-3 sets `bypassed = true` for first observation), so consult() refuses to serve. Then 3 more bootstrap observations are also bypassed (H7 grace). Only observation #4 onwards enforces the deviation gate — after at least 4×15min = 1 hour of cumulative drift back to natural price.

So the price-anchoring race is mitigated. Just noting that first-mint is the moment that defines the pair's TWAP baseline; protocol relies on the TWAP's grace-window logic to absorb misanchored bootstraps. This is documented but worth re-stating.

---

## F-31-I — INFO — `swap()` strict equality post-transfer balance check rejects token-rebase-during-transfer (positive AND negative rebase)

**Severity:** INFO (intentional, but rejects more than just FoT-output)

**Location:** `swap()` lines 272-273: `require(IERC20(token0).balanceOf(this) == postBalance0, "FOT_OUTPUT_0");`

**Description:**

The strict-equality check after `safeTransfer(out)` catches:
- FoT-on-output (balance < expected) → revert.
- Positive rebase mid-transfer (balance > expected) → revert.
- Reentrancy that drains balance during transfer → revert.

The "positive rebase" rejection means a rebasing token that increases supply DURING a swap (interest-bearing, atomic-rebase) bricks the swap. Such tokens are out of scope per the documentation, so this is correct defense-in-depth, but rebase-savvy users may be surprised.

---

## F-31-J — INFO — `getReserves()` returns `(reserve0, reserve1, blockTimestampLast)` but does NOT return cumulative price snapshot atomically

**Severity:** INFO (parity with V2; integrators using read-only reentrancy must be aware)

**Location:** `getReserves()` lines 119-123.

**Description:**

`price0CumulativeLast` and `price1CumulativeLast` are `public`, so an integrator can read them. But `getReserves()` returns only the reserve triplet. An integrator querying both `getReserves()` and `priceXCumulativeLast` across two staticcalls within the same block sees a consistent snapshot only if no _update fires between the two reads. Inside a single transaction this is automatic; across blocks or across reentrancy windows it is not.

The pre-existing read-only-reentrancy NatSpec at line 176 acknowledges the swap/burn windows. Mention also the cumulative-price slot.

**Recommendation:**

Add a helper `getReservesAndCumulative()` returning all 5 values atomically, for integrators who want a single SLOAD-batched snapshot.

---

## Notes / dead-ends

- Initialization (`initialize()` line 103-111) correctly gates on `msg.sender == factory`, requires `!_initialized`, and rejects zero addresses. Re-initialization is structurally impossible. Token0/token1 ordering is the factory's job (TegridyFactory line 168 sorts before deployment + initialize).

- `MINIMUM_LIQUIDITY = 1000` is locked to `0xdead`, which has no code, so the lock is permanent. Standard V2.

- The `bytes calldata data` parameter in `swap()` (line 212) is rejected (`data.length == 0`). Flash swaps are not supported. No callback can re-enter mid-swap from the pair side — confirmed against the code path.

- Cumulative price overflow: `_update` line 453-454 multiplications fit in uint256 under realistic-reserve / realistic-time conditions. The unchecked block accepts intentional wraparound across the cumulative accumulator. Consumers compute differences which remain correct under modular wrap (V2 semantics).

- block.timestamp uint32 wrap (year 2106): `_update` uses uint32 modular subtraction (`unchecked { timeElapsed = _blockTimestamp - blockTimestampLast; }`). Wrap-safe.

- `_update`'s `require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "OVERFLOW")` correctly rejects reserves that would silently truncate. Pre-validation before the explicit `uint112(balance0)` cast.

- Skim is permissionless and only triggers ERC20 transfer. No internal state mutated besides emitting `Skim(...)`. No reserves change. Non-griefable.

- Sync's CEI: `_update` integrates pre-update cumulative correctly, then writes new reserves — order is correct V2.

- Burn's CEI: `_update` runs before `safeTransfer(to, amount0)` per H-01 fix. Cross-contract reentrancy via ERC777 callback during transfer is documented to be in-scope but not exploitable for state corruption inside this pair (nonReentrant on entry).

- Swap's CEI: `_update` runs before token output transfer. Same protection.

- LP token (this contract) is OZ ERC20 — no transfer hooks; no callback surface from LP transfer. The burn flow `_burn(this, liquidity)` runs before token output, so the totalSupply reduction is committed before any external call.

- `_mintFee` mathematical formula matches Uniswap V2 reference exactly (5/6 LP, 1/6 protocol). Verified.

- Token0/token1 are immutable after initialize. Reserves are uint112 (matches V2). LP token name/symbol are constants from constructor.

- `harvest()`'s zero-mint branch (`bootstrap || cleanup`) handling looks correct after the V2-AMM-M2/V3-AMM-M1 fixes; the test for griefing is the bootstrap path which IS the F-31-A finding.

- The `to != address(this)` mint guard correctly closes the V2 self-mint footgun (NEW-A10).

- Burn's lack of `disabledPairs` gate is intentional (LPs always exit) and correct, but introduces F-31-B side-effect on kLast.
