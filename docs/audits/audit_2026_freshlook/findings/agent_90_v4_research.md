# Agent 90 — Fresh-Eyes V4 Hook Exploit Hunt

**Target:** `contracts/src/TegridyFeeHook.sol`
**Lens:** Latest Uniswap V4 hook exploits & CVEs (2024–2026)
**Date:** 2026-05-07
**Mode:** Read-only fresh-eyes pass; no edits

---

## Reference exploits researched

| # | Exploit | Date | Loss | Root cause | Source |
|---|---------|------|------|-----------|--------|
| R1 | Cork Protocol | 2025-05-28 | $11M | `beforeSwap` lacked `onlyPoolManager` → attacker called hook directly with crafted PoolKey, manipulated reserves & minted unbacked DS tokens | https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/ ; https://www.cork.tech/blog/post-mortem |
| R2 | Bunni V2 (LDF rounding) | 2025-09-02 | $8.4M ($2.4M Eth + $5.9M UniChain) | Liquidity Distribution Function precision/floor-rounding error; 44 micro-withdraws drained pool reserves through idle-balance miscalc | https://www.quillaudits.com/blog/hack-analysis/bunni-v2-exploit ; https://www.resonance.security/blog-posts/bunni-dex-hack-when-custom-liquidity-logic-pays-out-fantasy-money |
| R3 | Bunni V2 reentrancy (cross-hook) | 2025 | (component) | Attacker deployed a **malicious hook** without validation; unlocked the global reentrancy guard and re-entered `hookHandleSwap()` + `withdraw()` | https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive |
| R4 | Doppler (Certora C-01, pre-launch) | 2024 | n/a (caught in audit) | Coordinator drainable via attacker-supplied PoolKey with unvalidated `hooks` & `currency` addresses | https://www.certora.com/blog/uniswap-v4-audits-what-we-learned-about-defi-security |
| R5 | z0r0z V4 Router04 | 2026-03 (~block 24,575,085) | $42K USDC | `swap(bytes,uint256)` inline-assembly trusted **fixed calldata offset** (`calldataload(164)`) for auth instead of decoded `BaseData.payer`; non-canonical ABI offset spoofed auth slot while keeping victim as decoded payer | https://www.clarahacks.com/incidents/52f19f90-1081-43c6-a740-8fa8c9e430e1 ; https://x.com/0x3b33/status/2028794219226145259 |
| R6 | Guardian Audits "C-06" | 2024 | n/a (caught in audit) | Limit-order hook: any address could call `beforeSwap()` and `afterSwap()` → mechanism undermined | https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive |

---

## Findings against `TegridyFeeHook.sol`

Format: **F-90-K** ID • severity • status • description.

### F-90-1 — onlyPoolManager modifier (Cork Protocol R1) — **PASS / PROTECTED**
- **Severity:** N/A (no finding)
- **Lens:** Cork Protocol's $11M loss came from `beforeSwap` being externally callable.
- **Check:** TegridyFeeHook lines 190-193 define `modifier onlyPoolManager` reverting `OnlyPoolManager()` if `msg.sender != address(poolManager)`. Line 326 applies it to `afterSwap` (the only state-mutating callback that takes funds). All other 8 hook callbacks are `external pure` returning the selector — no state, no funds, so missing the modifier on those is intentional and harmless (they cannot be exploited; they just return constants).
- **Verdict:** Cork-class direct-call attack on `afterSwap` is **blocked**.

### F-90-2 — Hook permission flag bitmask vs implementation — **PASS / EXACTLY-MATCHED**
- **Severity:** N/A
- **Lens:** Cyfrin/Hacken: a hook deployed at an address whose flag bits don't match the implemented callbacks → either DoS (`AFTER_SWAP_RETURNS_DELTA_FLAG` missing while delta returned) or callbacks silently skipped.
- **Check:** Constructor line 223 enforces:
  `require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");`
  - `0x0040` = AFTER_SWAP_FLAG
  - `0x0004` = AFTER_SWAP_RETURNS_DELTA_FLAG
  - Mask `0x3FFF` covers all 14 V4 hook permission bits → **exclusive equality** guarantees no other flag bits set.
  - `afterSwap` implementation returns `(selector, int128 feeAmount)` matching `AFTER_SWAP_RETURNS_DELTA_FLAG` semantics → flag-vs-implementation consistent.
- **Verdict:** Mismatch class blocked. Comment on line 218-222 already calls out the requirement to bump `0x3FFF` if v4-core ever adds bits 14+.

### F-90-3 — Return-delta sign convention (Cyfrin/Hacken) — **PASS / MATCHES CANONICAL**
- **Severity:** N/A
- **Lens:** Returning the wrong sign in `afterSwap` flips fee direction → either user pays, or hook pays (drain). Doc rule (Uniswap docs / Cyfrin): "If the Hook takes a fee, it must pass the value as a negative delta (−a). If the Hook grants a rebate, it must pass the value as a positive delta (+a)." However, this rule is for `beforeSwap`'s `BeforeSwapDelta`. For `afterSwap` returning `int128 hookDeltaUnspecified`, the **canonical Uniswap v4-core test** `lib/v4-core/src/test/FeeTakingHook.sol:50` returns **positive** `feeAmount.toInt128()` after calling `manager.take(feeCurrency, address(this), feeAmount)`.
- **Check:** TegridyFeeHook lines 430-437 mirror `FeeTakingHook` exactly: `poolManager.take(...)` first, then `return (IHooks.afterSwap.selector, feeAmount)` where `feeAmount = int128(uint128(feeUint))` — positive. The PoolManager applies the positive return as `swapDelta -= toBalanceDelta(0, feeAmount)`, which **reduces** what the user receives by exactly `feeUint`. `take()` registers a negative hook delta that cancels the positive return → net hook delta = 0 → no `CurrencyNotSettled` revert.
- **Verdict:** Sign convention matches canonical v4-core fee-skim. Earlier inversion (mentioned in inline comment lines 363-368 — "fee from INPUT raw units while crediting it as OUTPUT raw units") was fixed in pass C-2.

### F-90-4 — PoolKey allowlist (Cork R1 + Doppler R4) — **PASS / NEW DEFENSE ADDED**
- **Severity:** N/A (defense in place)
- **Lens:** Cork attacker deployed a fake pool with attacker-controlled tokens whose `transferFrom` was a no-op; if any unprivileged pool can invoke this hook, the attacker can credit fake `accruedFees[malicious_token]` and drain via the fee-conversion path. Doppler's pre-launch C-01 was the same shape.
- **Check:** Lines 161, 259-275, 333-335 implement an `approvedPools[bytes32]` mapping keyed by `keccak256(abi.encode(PoolKey))`. `afterSwap` returns zero-fee for unapproved keys (NOT revert — comment on line 332-334 explicitly chose silent zero-fee to avoid bricking swaps on misconfigured pools). `approvePool`/`revokePool` are owner-gated (single-step, no timelock — explained inline as "additive" so timelock unnecessary).
- **Verdict:** Cork-class fake-pool attack blocked. Note: an attacker who somehow gets `approvePool` called on a malicious pool (compromised owner) would still trigger fake-fee accrual, but that requires owner key, and the conversion path (`convertERC20FeesToETH`) is also `onlyOwner` → no privilege escalation.

### F-90-5 — Currency settlement (take vs settle vs sync) — **PASS / EXPLICIT TAKE WITH NET-ZERO HOOK DELTA**
- **Severity:** N/A
- **Lens:** Hacken/Cyfrin: "If a Hook modifies a balance, it must ensure deltas sum to zero before transaction finalizes." Unsettled dust → DoS via `CurrencyNotSettled`. Pre-fix in TegridyFeeHook (per inline comment line 411-417) returned positive `feeAmount` without `take()`, leaving non-zero hook delta and reverting every swap.
- **Check:** Line 430 calls `poolManager.take(feeCurrency, address(this), feeUint)` BEFORE returning. The `take()` registers a negative delta of `feeUint` against the hook; the returned positive `feeAmount` registers `+feeUint` (PoolManager applies it to swapDelta). Hook's net flash-accounting delta at unlock-close = 0. **No `clear()` needed** because there is no dust — `take()` and the return value are exact-equal magnitudes.
- **Verdict:** Settlement correct. Note: `claimFees` and `convertERC20FeesToETH` operate **outside** the unlock context and act on the hook's already-realized ERC20/ETH balance held in this contract — they do NOT touch `poolManager.take` (which would revert `ManagerLocked` outside an unlock). This is also called out inline (line 425-429).

### F-90-6 — Cross-hook composition / reentrancy (Bunni R3) — **PASS / DEFENSE-IN-DEPTH**
- **Severity:** N/A
- **Lens:** Bunni V2's $8.4M was partly enabled by a malicious hook re-entering the unlock context. TegridyFeeHook does NOT call any external hooks during `afterSwap`, but it does call into untrusted ERC20s (`feeCurrency` may be malicious if owner approved a bad pool — see F-90-4).
- **Check:** Line 50 inherits `ReentrancyGuard`. The two "real" external entry points (`claimFees`, `convertERC20FeesToETH`) are both `nonReentrant`. The `afterSwap` callback is **not** `nonReentrant` — but it is `onlyPoolManager`, and the PoolManager itself enforces reentrancy guards via the unlock-callback pattern. Critically:
  - `afterSwap` only interacts with `poolManager.take` (trusted v4-core code) and storage updates → no callback to attacker contracts.
  - `accruedFees[creditToken] += feeUint` increments BEFORE `take()` (CEI-clean for state-vs-external order).
- **Verdict:** Reentrancy class blocked.

### F-90-7 — Bunni V2 LDF rounding pattern (R2) — **N/A scope**
- **Severity:** N/A — different design space
- **Lens:** Bunni's hack came from custom liquidity-distribution math with floor-rounding errors. TegridyFeeHook does **not** implement custom LDF, custom JIT liquidity, or custom price-curve logic. It is purely a fee-skim on `afterSwap` of the unspecified currency.
- **Check:** Fee math is `(absAmount * feeBps) / 10000` with `feeBps ≤ MAX_FEE_BPS = 100` (1% cap). Inline minimum-fee floor on line 394 (`feeUint = 1` if rounded to zero on a swap > 1 wei) — this is a deliberate dust-collection path. The fee is taken from a single side per swap, no cross-balance arithmetic that could compound rounding.
- **Verdict:** Bunni-class rounding/LDF attacks **structurally not applicable**.

### F-90-8 — z0r0z calldata-offset bug (R5) — **PASS / NO ASM**
- **Severity:** N/A
- **Lens:** z0r0z's $42K loss came from inline-assembly `calldataload(<fixed offset>)` for auth instead of decoding ABI dynamic offsets.
- **Check:** Grep confirms zero `assembly` blocks in `TegridyFeeHook.sol`. All param decoding happens via Solidity's standard ABI decoder. The `path[0] == currency` check on line 564 uses standard memory access, not calldataload.
- **Verdict:** Calldata-offset class blocked.

### F-90-9 — Fee skim accounting / over-claim (general) — **PASS / DOUBLE-LEDGER**
- **Severity:** N/A (well-defended)
- **Lens:** Hooks that don't track per-currency accrual can over-claim from PoolManager credit.
- **Check:** TegridyFeeHook keeps a **double ledger**:
  1. `accruedFees[token]` — internal counter incremented in `afterSwap` before `take()`.
  2. PoolManager's ERC6909 credit for this hook — readable as `poolManager.balanceOf(this, currencyId)`.
  Sync between the two is via the **24h-timelocked + 7-day-cooldown + 10%-step-cap** `proposeSyncAccruedFees`/`executeSyncAccruedFees` flow (lines 629-690). Upward sync requires the proposed value ≤ snapshot of on-chain credit at propose-time (D-AMM-M4 fix prevents claim-race draining the snapshot).
  `claimFees` decrements `accruedFees[currency] -= amount` BEFORE the WETH-unwrap → forward → revert path (CEI-clean, line 499). `convertERC20FeesToETH` zeros `accruedFees` to `0` or `accrued - amount` BEFORE the swap (CEI-clean, line 595).
- **Verdict:** Over-claim path requires either (a) compromised owner racing 24 sequential 24h proposals over ~24 weeks to inflate by 10× (R014 fix), or (b) breaking the PoolManager itself. Both out of scope.

### F-90-10 — Currency stranding / native-ETH branch — **PASS / RECENT BATCH-A FIX**
- **Severity:** N/A (already addressed)
- **Lens:** Pre-Bunni, `claimFees` rejected `address(0)` (native ETH) as a currency, AND `convertERC20FeesToETH` rejected `address(0)` (line 562) → if PoolManager ever credited native-ETH fees (which V4 does on ETH-side pools), they'd strand permanently.
- **Check:** `claimFees` lines 514-527 dispatch on three branches:
  1. `address(0)` → forward via `WETHFallbackLib.safeTransferETHOrWrap`
  2. `WETH` → unwrap then forward
  3. anything else → revert `MustConvertERC20First()` and route through `convertERC20FeesToETH`
- **Verdict:** Currency stranding closed.

### F-90-11 — Owner-key sandwich on conversion path — **PASS / FLOOR + IMMUTABLE TARGET**
- **Severity:** N/A (defense in place)
- **Lens:** A captured owner could call `convertERC20FeesToETH` with `minETHOut=1` and accept full sandwich extraction.
- **Check:** Line 572 enforces absolute floor `if (minETHOut < 1e14) revert InsufficientETHOut()`. Path-end is forced to canonical `WETH` (immutable, line 564). Router-claimed `WETH()` is verified to match canonical `WETH` (line 565) — prevents fork-WETH attack. Resulting ETH is forwarded to immutable `revenueDistributor` (line 614). Caller-supplied `minETHOut` may TIGHTEN above floor; deadline bounded `[now, now+30min]` (line 563).
- **Verdict:** Captured-owner sandwich loss bounded to `(twap_value − 1e14)` per call. Note: BATCH-L4 M6 fix already documented inline (lines 566-571).

---

## Notes / dead-ends explored, no findings produced

- **Native-ETH reentrancy from `afterSwap`** — `poolManager.take(NATIVE, hook, fee)` does NOT actually transfer ETH inline; it credits ERC6909. The native ETH only lands when `claimFees(address(0), amt)` calls `WETHFallbackLib.safeTransferETHOrWrap`. That helper uses a 10k-gas stipend (anti-reentrancy) and `nonReentrant` modifier on `claimFees`. No exploit path.
- **Owner approving malicious pool** — covered by F-90-4. Even if owner approves a malicious pool, the malicious token's transfer hooks cannot escalate beyond `convertERC20FeesToETH` (also `onlyOwner`), which itself enforces `path[0] == currency` and `path[end] == WETH`. The attacker-token's `transferFrom` runs inside `swapExactTokensForETH`, but the realized ETH return is bounded by the floor + caller-supplied `minETHOut`. No drain path.
- **`afterSwap` gas grief on huge `accruedFees` increment** — `accruedFees[creditToken] += feeUint` is a single SSTORE; `feeUint` capped by `feeBps ≤ 1%` of swap amount. No unbounded loop; no DoS.
- **Hook upgradeability backdoor** — not applicable; contract is non-upgradeable, all admin paths are through 24h/48h timelocks.
- **`approvePool` race vs `afterSwap`** — `approvePool` is `onlyOwner` so cannot race with attacker. If owner approves then revokes, only swaps that observed the "approved" state get credited; the silent zero-fee return on revoke is by design (avoids swap-bricking).
- **PoolManager balanceOf snapshot stale-read in `executeSyncAccruedFees`** — addressed by D-AMM-M4 (`pendingSyncCreditSnapshot` snapshotting at propose time, line 634-637, line 671). No bypass.
- **Bunni LDF / custom liquidity hooks** — TegridyFeeHook has no LDF surface; structurally not applicable.

---

## Summary

**Findings against TegridyFeeHook.sol: 0 NEW exploitable issues.**

All 11 attack-vector classes from 2024–2026 V4 hook exploits (Cork access control, Bunni LDF, Bunni cross-hook reentrancy, Doppler PoolKey validation, z0r0z calldata offset, Cyfrin sign-convention, Hacken settlement) are **already mitigated** by existing defenses encoded in inline comments dated PASS-7 / PASS-8 / BATCH-L4 / R014 / D-AMM-M4 / V3-AMM-H1 / etc.

Notable strengths:
1. Exclusive flag-bitmask check (`& 0x3FFF == 0x0044`) — stronger than typical hook constructors.
2. PoolKey allowlist with silent-zero-fee on rejection — closes Cork without bricking misconfigured pools.
3. Double-ledger (internal `accruedFees` + on-chain ERC6909 credit) with race-free snapshot timelock — closes Cork-style fake-fee credit attacks even with compromised owner.
4. Currency dispatch in `claimFees` covers native-ETH, WETH, and ERC20-rejection branches — closes BATCH-A C2 stranding.
5. `convertERC20FeesToETH` has absolute non-zero `minETHOut` floor (1e14 wei) + immutable WETH + deadline bound — bounds captured-owner sandwich loss.

The hook follows the canonical `lib/v4-core/src/test/FeeTakingHook.sol` pattern faithfully. No new exploitable findings from a fresh-eyes V4 perspective.

---

## Sources

- Cork Protocol incident analysis — https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/
- Cork Protocol post-mortem — https://www.cork.tech/blog/post-mortem
- Bunni V2 hack analysis — https://www.quillaudits.com/blog/hack-analysis/bunni-v2-exploit
- Bunni V2 cross-hook reentrancy / Cyfrin deep-dive — https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive
- Hacken V4 hook audit guide — https://hacken.io/discover/auditing-uniswap-v4-hooks/
- Certora Doppler audit findings — https://www.certora.com/blog/uniswap-v4-audits-what-we-learned-about-defi-security
- z0r0z V4Router04 calldata-offset incident — https://www.clarahacks.com/incidents/52f19f90-1081-43c6-a740-8fa8c9e430e1
- z0r0z incident tweet — https://x.com/0x3b33/status/2028794219226145259
- Calldata injection writeup — https://dev.to/ohmygod/calldata-injection-the-17m-vulnerability-pattern-hiding-in-every-defi-router-1bli
- Uniswap V4 hook security 7 attack vectors — https://dev.to/ohmygod/uniswap-v4-hook-security-7-attack-vectors-that-already-cost-defi-11m-and-how-to-defend-against-262
- Uniswap V4 docs (custom accounting / BeforeSwapDelta guide) — https://docs.uniswap.org/contracts/v4/guides/custom-accounting
