# Agent 030 — Approval / Allowance Abuse Audit

**Scope:** `contracts/src/` — every source file (24 contracts plus base/ and lib/).
**Mission:** Hunt for infinite-allowance abuse, long-lived allowances, transferFrom-without-permission, permit signature reuse, ERC20 approve-then-transferFrom front-run, USDT non-zero-to-non-zero `approve` patterns, increase/decreaseAllowance gaps, and router-callback drains.

## Counts

| Pattern                                                  | Count |
|----------------------------------------------------------|-------|
| ERC20 `.approve(` (raw, vulnerable to USDT race)         | **0** |
| `forceApprove(` (SafeERC20 — battle-tested)              | 16    |
| `safeIncreaseAllowance` / `safeDecreaseAllowance`        | 0     |
| Long-lived non-zero allowances persisting across calls   | **0** (every `forceApprove(addr, X)` is paired with reset `forceApprove(addr, 0)`) |
| `safeTransferFrom(IERC20)` — pulls from `msg.sender`     | 41 (all msg.sender, no third-party authority) |
| `IERC721.transferFrom` (NFT, not safe)                   | 6 (TegridyLending + TegridyNFTLending) |
| `IERC721.safeTransferFrom`                               | 17 |
| `permit(` invocations                                     | **0** (no permit sinks anywhere) |
| `DOMAIN_SEPARATOR` in-protocol contracts                 | 0 (only Toweli inherits OZ ERC20Permit; uses canonical name+version) |
| `setApprovalForAll`                                       | 0 |
| `type(uint256).max` allowances                           | 0 (only used as numeric guard / fallback sentinel — not as approval value) |

**Files scanned:** 24 contracts + 2 base + 1 lib.
**Vulnerabilities found:** 0 critical / 0 high / 0 medium / 1 low (advisory) / 1 informational.

---

## Top-Level Verdict

**The Tegridy approval surface is unusually disciplined.** Every external token approval is the exact-amount `forceApprove(router, X)` → swap → `forceApprove(router, 0)` pattern (the OpenZeppelin SafeERC20 `forceApprove` already handles the USDT zero-then-set quirk internally). Token inflows are all `msg.sender`-rooted via `safeTransferFrom(msg.sender, ...)` — no contract takes blanket allowance, no contract ever pulls from a third party, and no contract holds a residual allowance after its swap completes. There is no `permit()` sink anywhere in the protocol, eliminating the entire EIP-2612 replay/cross-contract domain-separator class. The Toweli ERC20 itself uses canonical OZ `ERC20Permit` so its `DOMAIN_SEPARATOR` correctly binds to the Toweli token contract address.

The only patterns worth surfacing are advisory — see below.

---

## ATTACK PATHS

### 1. (LOW / advisory) `IERC721.transferFrom` instead of `safeTransferFrom` on NFT inflows in lending escrow

**Vulnerable contracts:** `TegridyLending.sol` (line 462), `TegridyNFTLending.sol` (line 378).

**Pattern:**
```solidity
IERC721(collateralContract).transferFrom(msg.sender, address(this), _tokenId);
```

**Why this is approval-relevant:** the borrower must have pre-approved the lending contract via `approve(lendingContract, tokenId)` or `setApprovalForAll(lendingContract, true)` before calling `acceptOffer`. If a borrower set `setApprovalForAll(lendingContract, true)` and forgot to revoke, the lending contract holds open-ended permission over every NFT in their wallet for that collection. **However**: the lending contract does not expose any code path that can pull *arbitrary* tokenIds — `acceptOffer` is gated on a fixed `offer.tokenId` chosen at offer creation. So the residual approval cannot be weaponised by the lending contract itself; it could only be weaponised by an attacker who took control of the lending contract, which is gated by `OwnableNoRenounce` + 24-48h timelocks.

**Attack path that *would* matter:** if a future upgrade added a function that pulled an attacker-supplied tokenId from `msg.sender`, an attacker could call it for a victim borrower who had `setApprovalForAll`'d the lending contract. This is a **future-upgrade footgun**, not a live vulnerability.

**Severity:** LOW (advisory only — no live exploit).
**Recommendation:** None for the deployed surface; for any future function that touches NFTs, prefer `safeTransferFrom` + explicit `tokenId`.

### 2. (LOW / advisory) Lending NFT inflow uses `transferFrom` not `safeTransferFrom` — receiver hook bypassed

**Vulnerable contracts:** same as #1.

The lending escrow uses `IERC721(collateralContract).transferFrom(borrower, address(this), tokenId)`, which **does not** invoke `_checkOnERC721Received`. For ERC-721 collections that mandate `safeTransferFrom`-only transfers (e.g., wrapped NFTs, vault-style collections that revert on raw `transferFrom`), the lending integration would simply fail at `acceptOffer` — graceful failure, not an exploit. No silent loss; flagged for completeness.

**Severity:** INFO.

### 3. (INFO) `_chargeExtendFee` in `TegridyStaking.sol` pulls TOWELI via `safeTransferFrom(msg.sender, treasury, fee)` (line 1478)

This requires the position-owner to approve the staking contract for the extend-fee amount before calling `extendLock` / `toggleAutoMaxLock(on)`. Currently `extendFeeBps == 0` by default, making the call a no-op. If governance later raises `extendFeeBps`, users would need to pre-approve. Standard pattern; uses `safeTransferFrom` (USDT-safe), pulls only from `msg.sender`, and forwards the fee directly to treasury — no residual allowance, no third-party pull, no permit. **Not a vulnerability**, just documenting the only `safeTransferFrom` in the codebase that is gated behind a fee that can be turned on.

---

## What I checked and ruled out

* **USDT non-zero-to-non-zero `approve` race (M-12-USDT class):** Eliminated. Every approval site uses `forceApprove`, which under OZ 5.x dispatches to `_callOptionalReturnBool` that first writes 0 then writes the new amount when the token reverts on non-zero-to-non-zero. POLAccumulator / SwapFeeRouter both **explicitly** also reset to 0 after the swap as defense in depth.
* **Front-run race on `approve` then `transferFrom` (the classic ERC-20 race):** Eliminated. No raw `.approve()` calls anywhere in the codebase. Users approve external routers (canonical Uniswap / Tegridy router); those routers immediately consume the allowance in the same tx via the SwapFeeRouter wrapper, so a front-runner cannot widen the window.
* **Long-lived allowances on tokens the contract could sweep:** Eliminated. POLAccumulator's `sweepTokens` explicitly rejects `lpToken` (line 502). SwapFeeRouter's `sweepTokens` reserves `accumulatedTokenFees[token]` (line 1180). No contract holds an allowance on user funds — only on the external router for the duration of one swap.
* **Permit signature reuse / cross-contract DOMAIN_SEPARATOR:** Eliminated. There is no `permit(` consumer anywhere in `contracts/src/`. The only `ERC20Permit` is on the Toweli token itself, which inherits OpenZeppelin's canonical implementation — `DOMAIN_SEPARATOR` correctly binds to the Toweli token address per EIP-712, no replay surface.
* **Router callback drain (`router.swapExactTokensForTokens` re-entering during a callback):** Eliminated. SwapFeeRouter is `nonReentrant`, approves the router for the *exact* swap amount, and resets to 0 immediately after. Even a malicious token's transfer hook re-entering would find allowance = 0 outside the live frame.
* **`increase/decreaseAllowance` race on tokens that don't follow OZ semantics:** N/A — no instances.
* **Operator approval (`setApprovalForAll`) griefing:** N/A — no instances.

---

## Conclusion

The approval surface is the cleanest area I have audited. Every approval is exact-amount, scoped to a single tx, paired with a zero reset, and protected by `nonReentrant`. The only items above LOW are documentation gaps about future upgrades. No live exploitation paths were found.
