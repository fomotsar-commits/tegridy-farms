# Post-Fix Scan — TegridyFeeHook (Uniswap V4)

**Target:** `contracts/src/TegridyFeeHook.sol` (854 LoC)
**HEAD:** `6865982` (minimal MEDs) on top of `e441133` (Wave-B revert) on top of `8d8bac4` (Wave A)
**Mandate:** `memory/feedback_minimal_surface.md` — custom code IS the exploit source; copy battle-tested verbatim; DELETE before ADD
**Canonical refs consulted:**
- `contracts/lib/v4-core/src/interfaces/IHooks.sol`
- `contracts/lib/v4-core/src/test/FeeTakingHook.sol`
- `contracts/lib/v4-core/src/libraries/Hooks.sol` (flag bitmap, `validateHookPermissions`, `isValidHookAddress`)
- `contracts/lib/v4-core/src/PoolManager.sol` (`take`, `unlock`)
- `contracts/lib/v4-core/src/types/Currency.sol` (full-gas native ETH transfer)
- `contracts/src/lib/WETHFallbackLib.sol` (in-tree)
- `contracts/src/base/TimelockAdmin.sol` (in-tree, MakerDAO DSPause/Compound Timelock pattern)
- `.audit_2026_freshlook/POST_MANDATE_STATE.md`
- `.audit_2026_freshlook/findings/agent_22_feehook_v4.md`
- `.audit_2026_freshlook/findings/agent_42_overflow_class.md`
- `.audit_2026_freshlook/findings/agent_76_v4_hook_spec.md`
- `.audit_2026_freshlook/fix_review/agent_review_FeeHook.md`

---

## TL;DR

**The Wave-B fix-list embedded in the prompt does NOT match the live source.** Wave B was reverted in commit `e441133`. The post-revert source contains only Wave A + minimal-MED commit `6865982`. Eight of the ten "verify present" markers in the prompt refer to fixes that EXIST ONLY IN GIT HISTORY (commits `c490a84`, `d04af18`) — they are absent from the deployed file. Two markers (M-40 sweepETH via lib, M-43 unwrap-then-push) are correctly present.

This is **NOT a regression vs. mandate** — `POST_MANDATE_STATE.md` line 50 states `M-43` is closed transitively by H-11 prewarm; the Wave-B fixes for F-22-K-13 / F-23-5 / F-23-3 / F-42-1 / F-76-A / F-76-C were the "~3500 LoC of over-engineering" the revert dropped. Mandate-aligned posture: ACCEPT-AS-DESIGN where the underlying issue does not have a billion-dollar canonical pattern, OR escalate the few that do (F-76-A is a 9-line strikethrough, the only one that is a pure mandate-positive change).

**V4 spec compliance:** clean (post-revert, the file matches canonical `FeeTakingHook` shape). **Permission flag bits:** clean. **`onlyPoolManager`:** present on `afterSwap`. **Cork-pattern bug:** absent.

---

## Verification matrix (per prompt marker)

| # | Marker | Location | Status | Severity |
|---|---|---|---|---|
| 1 | Hook permission flag bits exact match | `:223` `& 0x3FFF == 0x0044` | **PASS** | n/a |
| 2 | `onlyPoolManager` on every state-mutating callback | `:326` (afterSwap only) | **PASS** | n/a |
| 3 | Return delta sign convention | `:369-378, 437` matches FeeTakingHook | **PASS** | n/a |
| 4 | Native ETH currency handling | `:514-516, 852` | **PASS** | n/a |
| 5 | No inline asm hardcoded calldata offsets | none in file | **PASS** | n/a |
| 6 | F-22-K-13 `approvePool` `key.hooks` check at entry | `:259-263` | **NOT PRESENT** | INFO (no exploit; misconfig only) |
| 7 | F-23-5 / F-75-5 SYNC_RE_ARM_COOLDOWN at PROPOSE | `:664` (at execute, NOT propose) | **NOT PRESENT (semantic mismatch)** | LOW (cancel→propose loop reachable) |
| 8 | F-23-3 runtime `feeBps` cap clamp | `:389` reads raw | **NOT PRESENT** | INFO (writer-path validation alone) |
| 9 | F-42-1 / F-76-D int128.min substitution | `:382` plain negation | **NOT PRESENT** | LOW (Panic(0x11) on contrived edge) |
| 10 | F-76-A drop `pure` from 9 IHooks no-op stubs | `:281,285,290,296,302,308,314,441,447` all `external pure` | **NOT PRESENT** | MEDIUM (forward-compat, ABI alignment) |
| 11 | F-76-C named hook permission constants | inline literals only | **NOT PRESENT** | INFO (cosmetic, values are correct) |
| 12 | M-40 sweepETH via `WETHFallbackLib`, recipient pinned | `:836-849` | **PASS** | n/a |
| 13 | M-43 reverted to `withdraw` → `safeTransferETHOrWrap` | `:519-520` | **PASS** | n/a |

---

## Detail per marker

### 1. Hook permission flag bits (CANONICAL ALIGNMENT — PASS)

```solidity
:223  require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");
```

Verified against `lib/v4-core/src/libraries/Hooks.sol`:
- `ALL_HOOK_MASK = uint160((1 << 14) - 1) = 0x3FFF` ✓
- `AFTER_SWAP_FLAG = 1 << 6 = 0x40` ✓
- `AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2 = 0x04` ✓
- Combined `0x44` ✓

The exclusive equality (`==` not `>=`) ensures NO other flag bit can be set. `validateHookPermissions` invariant is enforced at construction; cannot deploy to an over-permissioned address. The `0x3FFF` mask exactly covers the 14 currently-allocated V4 flag bits — forward-compat note already inlined in NatSpec at `:214-222`.

**Verdict:** PASS. Identical to canonical `BaseHook.validateHookPermissions` semantics.

---

### 2. `onlyPoolManager` modifier (CORK-PATTERN BUG — PASS)

```solidity
:190-193 modifier onlyPoolManager() {
            if (msg.sender != address(poolManager)) revert OnlyPoolManager();
            _;
        }
:326   function afterSwap(...) external onlyPoolManager returns (bytes4, int128) {
```

`afterSwap` is the only state-mutating IHooks callback, and it carries `onlyPoolManager`. The Cork Protocol $11M bug (April 2025) was a hook callback that forgot this modifier — that pattern is NOT reproducible here. All other 9 IHooks methods are `external pure` no-ops (no state mutation possible regardless of caller).

**Verdict:** PASS. Cork-pattern bug not present.

---

### 3. Return delta direction (V4 SIGN CONVENTION — PASS)

```solidity
:369  bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
:372-378 fee taken on UNSPECIFIED currency (matches FeeTakingHook:41-43)
:382  if (swapAmount < 0) swapAmount = -swapAmount;  // |unspecified-side delta|
:430  poolManager.take(feeCurrency, address(this), feeUint);
:437  return (IHooks.afterSwap.selector, feeAmount);  // positive int128
```

Compared head-to-head with `lib/v4-core/src/test/FeeTakingHook.sol:39-50`:
- Identical specified-side discrimination via `(amountSpecified < 0) == zeroForOne`
- Identical UNSPECIFIED-side fee target
- Identical `manager.take(currency, address(this), feeAmount)` settlement pattern
- Identical positive `int128` return shape (V4 `Hooks.callHookWithReturnDelta` adds it to `hookDeltaUnspecified`; `_accountPoolBalanceDelta` registers `+feeAmount` against the hook; net hook delta = 0 → no `CurrencyNotSettled`)

The earlier C-2 inversion (input-vs-output mismatch + decimals-mismatch DoS) was closed in commit `4701416` and verified post-correction by agent 22 (F-22-K-05).

**Verdict:** PASS. Bit-identical to canonical reference.

---

### 4. Native ETH handling (`address(0)`) (PASS)

`afterSwap` path with `feeCurrency == Currency.wrap(address(0))`:
- `poolManager.take(address(0), this, feeUint)` triggers `Currency.transfer(this, amount)` which is `to.call{value: amount}("")` with full gas (per `lib/v4-core/src/types/Currency.sol:46-49`). The hook's empty `receive()` accepts.
- `accruedFees[address(0)] += feeUint` tracks raw ETH balance.

`claimFees(address(0), amount)` path (`:514-516`):
- Forwards via `WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount)` — 30k stipend + WETH-fallback. ETH already on hand (no unwrap needed).

`convertERC20FeesToETH(address(0), ...)` correctly reverts `ZeroAddress` (`:562`) — native ETH is already-ETH; no conversion needed.

**Verdict:** PASS. Identical to Bunni v2 BunniHook native-ETH dispatch.

---

### 5. No hardcoded calldata-offset assembly (PASS)

`grep "assembly"` in `contracts/src/TegridyFeeHook.sol` returns no hits. The z0r0z V4 router bug (calldata-offset assumption divergence) is not reproducible — this contract has no inline assembly. Selector + return-shape dispatch is via Solidity-generated calldata layout, fully controlled by solc's ABI encoding.

**Verdict:** PASS.

---

### 6. F-22-K-13 — `approvePool` key.hooks guard — **NOT PRESENT**

```solidity
:259-263 function approvePool(PoolKey calldata key) external onlyOwner {
            bytes32 h = _poolKeyHash(key);
            approvedPools[h] = true;
            emit PoolApproved(...);
        }
```

No `require(address(key.hooks) == address(this), "WRONG_HOOK_ADDR");` at entry. The Wave-B agent_review_FeeHook.md described this as PRESENT at line 349 — that commit is reverted.

**Exploit reachability:** None. If owner approves a `key` with `key.hooks != address(this)`:
- The pool's `afterSwap` is dispatched to the OTHER hook (V4 routes by `key.hooks` field).
- THIS hook's `afterSwap` is never called for that pool, so `approvedPools[h]` is never read for it.
- The `keccak256(abi.encode(key))` hash includes `key.hooks`, so this hook's allowlist entry corresponds to a different (impossible-to-reach) hash than V4 would dispatch.
- Net: silent misconfiguration, no value flow, no exploit.

**Severity:** INFO. Mandate posture: ACCEPT-AS-DESIGN. The closure shape is one `require` line, but the bug class is "owner-side misconfig with no value impact" — exactly the class POST_MANDATE_STATE.md groups under "operator concern; document, do not add code."

---

### 7. F-23-5 / F-75-5 — SYNC_RE_ARM_COOLDOWN cancel→propose loop — **NOT PRESENT (semantic mismatch)**

The prompt asks: "Verify the cooldown is enforced at PROPOSE, not just at execute."

Current source enforces at **EXECUTE** only:

```solidity
:629  function proposeSyncAccruedFees(address currency, uint256 actualCredit) external onlyOwner {
        require(actualCredit != accruedFees[currency], "SAME_VALUE");
        // NO cooldown gate at propose
        ...
        _propose(key, SYNC_DELAY);  // 24h timelock
      }

:661  function executeSyncAccruedFees(address currency) external onlyOwner whenNotPaused {
:664    require(block.timestamp >= lastSyncExecuted[currency] + SYNC_COOLDOWN, "SYNC_COOLDOWN");
```

`cancelSyncAccruedFees` (`:695-701`) clears `_executeAfter[key]` via `_cancel` and zeros `pendingSyncCredit` / `pendingSyncCreditSnapshot`, but does NOT update `lastSyncExecuted`. So:

**Cancel→propose loop IS reachable today:**
1. Captured-owner calls `proposeSyncAccruedFees(currency, X)` at t=0.
2. Owner calls `cancelSyncAccruedFees(currency)` at t=1 (no cooldown).
3. Owner calls `proposeSyncAccruedFees(currency, X')` at t=2 (no cooldown).
4. Repeats indefinitely. Each cycle DoS's `claimFees` / `convertERC20FeesToETH` for 24h+ via the `SYNC_PENDING` gate (`:494-497, 578-581`).

`SYNC_COOLDOWN = 7 days` only blocks back-to-back **executes**. The propose-side DoS surface is open.

**Exploit reachability:** Captured owner can perpetually block permissionless `claimFees`. Practical impact bounded — accruedFees keeps accumulating; eventually owner must execute or proposal expires and `expireSyncAccruedFees` (permissionless, `:713-723`) cleans up. The expired-proposal escape hatch (V2-AMM-M1, V3-AMM-M2) means the DoS auto-resolves after `SYNC_DELAY + PROPOSAL_VALIDITY = 24h + 7d = 8 days` of inaction — but owner can re-propose immediately to restart the cycle.

**Worst case:** 7-day rolling DoS on permissionless claim path (since each cycle costs the captured owner one tx every 8 days). Funds NOT extractable; only paid out delayed. veTOWELI yield trickle.

**Severity:** LOW (captured-owner griefing on a permissionless path; no value loss; auto-resolves on owner inaction).

**Mandate posture:** ACCEPT-AS-DESIGN. The closure requires either (a) adding `lastSyncStateChange` mapping (new state — anti-pattern flagged in POST_MANDATE_STATE.md) or (b) writing `lastSyncExecuted[currency] = block.timestamp` on cancel (makes cancel itself trip the 7d cooldown for the next legit propose — same mapping repurposed; would require splitting the slot semantics). Both are mandate-tension; defer to operational discipline (owner-side multisig posture).

---

### 8. F-23-3 — runtime feeBps cap clamp — **NOT PRESENT**

```solidity
:389  uint256 feeUint = (absAmount * feeBps) / 10000;  // raw feeBps read
```

No `effectiveFeeBps = feeBps > MAX_FEE_BPS ? MAX_FEE_BPS : feeBps` clamp. `feeBps` writer paths:
- Constructor (`:213`): `if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();` ✓
- `proposeFeeChange` (`:740`): `if (_newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();` ✓

Both writer-paths gate to `[0, 100]`. Cannot reach a state where `feeBps > MAX_FEE_BPS` without a storage-corruption primitive. `MAX_FEE_BPS` is `constant`, not updateable — re-deploy required to change.

**Exploit reachability:** None today. The Wave-B clamp was defense-in-depth for a hypothetical future "MAX_FEE_BPS becomes mutable" refactor.

**Severity:** INFO.

**Mandate posture:** ACCEPT-AS-DESIGN. Adding a single ternary on a hot path costs gas + complexity for zero current threat.

---

### 9. F-42-1 / F-76-D — int128.min special-case — **NOT PRESENT**

```solidity
:382  if (swapAmount < 0) swapAmount = -swapAmount;
```

Plain negation. On `swapAmount == type(int128).min`, Solidity 0.8 checked math reverts with `Panic(0x11)`.

**Exploit reachability:** Requires a V4 `BalanceDelta` half exactly equal to `-2^127 ≈ -1.7e38` raw token units. For an 18-decimal token: 1.7e20 whole tokens. Economically unreachable on any real V4 pool (exceeds total supply of any production token). Reachable only with a bespoke malformed-delta token; even then, only on a pool the captured-owner already approved (so it's an owner-cooperating griefing scenario, not third-party exploit).

**Failure mode:** revert in `afterSwap` → V4 unlock fires `HookCallFailed` → user's swap reverts. NOT a value-siphon.

**Severity:** LOW (the in-tree audit at agent_42_overflow_class.md F-42-1 also rates LOW for the same reasons).

**Mandate posture:** ACCEPT-AS-DESIGN. The closure is one ternary; canonical `FeeTakingHook` doesn't have it either; the protocol's documented "swap-on-unapproved-pool returns 0-fee instead of reverting" pattern is not consistent with this corner case, but the inconsistency is cosmetic only.

---

### 10. F-76-A — drop `pure` from 9 IHooks no-op stubs — **NOT PRESENT (highest-impact open item)**

All 9 IHooks no-op stubs declared `external pure`:

```solidity
:281  function beforeInitialize(...) external pure returns (bytes4) {
:285  function afterInitialize(...) external pure returns (bytes4) {
:290  function beforeAddLiquidity(...) external pure returns (bytes4) {
:296  function afterAddLiquidity(...) external pure returns (bytes4, BalanceDelta) {
:302  function beforeRemoveLiquidity(...) external pure returns (bytes4) {
:308  function afterRemoveLiquidity(...) external pure returns (bytes4, BalanceDelta) {
:314  function beforeSwap(...) external pure returns (bytes4, BeforeSwapDelta, uint24) {
:441  function beforeDonate(...) external pure returns (bytes4) {
:447  function afterDonate(...) external pure returns (bytes4) {
```

`lib/v4-core/src/interfaces/IHooks.sol` declares all 9 as `external returns (...)` with NO `pure` / `view` modifier. Solidity 0.8.26 *allows* a `pure` override of a non-pure interface method (purity is more restrictive), so this compiles and selectors are identical at the EVM ABI level.

**Forward-compat hazard:**
- If V4 spec evolves to require non-pure lifecycle hooks (e.g. for `tstore`/`tload` flag coordination across hooks), this contract is source-incompatible with the new spec — would require a redeploy with new salt-mining (CREATE2 address depends on bytecode).
- V4 reference test frameworks (Hacken's open-source v4-hook test harness) that compile `MockHook is IHooks` and exact-match mutability fail to compile against this contract.

**Severity:** MEDIUM (per agent_76_v4_hook_spec.md F-76-A and the prior fix_review).

**Mandate posture (recommendation):** This is the single mandate-positive change in the open list. The fix is "delete the word `pure` 9 times" (DELETE-style, mandate-aligned, zero new state, zero new code). It improves canonical-interface alignment which is exactly what the mandate asks for. **Recommend escalating for explicit user approval to apply this 9-line strikethrough.** All other open markers either need new state (anti-pattern) or are cosmetic in the post-mandate threat model.

---

### 11. F-76-C — named hook permission constants — **NOT PRESENT**

Source uses inline magic numbers `0x3FFF`, `0x0044`, `0x0040`, `0x0004` only in NatSpec / require. No named constants like `HOOK_FLAG_AFTER_SWAP = 0x40` / `EXPECTED_HOOK_FLAGS = 0x44`.

**Verdict on bit values:** correct. `0x40 | 0x04 == 0x44` matches `AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG` in `lib/v4-core/src/libraries/Hooks.sol:38, 44`.

**Severity:** INFO (cosmetic; values are bit-identical to canonical).

**Mandate posture:** ACCEPT-AS-DESIGN. Named constants are pure readability win; no security delta.

---

### 12. M-40 sweepETH via WETHFallbackLib (PASS)

```solidity
:836  function sweepETH(address to) external onlyOwner {
:839    if (to != revenueDistributor) revert InvalidSweepRecipient();  // V3-AMM-H1
:840    uint256 balance = address(this).balance;
:841    require(balance > 0, "NO_ETH");
:847    WETHFallbackLib.safeTransferETHOrWrap(WETH, to, balance);  // 30k stipend + WETH fallback
:848    emit ETHSwept(to, balance);
        }
```

Verified:
- Recipient pinned to `revenueDistributor` only (V3-AMM-H1). `owner()` correctly REMOVED from allowlist (the captured-owner cannot sweep to themselves).
- `revenueDistributor` is mutable but behind a 48h timelock (`DISTRIBUTOR_CHANGE_DELAY`, `:73`). Captured-owner cannot rotate to attacker-controlled within 48h without a guardian-cancel surfacing it.
- `WETHFallbackLib.safeTransferETHOrWrap` uses 30k gas stipend (was 10k pre-M-36). 30k accommodates first-ingress cold-SSTORE + LOG2 cushion (RevenueDistributor's `_totalETHReceivedRaw` is pre-warmed to 1, so SSTORE is non-zero→non-zero ~5k; well within 30k).
- Defense-in-depth: 30k still far below external-call budgets (700g + ~2.5k arg copy minimum), so reentrancy hardening preserved.

**Verdict:** PASS. Recipient pinning intact; canonical lib pattern.

---

### 13. M-43 reverted to unwrap-then-push (PASS)

```solidity
:514-527  if (amount > 0) {
            if (currency == address(0)) {
              // Native ETH path: forward directly via lib (already on hand)
              WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount);
            } else if (currency == WETH) {
              // Canonical WETH path: unwrap to native, then forward
              IWETH(WETH).withdraw(amount);
              WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount);
            } else {
              revert MustConvertERC20First();
            }
          } else {
            // amount == 0 health-check: still validate currency is claimable
            if (currency != address(0) && currency != WETH) revert MustConvertERC20First();
          }
```

The Wave-B M-43 "direct WETH transfer to RevenueDistributor" was the HIGH structural value-flow break flagged in agent_review_FeeHook.md Finding 1 (RevenueDistributor's `_distribute()` reads `address(this).balance` only; `proposeTokenSweep(weth, ...)` reverts `TokenSweepWETHDenied` — WETH would have been permanently stranded). The current source uses the safe `IWETH.withdraw → safeTransferETHOrWrap` pattern; stakers receive ETH that lands in `_distribute()` epoch flow.

**Verdict:** PASS. Stranded-WETH bug not present; canonical Bunni v2 BunniHook-style native/WETH dispatch.

---

## Storage layout verification

Cross-checked against `.audit_2026_freshlook/storage_layout/TegridyFeeHook.txt`:

| Slot | Field | Type | Match |
|---|---|---|---|
| 0 | `_owner` (OwnableNoRenounce) | address | ✓ |
| 1 | `_pendingOwner` | address | ✓ |
| 2 | `ownershipTransferExpiresAt` | uint256 | ✓ |
| 3 | `_paused` (Pausable) | bool | ✓ |
| 4 | `_executeAfter` (TimelockAdmin) | mapping(bytes32 => uint256) | ✓ |
| 5 | `revenueDistributor` | address | ✓ |
| 6 | `feeBps` | uint256 | ✓ |
| 7 | `pendingFee` | uint256 | ✓ |
| 8 | `pendingDistributor` | address | ✓ |
| 9 | `accruedFees` | mapping(address => uint256) | ✓ |
| 10 | `approvedPools` | mapping(bytes32 => bool) | ✓ |
| 11 | `lastSyncExecuted` | mapping(address => uint256) | ✓ |
| 12 | `pendingSyncCredit` | mapping(address => uint256) | ✓ |
| 13 | `pendingSyncCreditSnapshot` | mapping(address => uint256) | ✓ |

OZ ReentrancyGuard's `_status` slot is set via OZ 5.0 transient-storage (no fixed slot in the layout) — confirmed by absence from the storage_layout dump.

**`poolManager` and `WETH` are `immutable`** — not in the storage table (compiled into bytecode), correct.

**Verdict:** PASS. Storage layout matches expected; no slot collision; no ghost field.

---

## Summary of new (post-revert) findings

| ID | Severity | Description | Mandate posture |
|---|---|---|---|
| POST-FH-01 | MEDIUM | F-76-A `pure` not dropped from 9 IHooks no-op stubs (forward-compat / canonical alignment) | **Recommend escalation** — DELETE-shape fix, mandate-positive |
| POST-FH-02 | LOW | F-23-5 SYNC_RE_ARM_COOLDOWN not enforced at PROPOSE → cancel→propose-loop reachable | ACCEPT-AS-DESIGN (operational; expired-proposal escape hatch present; no value loss) |
| POST-FH-03 | LOW | F-42-1 int128.min self-revert (DoS only on contrived oversized delta) | ACCEPT-AS-DESIGN (matches canonical `FeeTakingHook`) |
| POST-FH-04 | INFO | F-22-K-13 approvePool no key.hooks guard | ACCEPT-AS-DESIGN (operator-side misconfig only) |
| POST-FH-05 | INFO | F-23-3 no runtime feeBps clamp | ACCEPT-AS-DESIGN (writer-path validation alone is sufficient given constant cap) |
| POST-FH-06 | INFO | F-76-C no named hook permission constants | ACCEPT-AS-DESIGN (cosmetic) |

**Pre-existing `syncAccruedFees` test failures** (3/146 in commit `6865982`) — separate concern; commit `d5ca554` (test-fix slot-drift) postdates this scan. Not a security finding.

---

## V4 hook non-negotiables (prompt requirements)

| Requirement | Status |
|---|---|
| Hook permission flag bits in deployed address EXACTLY match implemented hooks | **PASS** (`0x44` exclusive over 14-bit space) |
| `onlyPoolManager` modifier on every callback that mutates state (Cork bug) | **PASS** (only `afterSwap` mutates; modifier present) |
| Return delta direction matches v4-core canonical sign convention | **PASS** (bit-identical to `FeeTakingHook`) |
| Native ETH currency handling identical to canonical | **PASS** (Currency.transfer full-gas semantics; empty receive) |
| No inline assembly hardcoding calldata offsets (z0r0z bug) | **PASS** (no `assembly` blocks in file) |

**No HIGH-severity divergence from V4 spec.** The 6 items in the post-fix-finding list are forward-compat / cosmetic / griefing-class, all rated LOW or below per their reachability profiles.

---

## Recommendations (priority order)

1. **Escalate POST-FH-01 for explicit user approval** — drop `pure` from 9 IHooks no-op stubs. This is a 9-line strikethrough, zero state added, perfectly mandate-aligned (DELETE before ADD; canonical-interface alignment). The only mandate-positive open item.
2. **Document operational mitigation for POST-FH-02** in the deploy runbook — captured-owner cancel→propose loop on the permissionless claim path resolves on owner inaction (`expireSyncAccruedFees` permissionless cleanup after 8 days of dormancy).
3. **Re-audit hook flag mask if V4 ever adds bits 14+** (already documented in code at `:214-222`; tracker only).
4. **Re-run the canonical scan after the test-fix commit (`d5ca554`)** to confirm storage layout is unchanged by the test-fix path.
