// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal WETH interface — deposit ETH and transfer as WETH.
///         Shared across all contracts that need WETH fallback.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title WETHFallbackLib — Safe ETH transfer with automatic WETH fallback
/// @notice Pattern used by 5+ Tegriddy contracts (Router, SwapFeeRouter, Grants, Bounty, Referral).
///         Previously each contract defined its own IWETH interface variant and fallback logic.
///
/// Source patterns:
///  - Solmate SafeTransferLib (Uniswap V3/V4, Seaport)
///  - WETH fallback pattern from Aave V3, Convex
///
/// @dev Attempts a raw ETH transfer first. If the recipient reverts (e.g., a contract without
///      receive()), wraps the ETH as WETH and sends the WETH token instead.
///      This prevents funds from getting stuck when the recipient is a contract.
library WETHFallbackLib {
    error ETHTransferFailed();
    error WETHTransferFailed();
    error ZeroWETHAddress();
    /// @dev AUDIT FIX: DEEP-LIB-H1 — recipient cannot be the zero address.
    ///      Without this guard, a raw `to.call{value:..., gas:10000}("")`
    ///      against `address(0)` succeeds and silently BURNS the ETH (the EVM
    ///      lets you "send" ETH to 0x0). The lib then returned without a
    ///      revert, lying to callers that the transfer succeeded. Solmate's
    ///      SafeTransferLib reverts on failed transfer — the silent-burn here
    ///      was a structural divergence that turned every caller into a
    ///      latent ETH-burn primitive if the destination ever resolved to 0.
    error ZeroRecipient();

    // ─── AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — stipend constant ────────
    /// @notice AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — gas stipend for the
    ///         raw ETH `.call` leg of `safeTransferETHOrWrap` /
    ///         `safeTransferETHOrWrapNoRevert` / `safeTransferETH`.
    ///         Bumped from 10_000 → 30_000 to accommodate the cold-storage
    ///         SSTORE pattern at first-ingress sites (RevenueDistributor /
    ///         SwapFeeRouter / POLAccumulator `receive()` updates a cumulative
    ///         counter and emits LOG2 — the zero→non-zero SSTORE alone costs
    ///         22_100 gas under EIP-2929/2200, exceeding the prior 10k floor
    ///         and silently flipping the path to WETH wrap on every fresh
    ///         deploy). 30k matches the Aerodrome / Bunni v2 distributor-
    ///         style receiver budget cushion (cold SLOAD 2100 + zero→non-zero
    ///         SSTORE 22100 + LOG2 ~1750 + dispatch overhead, with ~4k
    ///         cushion for compiler-generated boilerplate).
    /// @dev    Defense-in-depth against cross-contract reentrancy is
    ///         preserved: 30k is still far below any "complex external call"
    ///         budget (a single CALL opcode alone burns 700g + ~2.5k for
    ///         arg copy on top of any callee work); the canonical "no
    ///         external calls from receive" invariant is preserved.
    uint256 internal constant ETH_TRANSFER_GAS_STIPEND = 30_000;

    /// @notice AUDIT FIX: DEEP-LIB-L1 — emitted on the success path of
    ///         `safeTransferETHOrWrap` when the raw ETH `.call` succeeds.
    ///         Mirrors `ETHToWETHFallback` so off-chain indexers always see
    ///         a positive ack regardless of which leg delivered the funds.
    ///         Without this, indexers had to infer "ETH was paid" from the
    ///         absence of a fallback event, which is fragile against dropped
    ///         log subscriptions.
    event ETHTransferred(address indexed to, uint256 amount);

    /// @notice AUDIT MICROSCOPE_2026_04_30 H21: emitted whenever the raw 10k-gas ETH
    ///         send fails and the library wraps the amount as WETH instead. Indexers,
    ///         downstream accounting, and recipient contracts can subscribe to this
    ///         event to detect the asymmetric asset-type degradation. Without it,
    ///         a recipient contract whose `receive()` outgrew the 10k stipend would
    ///         silently start receiving WETH instead of ETH — every protocol caller
    ///         would inherit the inconsistency without any on-chain breadcrumb.
    event ETHToWETHFallback(address indexed weth, address indexed to, uint256 amount);

    /// @notice Transfer ETH to `to`. If the raw ETH send fails, wraps as WETH and sends that.
    /// @param weth The canonical WETH contract address for this chain (must be set immutably at deploy time)
    /// @param to   Recipient address
    /// @param amount Wei to transfer
    /// @dev SECURITY: The `weth` parameter MUST be a trusted, immutable address set in the constructor.
    ///      Never pass user-supplied or dynamic WETH addresses — a malicious WETH could re-enter via deposit().
    /// @dev AUDIT FIX FRESH-2026: M-37 [F-40-WFL-4] — `weth` is parametric on
    ///      purpose so the lib stays reusable; the relaunch is the right
    ///      moment to canonicalize per-deployment, NOT in the lib. Consumers
    ///      MUST verify `weth` ABI shape AND store it as `immutable` after
    ///      constructor verification (every in-tree consumer already does
    ///      this — RevenueDistributor.weth, SwapFeeRouter.WETH,
    ///      TegridyFeeHook.WETH, MemeBountyBoard.weth, ReferralSplitter.weth,
    ///      TegridyLending.weth, POLAccumulator.weth, CommunityGrants.weth,
    ///      TegridyNFTPool.weth). Pass-through here is sufficient defense-
    ///      in-depth for the lib boundary.
    /// @dev AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — gas stipend bumped
    ///      from 10_000 → ETH_TRANSFER_GAS_STIPEND (30_000). A cold-storage
    ///      SSTORE in a first-ingress receiver costs 22_100g under
    ///      EIP-2929/2200; the prior 10k floor silently fell through to the
    ///      WETH wrap path on every fresh ingress to RevenueDistributor /
    ///      SwapFeeRouter / POLAccumulator. Reentrancy defense preserved
    ///      (still far below any external CALL budget).
    function safeTransferETHOrWrap(address weth, address to, uint256 amount) internal {
        if (amount == 0) return;
        // AUDIT FIX: DEEP-LIB-H1 — fail-closed on zero recipient. The
        // amount==0 short-circuit above stays first since a no-op transfer
        // is harmless; once we know we're moving real value, the destination
        // MUST be non-zero or we'd burn ETH (raw `.call` to 0x0 succeeds).
        if (to == address(0)) revert ZeroRecipient();
        if (weth == address(0)) revert ZeroWETHAddress();

        // AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — 30k stipend (was 10k).
        // Reentrancy defense preserved (still far below external-call budget);
        // the bump accommodates first-ingress cold-SSTORE cost.
        (bool ok,) = to.call{value: amount, gas: ETH_TRANSFER_GAS_STIPEND}("");
        if (ok) {
            // AUDIT FIX: DEEP-LIB-L1 — symmetric success-path event so
            // off-chain indexers see ETH-delivered breadcrumbs regardless
            // of which leg (raw call vs WETH wrap) handled the transfer.
            emit ETHTransferred(to, amount);
            return;
        }

        // Fallback: wrap as WETH and send the ERC20 token
        IWETH(weth).deposit{value: amount}();
        bool sent = IWETH(weth).transfer(to, amount);
        if (!sent) revert WETHTransferFailed();
        emit ETHToWETHFallback(weth, to, amount);
    }

    /// @notice Transfer ETH to `to` without WETH fallback. Reverts on failure.
    /// @dev Use this when WETH fallback is not desired (e.g., refunds to EOAs).
    /// @dev AUDIT FIX: DEEP-LIB-H1 — reverts on `to == address(0)` to prevent
    ///      silent ETH burn (mirror of the `safeTransferETHOrWrap` guard
    ///      above — same structural defense against future-importer omission).
    /// @dev AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — gas stipend bumped
    ///      to 30k for parity with `safeTransferETHOrWrap`. Same first-
    ///      ingress / cold-SSTORE rationale; reentrancy defense preserved.
    function safeTransferETH(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (to == address(0)) revert ZeroRecipient();
        // AUDIT FIX FRESH-2026: M-36 [F-40-WFL-1] — 30k stipend (was 10k).
        (bool ok,) = to.call{value: amount, gas: ETH_TRANSFER_GAS_STIPEND}("");
        if (!ok) revert ETHTransferFailed();
        // AUDIT FIX: V2-LIB-L3 — emit the same success-path event as
        // `safeTransferETHOrWrap` so off-chain accounting infrastructure
        // sees a consistent breadcrumb regardless of which variant the
        // caller picked. Without this, a future caller that explicitly
        // chooses the no-fallback variant (e.g. an EOA-only refund path)
        // silently regresses the L1 accounting promise.
        emit ETHTransferred(to, amount);
    }

    // AUDIT FIX FRESH-2026 [H-WFL-NOREVERT-DELETE]: deleted dead-code
    // `safeTransferETHOrWrapNoRevert(weth, to, amount)` + its supporting
    // `WETHTransferStuck` / `ETHWrapFailed` events.
    //
    // Rationale: function had ZERO in-tree consumers (verified by grep
    // across src/, script/, test/). The mode==2 "stranded-WETH-in-caller"
    // path obligated callers to credit/sweep stranded WETH; future
    // consumers reaching for the no-revert variant would inherit a
    // documented-but-unenforced caller-discipline trap. Per the minimal-
    // surface mandate (DELETE before ADD, custom code IS the exploit
    // source), the safer path is to remove the unused function entirely.
    //
    // If a future BATCHED-PAYEE callsite needs the no-revert semantic, it
    // can be reintroduced from a battle-tested pattern (Aave V3
    // PoolAddressesProvider treasury sweep / Seaport's WETH wrap fallback)
    // with consumer-local tests proving the caller credits the stranded
    // path correctly — rather than reviving dead code lulled by sunk-cost
    // comment archaeology.
    //
    // Surviving callers use `safeTransferETHOrWrap` (reverting; widely
    // adopted across RevenueDistributor / SwapFeeRouter / POLAccumulator /
    // ReferralSplitter / etc) or `safeTransferETH` (EOA refund variant).
}
