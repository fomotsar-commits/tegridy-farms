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
        if (weth == address(0)) revert ZeroWETHAddress();

        // AUDIT FIX H-02: Limited gas stipend prevents cross-contract reentrancy.
        // 10000 gas is enough for receive() + event emit but not external calls.
        (bool ok,) = to.call{value: amount, gas: 10000}("");
        if (ok) return;

        // Fallback: wrap as WETH and send the ERC20 token
        IWETH(weth).deposit{value: amount}();
        bool sent = IWETH(weth).transfer(to, amount);
        if (!sent) revert WETHTransferFailed();
    }

    /// @notice Transfer ETH to `to` without WETH fallback. Reverts on failure.
    /// @dev Use this when WETH fallback is not desired (e.g., refunds to EOAs).
    function safeTransferETH(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ETHTransferFailed();
    }
}
