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

    /// @notice AUDIT FIX: DEEP-LIB-L1 — emitted on the success path of
    ///         `safeTransferETHOrWrap` when the raw 10k-gas ETH `.call`
    ///         succeeds. Mirrors `ETHToWETHFallback` so off-chain indexers
    ///         always see a positive ack regardless of which leg delivered
    ///         the funds. Without this, indexers had to infer "ETH was paid"
    ///         from the absence of a fallback event, which is fragile against
    ///         dropped log subscriptions.
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
    /// @dev AUDIT FIX H-02: Uses a limited gas stipend (10000) for the raw ETH transfer to prevent
    ///      cross-contract reentrancy. A malicious recipient with full gas forwarding could re-enter
    ///      OTHER protocol contracts during the callback. The 10000 gas stipend allows receive()/fallback()
    ///      to emit events and perform basic logging but prevents complex external calls.
    ///      If the limited-gas transfer fails (e.g., recipient needs more gas), falls back to WETH.
    function safeTransferETHOrWrap(address weth, address to, uint256 amount) internal {
        if (amount == 0) return;
        // AUDIT FIX: DEEP-LIB-H1 — fail-closed on zero recipient. The
        // amount==0 short-circuit above stays first since a no-op transfer
        // is harmless; once we know we're moving real value, the destination
        // MUST be non-zero or we'd burn ETH (raw `.call` to 0x0 succeeds).
        if (to == address(0)) revert ZeroRecipient();
        if (weth == address(0)) revert ZeroWETHAddress();

        // AUDIT FIX H-02: Limited gas stipend prevents cross-contract reentrancy.
        // 10000 gas is enough for receive() + event emit but not external calls.
        (bool ok,) = to.call{value: amount, gas: 10000}("");
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
    /// @dev AUDIT FIX: DEEP-LIB-M2 — applies the same 10000-gas stipend used
    ///      by `safeTransferETHOrWrap` so this variant cannot be a
    ///      cross-contract reentrancy primitive either. The "EOA refunds only"
    ///      claim in the docstring above is unenforceable on-chain (Solidity
    ///      can't distinguish EOAs from contracts at the call site), so the
    ///      stipend MUST be applied here as the structural defense. Callers
    ///      that need higher gas budgets should use `safeTransferETHOrWrap`.
    function safeTransferETH(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (to == address(0)) revert ZeroRecipient();
        (bool ok,) = to.call{value: amount, gas: 10000}("");
        if (!ok) revert ETHTransferFailed();
        // AUDIT FIX: V2-LIB-L3 — emit the same success-path event as
        // `safeTransferETHOrWrap` so off-chain accounting infrastructure
        // sees a consistent breadcrumb regardless of which variant the
        // caller picked. Without this, a future caller that explicitly
        // chooses the no-fallback variant (e.g. an EOA-only refund path)
        // silently regresses the L1 accounting promise.
        emit ETHTransferred(to, amount);
    }
}
