# Agent 66 — ERC20 Approve Race Conditions (Fresh-Eyes Audit)

**Lens:** ERC20 approve race condition surface across all `contracts/src/` Solidity sources.
**Date:** 2026-05-07
**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`

---

## Scope of analysis

I audited every `approve` / `_approve` / `safeApprove` / `forceApprove` /
`increaseAllowance` / `decreaseAllowance` / `permit` call site in the protocol
sources, with four classic exploit lenses:

1. **Classic A→B race** — non-zero to non-zero allowance change without zero
   reset; spender frontruns the new approval to spend `A + B`.
2. **`approveMax` then `approveSmall` race** — protocol grants infinite/large
   allowance, then later restricts it; spender drains during the window.
3. **Token-router pattern with arbitrary tokens** — user-supplied
   `path[0]` could be USDT (which reverts on non-zero → non-zero `approve`).
4. **Permit replacing approve** — EIP-2612 `permit` overwriting an existing
   allowance creates the same A→B frontrun window as raw `approve`.

---

## Approve call-site inventory (protocol-internal)

All 18 protocol-internal approval call sites use OpenZeppelin
`SafeERC20.forceApprove`:

| File | Lines | Pattern |
|---|---|---|
| `POLAccumulator.sol` | 441, 475 | `toweli.forceApprove(router, X)` → addLiquidityETH → `forceApprove(router, 0)` |
| `POLAccumulator.sol` | 680, 685 | `IERC20(lpToken).forceApprove(router, X)` → removeLiquidityETH → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 754, 771 | `IERC20(path[0]).forceApprove(router, X)` → swapExactTokensForETH → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 829, 832 | `IERC20(path[0]).forceApprove(router, X)` → swapExactTokensForTokens → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 948, 956 | `IERC20(path[0]).forceApprove(router, X)` → FoT-ETH variant → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 1009, 1019 | `IERC20(path[0]).forceApprove(router, X)` → FoT-Token variant → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 1584, 1594 | `IERC20(token).forceApprove(router, X)` → convertTokenFeesToETH → `forceApprove(router, 0)` |
| `SwapFeeRouter.sol` | 1692, 1701 | `IERC20(token).forceApprove(router, X)` → convertTokenFeesToETHFoT → `forceApprove(router, 0)` |
| `TegridyFeeHook.sol` | 598, 609 | `IERC20(currency).forceApprove(router, X)` → swapExactTokensForETH → `forceApprove(router, 0)` |

Token-side `_approve` callers:

| File | Lines | Caller |
|---|---|---|
| `Toweli.sol` | 200, 229 | `permit()` overrides — EOA path and SCW path |

**No usages of**: `approve(...)` (raw), `safeApprove(...)` (deprecated),
`increaseAllowance(...)`, `decreaseAllowance(...)`, or any in-protocol
`.permit(...)` call. (The only matches for `permit` outside Toweli are NatSpec
mentions of EIP-2612 for documentation purposes, not call sites.)

---

## Findings

### F-66-1 — `forceApprove` neutralizes USDT non-zero→non-zero revert (NOT A FINDING — defensive note)

OZ `SafeERC20.forceApprove` (as imported at every call site) implements a
two-stage retry:

```
function forceApprove(IERC20 token, address spender, uint256 value) internal {
    if (!_safeApprove(token, spender, value, false)) {
        if (!_safeApprove(token, spender, 0, true)) revert ...
        if (!_safeApprove(token, spender, value, true)) revert ...
    }
}
```

This means *every* in-protocol approve correctly handles USDT-style tokens
that revert on non-zero → non-zero `approve`. The token-router pattern at
`SwapFeeRouter.swap*` (where `path[0]` is user-controlled and could be USDT)
is therefore safe.

**Status:** No vulnerability. Documenting that the USDT/Tether router-token
race vector is closed by `forceApprove`.

---

### F-66-2 — Approve → spend → revoke is atomic (NOT A FINDING — defensive note)

Every `forceApprove(router, X)` in the protocol is followed in the SAME
transaction by:
1. The router call that consumes the allowance (e.g. `swapExactTokensForETH`,
   `addLiquidityETH`, `removeLiquidityETH`).
2. A trailing `forceApprove(router, 0)` that wipes any residual allowance.

Examples confirmed at:
- `POLAccumulator.accumulateETH` (lines 441 → 464 → 475)
- `POLAccumulator.harvestPOL` (lines 680 → 682 → 685)
- `SwapFeeRouter.swapExactTokensForETH` (lines 754 → 768 → 771)
- `SwapFeeRouter.swapExactTokensForTokens` (lines 829 → 830 → 832)
- All four FoT variants (lines 948→951→956, 1009→1014→1019)
- All conversion variants (lines 1584→1590→1594, 1692→1695→1701)
- `TegridyFeeHook.convertERC20FeesToETH` (lines 598 → 600-606 → 609)

Because the entire approve-spend-revoke cycle is atomic within a single
transaction, the classic A→B frontrun race window does NOT exist between
two protocol invocations. An attacker cannot insert a `transferFrom` between
the approve and revoke because they are bracketed by atomic execution.

The only frontrun surface would be at the `forceApprove(0)` boundary if
the allowance LEAKED out of the function — but the trailing zero-revoke
guarantees that if execution reaches that line, allowance becomes 0 before
returning.

**Status:** No vulnerability. The approve → spend → revoke pattern is
the textbook "ephemeral allowance" mitigation and is correctly applied.

---

### F-66-3 — Reverting router during atomic approve cycle leaves allowance dangling (LOW / accepted by design)

**File / lines:** All `forceApprove`+swap+`forceApprove(0)` triples (see inventory above).

**Race window:** If the router call between `forceApprove(spender, X)` and
`forceApprove(spender, 0)` reverts, the trailing zero-revoke is never
executed. However, EVM atomic semantics mean the entire transaction reverts
and ALL state changes (including the initial `forceApprove(spender, X)`)
roll back. The allowance is restored to its pre-tx value.

**Exploit:** None. EVM atomicity means a reverting swap does NOT leak
allowance — the revert un-does the approval. This is not exploitable.

**Status:** Not a finding. Documenting completeness.

---

### F-66-4 — Toweli `permit` overwrites without nonce-cancel of pending approve (LOW — standard EIP-2612 known limitation)

**File / lines:** `Toweli.sol:149-230` (`permit` override).

**Race window:**
- User has existing allowance `allowance(owner, spender) = A`.
- User signs a permit changing it to `B` (via `permit(owner, spender, B, ...)`).
- Spender observes the permit signature in mempool.
- Spender calls `transferFrom(owner, ..., A)` — drains the existing allowance.
- Spender's transaction lands first.
- The permit then lands and `_approve(owner, spender, B)` overwrites the
  (now-zero) allowance with B.
- Spender calls `transferFrom(owner, ..., B)` — drains the new allowance.
- Net: spender drained `A + B` instead of intended `B`.

**Why this is the EIP-2612 known-limitation, not a Tegridy bug:**

This is the canonical, well-documented behavior of OpenZeppelin's
`ERC20Permit`. Toweli's override re-implements OZ's logic faithfully (with
ERC-1271 / SCW support added) and deliberately preserves the standard
permit semantics so wagmi/ethers/viem signing tooling continues to work.

The race exists in EVERY EIP-2612 token (USDC, DAI, sDAI, every OZ-derived
token). The protocol-level mitigation is "users should not chain
`approve(A)` → `permit(B)` against the same untrusted spender." Tegridy
inherits this standard limitation.

**Why no fix is appropriate at the contract level:**
- Adding "must be zero before non-zero" semantics would break wagmi/ethers
  permit flows (they assume standard EIP-2612 over-write semantics).
- The only contract-level mitigation that preserves wallet UX is to make
  permit use `value - currentAllowance` semantics — which would diverge
  from the spec and break every existing client integration.
- Attack requires the user to ALREADY have a non-zero allowance with a
  malicious spender — the user's prior approve was the original mistake.

**Exploit:** Possible only if (a) user had a non-zero allowance, AND
(b) the spender is malicious / monitoring mempool, AND (c) the user signs
a permit replacing that allowance. Mitigated entirely by user-side
discipline (set allowance to 0 first, or use unique spenders).

**Severity:** Informational. Standard EIP-2612 limitation, not a
Tegridy-specific bug. No code change needed.

---

### F-66-5 — `_approve` in Toweli always over-writes, never sums (NOT A FINDING)

**File / lines:** `Toweli.sol:200`, `Toweli.sol:229`.

The two `_approve` calls in Toweli's `permit` override pass `value`
directly (the permit's signed value) — not `value + existing`. This
is correct EIP-2612 semantics. OZ's underlying `_approve(owner, spender, value)`
performs an unconditional overwrite of `allowance[owner][spender] = value`.

This means the permit cannot be replayed for additive effect (each permit
also burns a nonce via `_useNonce(owner)` on line 163). Replay protection
is intact.

**Status:** No vulnerability.

---

### F-66-6 — User-side approves to TegridyStaking / TegridyLending / etc. (OUT OF SCOPE)

**Files:** `TegridyStaking.sol`, `TegridyLending.sol`, `TegridyRestaking.sol`,
`VoteIncentives.sol`, `CommunityGrants.sol`, `PremiumAccess.sol`,
`TegridyNFTLending.sol`, `TegridyNFTPool.sol`, `TegridyNFTPoolFactory.sol`,
`TegridyLPFarming.sol`, `TegridyRouter.sol`, `TegridyStakingJbacVault.sol`.

These contracts call `safeTransferFrom(user, ..., amount)` — they require
the USER to pre-approve the protocol contract. The user's approve flow is
outside protocol control, and the protocol contract is the spender. There
is no protocol-side approve race here; only the user's own approve flow,
which is governed by the user's wallet (and any A→B race at user-side is a
wallet UX issue, not a protocol bug).

**Status:** Out of scope. These are legitimate user-funded approvals; the
race vector exists only at the user's wallet, not in protocol code.

---

## Summary

| Category | Result |
|---|---|
| Classic A→B race (non-zero → non-zero approve) | **CLOSED** — `forceApprove` retries with zero on USDT-style revert; every approve is followed by atomic spend + zero-revoke |
| `approveMax` then `approveSmall` race | **NOT PRESENT** — protocol never grants infinite or persistent approvals; every approve is exact-amount and revoked in same tx |
| Token-router pattern with arbitrary tokens (USDT) | **CLOSED** — `forceApprove` handles USDT non-zero→non-zero revert correctly at every router-token call site |
| Permit replacing approve race | **STANDARD EIP-2612 LIMITATION** — Toweli's `permit` follows OZ semantics; race exists in every EIP-2612 token, mitigated by user-side discipline only |

**No Tegridy-specific approve race vulnerabilities found.**
The protocol uses the textbook "ephemeral allowance" pattern
(forceApprove → spend → forceApprove(0)) at every internal approve site,
and every site uses OZ's hardened `forceApprove` which closes the USDT
non-zero→non-zero edge case.

The only outstanding race vector is the standard EIP-2612 permit
front-run (F-66-4), which is a known limitation of the EIP and not a
Tegridy-specific bug. Mitigation lives at the user/wallet layer
(zeroing existing allowances before signing a new permit), not in the
contract.

---

## Notes / dead ends

- Initial broad grep for "approve" returned 138 hits, but ~120 of them were
  false positives in NatSpec governance prose ("approved proposals",
  "approved callers"). Filtered with regex `\.approve\(|\.forceApprove\(...`
  to surface real call sites only.
- TegridyPair.sol has its own ERC20 implementation (LP token) inheriting
  standard OZ ERC20 — its `approve()` surface is the standard library
  implementation, no override that could introduce a race.
- TegridyDropV2 uses NFT `approve()` (ERC-721), not ERC-20. The IERC721
  approve-race vector (different from ERC-20) was not in scope per
  agent prompt; flagging as a non-finding for clarity.
- ReferralSplitter's `approvedCallers` mapping is a governance ACL term,
  not an ERC-20 approve.

---

## Format

Findings indexed F-66-1 through F-66-6.
- F-66-1, F-66-2, F-66-3, F-66-5: defensive notes (no vulnerability).
- F-66-4: low-severity informational on standard EIP-2612 limitation.
- F-66-6: out-of-scope user-flow note.
