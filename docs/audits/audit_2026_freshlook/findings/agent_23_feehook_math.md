# Agent 23 — TegridyFeeHook Fresh-Eyes Audit

**File:** `contracts/src/TegridyFeeHook.sol` (~849 lines)
**Lens:** Dynamic fee math, fee accumulator, owner-stranded redeploy concerns, fee distribution.
**Approach:** Read-only line-by-line; cross-checked against canonical V4 `FeeTakingHook` reference and supporting libs (`TimelockAdmin`, `OwnableNoRenounce`, `WETHFallbackLib`).

The hook is NOT a dynamic-fee hook in the classical sense. `feeBps` is a single global constant per contract, gated by 24h timelock; there is no volatility input, no per-pool struct, and no big-trade discount logic. Many lens questions therefore have negative findings (worth recording for future-eyes; section 4).

---

## Findings

### F-23-1 [LOW] — `feeBps` is a *global* fee, not per-pool — fee changes cannot favour/disfavour a single pool

**Location:** `feeBps` (line 65) read directly inside `afterSwap` (line 389).

**Observation:** Despite the per-pool `approvedPools` allowlist, fee math reads a single `feeBps` slot for ALL approved PoolKeys. There is no `mapping(bytes32 => uint16) feeBpsByPool`.

**Implication:**
- A 100bp (1%) cap is sane and uniform. No per-pool collision is possible because there is only one slot.
- BUT: if Tegriddy ever lists a stable-pair (USDC↔DAI) and a volatile pair (TOWELI↔WETH) on the same hook, both pay the same fee. This is a product limitation rather than a security bug.
- Mid-block fee-change manipulation is bounded by 24h timelock, but the timelock starts when the proposal is *plotted*, and `executeFeeChange` can fire any time within `PROPOSAL_VALIDITY` (7 days) after the delay. An owner could rush execution at a known-pumping moment to retroactively raise fees on the next swap. This is an inherent risk with global fee config; severity is gated by the captured-owner threat model the protocol already accepts.

**Severity:** Informational — design choice, not a vulnerability.

---

### F-23-2 [LOW] — Fee discount on dust amounts: `feeBps > 0` swaps with `absAmount == 1` pay zero fee

**Location:** Lines 394–400.

```solidity
if (feeUint == 0 && feeBps > 0 && absAmount > 1) {
    feeUint = 1;
}
if (feeUint == 0) {
    return (IHooks.afterSwap.selector, int128(0));
}
```

**Observation:** When `absAmount == 1` (1 wei of unspecified token), `feeUint` falls through both branches as 0. The swap completes free.

**Exploit feasibility:** Effectively zero. To extract value you would need to spam 1-wei swaps that each move enough liquidity to be worth the gas (e.g. ~$0.50 mainnet) — but a 1-wei delta moves the price by infinitesimally less than rounding, so there is no rationally-profitable spam pattern. **Note for future-eyes:** if V4 ever introduces sub-wei accounting (it won't), revisit.

**Severity:** Informational.

---

### F-23-3 [LOW] — `feeBps` is bounded statically (≤100bp) but check is in *constructor* and *propose* — no runtime invariant

**Location:** Constructor line 213; `proposeFeeChange` line 740.

**Observation:** Both setters validate `_feeBps <= MAX_FEE_BPS` at write-time. There is no read-time clamp in `afterSwap`. If a future upgrade ever adds another `feeBps` writer (e.g. governance-routed setter, automation hook), and that path forgets the cap, the runtime would happily multiply by an out-of-bounds value.

**Mitigation present:** No active vector today. The contract is non-upgradeable, has no setter besides timelock, and `setFee()` is a hard-revert. Severity stays informational.

**Recommendation:** Defense-in-depth — add `if (feeBps > MAX_FEE_BPS) feeBps = MAX_FEE_BPS;` in `afterSwap` or replace `feeUint = (absAmount * feeBps) / 10000;` with `(absAmount * Math.min(feeBps, MAX_FEE_BPS)) / 10000;` to neutralise any future writer-path mistake. Cost is one SLOAD-already-cached comparison.

---

### F-23-4 [INFO] — `accruedFees[address(0)]` exists for native-ETH pools but the V4 PoolManager allowlist makes the path narrow

**Location:** Lines 514–516 (claimFees address(0) branch).

**Observation:** The `claimFees` dispatch handles `address(0)` (native ETH) → forward via WETHFallbackLib. This is the *correct* design under V4's native-ETH semantics (`Currency.unwrap(NATIVE) == address(0)`). However, the comment claims "we never wrapped" — meaning the assumption is `poolManager.take(ADDRESS_ZERO, hook, fee)` deposits native ETH into the hook contract directly via `receive()`.

**Verification:** V4 `PoolManager.take` with `Currency.NATIVE` does send raw ETH. The hook's `receive() external payable {}` (line 848) will accept it. The path is correct.

**Side-effect to track:** `convertERC20FeesToETH` *rejects* `currency == address(0)` (line 562 — `if (currency == address(0) ...) revert ZeroAddress();`). Symmetric and correct, but means the only native-ETH disposal path is `claimFees`. If `claimFees` is ever DOS'd by an indefinitely-pending sync proposal (see F-23-5), `accruedFees[address(0)]` is stranded.

**Severity:** Informational — no current exploit, but flag for future audit.

---

### F-23-5 [LOW→MED] — `claimFees` SYNC_PENDING gate can be perpetually re-armed by a captured-owner key

**Location:** Lines 491–497.

```solidity
bytes32 syncKey = keccak256(abi.encodePacked(SYNC_CHANGE, currency));
uint256 readyAt = _proposalReadyAt(syncKey);
require(
    readyAt == 0 || block.timestamp > readyAt + _proposalValidity(),
    "SYNC_PENDING"
);
```

**Observation:** The fix V2-AMM-M1 (auto-expire) is correctly implemented — once the proposal validity window has lapsed, claims go through. BUT a captured owner can:

1. Call `proposeSyncAccruedFees(WETH, X)` — sets `_executeAfter[syncKey] = now + 24h`.
2. Wait until `now + 24h + 7 days` (validity expiration).
3. *Just before* expiry, call `cancelSyncAccruedFees(WETH)`.
4. Immediately re-propose. Returns to step 1.

This permanently DOSs `claimFees(WETH, X)` on a 7-day rolling cycle. The fix V3-AMM-M2 (`expireSyncAccruedFees`) is *permissionless cleanup* but only fires AFTER expiry, which the malicious owner avoids by cancelling early.

**Active gating:** `cancelSyncAccruedFees` is `onlyOwner`. So the malicious owner is the only actor who can re-arm. If `claimFees` is the only path to drain `accruedFees[WETH]`, a captured owner can permanently freeze fee disbursement to RevenueDistributor.

**Counter-defense:** `claimFees` is permissionless. A KEEPER can race to call it during the 7-day grace window between cancel-and-re-propose. But the same owner can chain `cancel → propose` atomically in one block — leaving zero gap.

**Recommendation:** Add a per-currency cooldown on `proposeSyncAccruedFees` (24h since last *any* state change for that currency, not just executed sync). Or expose a guardian/executor who can claim during a pending sync if `accruedFees[currency]` exceeds a safety threshold. Severity becomes Medium if RevenueDistributor depends on uninterrupted flow.

---

### F-23-6 [INFO] — `convertERC20FeesToETH` decrements `accruedFees` from on-hand balance, not by the swap-input amount — internal accounting drifts

**Location:** Lines 588–595.

```solidity
uint256 amount = IERC20(currency).balanceOf(address(this));
if (amount == 0) revert NothingToConvert();
uint256 accrued = accruedFees[currency];
accruedFees[currency] = amount > accrued ? 0 : accrued - amount;
```

**Observation:** The function debits `accruedFees[currency]` by the on-hand balance (or zeros it if balance > recorded). This is correct in the happy path, but consider:

- The hook receives an unsolicited transfer of `currency` (e.g. dusting attack, or a bystander sending tokens directly). `balanceOf(this) > accruedFees[currency]`. The function zeroes `accruedFees[currency]` and swaps the entire balance to ETH. **The donor's tokens are converted to RevenueDistributor revenue.** Probably the desired behaviour (free yield), but worth noting.
- The hook holds `accruedFees[currency] = 1000` but only `balanceOf(this) = 100` (because earlier `claimFees` should not have zeroed but legacy bug left a shortfall — or the PoolManager `take` was rolled back atomically, leaving `accruedFees` lying). After `convertERC20FeesToETH`, `accruedFees[currency] = 900`. The 900 is now **uncoverable** by on-chain assets — only fixable via `proposeSyncAccruedFees` (24h timelock, capped at 10%/step).

**Severity:** Informational — current invariants hold, but the desync recovery path is slow.

---

### F-23-7 [LOW] — `MAX_SYNC_INCREASE_BPS = 1000` (10%) cap allows cumulative inflation over time

**Location:** Lines 178, 677–681.

**Observation:** Each upward sync is capped at 10% of prior `accruedFees[currency]`. With 7-day cooldown and 24h timelock, this means worst-case attacker pace is one 10% bump every 8 days.

Math: starting from `accruedFees = 1`, doubling requires `1.1^n = 2 → n = 7.27`, so ~58 days to double, ~1 year to inflate ~14×.

This is `O(slow)` and bounded by `pendingSyncCreditSnapshot` (the on-chain PoolManager credit at propose time). HOWEVER: the hook never *decreases* `pendingSyncCreditSnapshot` — it is captured once per propose. If a captured owner times the propose right after a large fee accrual event, the snapshot can be much larger than the executed value. Subsequent proposes can ratchet up.

**Mitigated by:** the `actualCredit > onChainCreditSnapshot` revert (line 672) caps at the snapshot. But the snapshot itself can be inflated arbitrarily by an owner who waits for fee accrual then proposes.

**Severity:** Informational — known design choice (R014), documented as "economically infeasible". Audit lens confirms it's not abusable in a single tx.

---

### F-23-8 [INFO] — Hook flag enforcement uses `& 0x3FFF == 0x0044`

**Location:** Line 223.

**Observation:** `require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");`

This requires *exactly* `afterSwap (0x0040) | afterSwapReturnsDelta (0x0004)` and rejects any other flag bit being set. The 0x3FFF mask covers V4's current 14 flag bits. The constructor comment correctly notes the future-fragility if V4 ever adds bits 14+.

**Salt-mining concern:** The hook deployer must mine a CREATE2 salt that produces an address satisfying `addr & 0x3FFF == 0x0044`. ~1 in 16384 salts qualify. This is trivial. **Could an attacker front-run the deploy?**

- Deploy is via Arachnid CREATE2 proxy, which is permissionless. If the salt-creator EOA broadcasts the salt + bytecode publicly (e.g. testnet first), an MEV bot could observe and front-run-deploy on mainnet using the same salt + bytecode.
- BUT: the constructor takes `_owner` as an explicit arg (line 207–209), so a front-run deploy with attacker's `_owner` would produce a different bytecode → different CREATE2 address. The deployer-controlled `_owner` is encoded in the constructor args, which become part of the deployment hash.

**Verification:** Arachnid's deployer hashes `keccak256(salt, bytecode_with_constructor_args)`. Since `_owner` is in the args, an attacker cannot reproduce the same address with a different owner. ✓

**Residual risk:** If the deployer EOA is compromised between salt-mining and CREATE2 deploy, the attacker can deploy with their own `_owner`. Standard key-management hygiene.

**Severity:** Informational. Salt-front-running is mitigated by the construct.

---

### F-23-9 [LOW] — `_owner` constructor injection avoids Arachnid-stranding, but `Ownable2Step` requires `acceptOwnership` for rotation

**Location:** Constructor line 207, OwnableNoRenounce inheritance.

**Observation:** Wave 0 redeploy correctly takes `_owner` as a constructor arg, so `msg.sender` (Arachnid proxy) is never the owner. ✓

The 2-step rotation: `transferOwnership(newOwner)` (line via OZ) sets pending; `newOwner.acceptOwnership()` finalizes. Critical to note:

- **No timelock on ownership rotation.** A captured owner can transfer to attacker EOA → attacker accepts → attacker becomes owner with full control.
- The 24h fee / 48h distributor / 24h sync / 7d sync-cooldown timelocks remain in effect — but the new owner can immediately *propose* using their fresh `_executeAfter` slots, then wait out the delay.
- The `OwnableNoRenounce` `_ownerMustBeContract()` opt-in flag defaults to `false`, so the hook does NOT require multisig owner. EOA owner is permitted.

**Severity:** Low — design follows the protocol-wide pattern (every Tegriddy contract has the same 2-step EOA-permitted ownership). Mitigation is operational (use a multisig) not structural.

---

### F-23-10 [INFO] — `sweepETH` is correctly narrowed to `revenueDistributor` only (V3-AMM-H1 fix verified)

**Location:** Lines 836–845.

The `if (to != revenueDistributor) revert InvalidSweepRecipient();` correctly removes the captured-owner-self-drain vector. Audit confirms the fix is in place.

**Edge:** If `revenueDistributor` is rotated via 48h timelock to a malicious address, the captured owner can sweep there. But that requires both: capturing the owner key AND surviving 48h without distributor-rotation cancellation. Trust model holds.

**Verification only:** Fix is correct. No new finding.

---

### F-23-11 [LOW] — `convertERC20FeesToETH` `forceApprove(router, 0)` after the swap is best-effort, but doesn't catch a malicious router that re-took allowance during the swap

**Location:** Lines 598–609.

```solidity
IERC20(currency).forceApprove(router, amount);
...
ITegridyFeeHookV2Router(router).swapExactTokensForETH(...);
...
IERC20(currency).forceApprove(router, 0);
```

**Observation:** The owner-supplied `router` could be a malicious contract that:
1. During `swapExactTokensForETH`, re-enters the hook and... does what? `convertERC20FeesToETH` is `nonReentrant`, so re-entry to the same function reverts. `claimFees` is also `nonReentrant`. ✓
2. After the swap, retains its `amount` allowance — until the post-swap `forceApprove(router, 0)` zeros it.
3. The `forceApprove(0)` is OUTSIDE a reentrancy boundary, so a router that "delays" pulling the allowance until later (via a separate tx) can drain `accruedFees[currency]` post-conversion if the hook accumulated MORE of `currency` in the meantime.

**But:** `accruedFees` was already debited by `amount` BEFORE the swap. If new fees accrue after the swap, they sit in `accruedFees[currency]`. The router's lingering allowance lets it pull them via a `transferFrom(hook, router, X)` — but this drains the hook's balance directly without updating `accruedFees`, creating a desync that would be visible via `proposeSyncAccruedFees`.

**Severity:** Low. Captured-owner trust model — owner is trusted to supply non-malicious router. The `nonReentrant` modifier and post-swap `forceApprove(0)` are correct CEI hygiene. Defense-in-depth would be to use OZ's `SafeERC20.safeIncreaseAllowance` for the exact amount (already covered by `forceApprove`).

**Recommendation:** Document the trust assumption: `router` MUST be a known-good Uniswap V2 (or compatible) deployment. Or hard-code a router allowlist via a 24h timelock.

---

### F-23-12 [INFO] — `convertERC20FeesToETH` deadline must be in `[now, now + 30 minutes]` — no manipulability concern

**Location:** Line 563.

`if (deadline < block.timestamp || deadline > block.timestamp + 30 minutes) revert DeadlineOutOfRange();`

Bounded. Cannot pass a deadline in the past (router check) or far future (sandwich-friendly). ✓ No finding.

---

### F-23-13 [INFO] — Fee snapshot vs live read for sandwich protection

**Lens:** Sandwich-bot mitigation — does `feeBps` get read at swap-time vs proposal-time?

**Observation:** `feeBps` is read fresh in every `afterSwap` (line 389). There is no snapshot. A malicious owner who chooses to *increase* the fee can mid-block exploit pending swaps. BUT:
- 24h timelock blocks instant changes.
- The `executeFeeChange` is a discrete tx, not a continuous setting. The block in which `executeFeeChange` lands is the first block with the new fee. Front-runners can detect the tx in mempool and avoid swapping until after.
- MEV-style fee-flash-griefs require the owner to time the execute precisely with a victim's swap. Possible but high friction.

**Severity:** Informational. Standard timelock-protected admin model.

---

### F-23-14 [INFO] — Fee accrual when no liquidity / when swap delta is zero

**Lens:** Does `afterSwap` mishandle empty-pool conditions?

**Observation:**
- `if (amount0 == 0 && amount1 == 0) return;` (line 343) — zero-delta swaps skip fee accrual. ✓
- `if (swapAmount == 0) return;` (line 384) — zero unspecified-side delta also skips. ✓
- `if (feeUint == 0) return;` (line 398) — final post-multiply zero check. ✓

If a swap occurs against an empty pool, V4 will revert before reaching `afterSwap`. If the pool is partially drained mid-swap and delta is asymmetric (e.g. `amount0 = 0` but `amount1 = -X`), only one side is charged. The math still holds — the hook only takes fees from the unspecified side.

**No finding.** Correctly handled.

---

### F-23-15 [INFO] — `int128` cast safety after negation

**Lens:** `if (swapAmount < 0) swapAmount = -swapAmount;` — could `swapAmount == type(int128).min` cause overflow on negation?

**Math:** `type(int128).min == -2^127`. Negation produces `+2^127`, which exceeds `type(int128).max == 2^127 - 1`. In Solidity 0.8.x checked math, this **reverts**.

**Exploit feasibility:** Requires a pool where unspecified-side delta is exactly `-2^127`. V4's pool math caps liquidity at `type(uint128).max`, and swaps cannot produce a delta exceeding the pool's liquidity. A pool with `2^127` of one token would require ~1.7e38 raw units — far beyond any plausible token supply (even with 18 decimals, that's 1.7e20 whole tokens).

**Even if achievable:** the revert happens INSIDE `afterSwap`. The PoolManager would propagate the revert and the entire swap would unwind. This bricks swaps on the affected pool but does NOT corrupt state (atomic rollback). It is a pure DoS, only triggerable by the LP funding the pool with absurd liquidity.

**Severity:** Informational. Practical immunity for any real-world token.

---

### F-23-16 [LOW] — `accruedFees` uses raw `+=` without saturation; theoretical overflow at 2^256

**Location:** Line 406.

```solidity
accruedFees[creditToken] += feeUint;
```

`feeUint` is at most `type(uint128).max` (post-cast guard at line 402). Adding to `accruedFees[token]` (uint256) overflows only after `2^256 - 2^128` accumulated swaps — practically impossible (would require ~1e57 max swaps with max-fee each).

**No finding.** Mathematical immunity.

---

### F-23-17 [INFO] — Dead-code surface: `feeChangeTime`, `distributorChangeTime`, `syncTime` view helpers

**Location:** Lines 726–729, 802–808.

These are legacy view helpers documented as "for test compat". They expose internal `_executeAfter` slots. No security implication, but they are pure overhead. Removing them would save deployment bytecode.

**Severity:** Informational. Not in scope for security audit.

---

## Summary

| ID | Severity | Title |
|---|---|---|
| F-23-1 | Informational | Global feeBps (no per-pool override) |
| F-23-2 | Informational | 1-wei swap pays zero fee |
| F-23-3 | Low (defensive) | No runtime feeBps cap clamp |
| F-23-4 | Informational | address(0) accrual narrow to claimFees only |
| F-23-5 | **Low→Med** | claimFees DOS via cancel-and-re-propose loop |
| F-23-6 | Informational | convertERC20FeesToETH consumes unsolicited token donations |
| F-23-7 | Informational | 10%/step sync inflation ratchet (slow but unbounded) |
| F-23-8 | Informational | CREATE2 salt-front-running mitigated by `_owner` ctor arg |
| F-23-9 | Low | Ownership rotation (Ownable2Step) has no timelock |
| F-23-10 | Verification | sweepETH narrowed to distributor (V3-AMM-H1 confirmed) |
| F-23-11 | Low | convertERC20FeesToETH router is owner-trusted (lingering allowance) |
| F-23-12 | Informational | deadline 30-min cap correct |
| F-23-13 | Informational | Fee read live, mitigated by 24h timelock |
| F-23-14 | Informational | Zero-delta paths handled |
| F-23-15 | Informational | int128.min negation is mathematically unreachable |
| F-23-16 | Informational | accruedFees uint256 cannot overflow practically |
| F-23-17 | Informational | Dead-code view helpers (no security impact) |

**Top recommendation:** F-23-5 — add a per-currency cooldown gating `proposeSyncAccruedFees` re-arm to prevent perpetual `claimFees` DOS by a captured owner. All other findings are informational or already-mitigated.

**Dead-end checks (clean):**
- No volatility input (no manipulable oracle).
- No sandwich vector via fee-snapshot drift (live read + 24h timelock).
- No big-trade discount logic (linear `amount * feeBps / 10000`, no curve).
- No per-pool fee struct (single `feeBps` slot).
- No fee-distribution recipient ambiguity (immutable WETH + 48h-timelocked distributor).
- No address(0)-burn vulnerability (WETHFallbackLib.safeTransferETHOrWrap fail-closes on zero recipient).
- No reentrancy on claimFees / convertERC20FeesToETH (`nonReentrant` + CEI ordering verified).
- No accruedFees > poolManager-credit drift exploit (sync-execute caps at propose-time snapshot).
- Salt mining for hook-flag address: well-understood (1-in-16384 brute force), front-running mitigated by constructor `_owner` arg.
- Owner-stranding on Arachnid proxy: explicitly avoided via `_owner` constructor injection (Wave 0 redeploy).

**Files referenced:**
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyFeeHook.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\base\TimelockAdmin.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\base\OwnableNoRenounce.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\lib\WETHFallbackLib.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\.claude\worktrees\agent-a06c8b4b1948e025f\contracts\lib\v4-core\src\test\FeeTakingHook.sol` (canonical reference)
