// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

/// @title  TegridyV4SwapRouter — the "trusted router" that authenticates the user for
///         TegridyV4Hook's per-user premium discount (#2)
/// @notice A V4 hook only sees the router as `sender`, not the end user. TegridyV4Hook
///         therefore honors a user address in `hookData` ONLY when `sender ==
///         trustedRouter`. This router IS that trusted router: it FORCES
///         `hookData = the immediate caller (msg.sender)`, captured before `unlock` —
///         so a swapper can only ever claim the discount for THEIR OWN premium status.
///         Unspoofable. See V4_TRUSTED_ROUTER_DESIGN.md.
///
/// @dev    Settlement logic mirrors v4-core's canonical `PoolSwapTest` (battle-tested):
///         settle the router's negative deltas FROM the user, take the positives TO the
///         recipient. Adds `minOut` + `deadline` slippage, reentrancy guard, native ETH.
///         The user approves THIS router for the ERC20 input (or sends native via msg.value).
///
/// @dev    **UNAUDITED custom V4 router periphery.** Your memory flags the z0r0z V4
///         router $42k loss (assembly trusting a fixed calldata offset) — this router
///         uses no assembly and copies the canonical settlement, but it MUST be audited
///         before use. Behind the V2-launch + audit gate.
contract TegridyV4SwapRouter is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using CurrencyLibrary for Currency;

    IPoolManager public immutable poolManager;

    error DeadlinePassed();
    error TooLittleReceived();
    error NotPoolManager();

    struct CallbackData {
        address user; // authenticated initiator → hookData (grants the discount)
        address recipient; // where output is delivered
        PoolKey key;
        SwapParams params;
        uint256 minOut;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @param recipient destination for the output (address(0) ⇒ the caller).
    /// @param minOut    minimum output amount (slippage floor; exact-input semantics).
    function swap(PoolKey calldata key, SwapParams calldata params, uint256 minOut, uint256 deadline, address recipient)
        external
        payable
        nonReentrant
        returns (BalanceDelta delta)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        address to = recipient == address(0) ? msg.sender : recipient;
        delta = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(msg.sender, to, key, params, minOut))), (BalanceDelta)
        );
        // Refund any over-sent native ETH to the caller (PoolSwapTest pattern).
        uint256 bal = address(this).balance;
        if (bal > 0) CurrencyLibrary.ADDRESS_ZERO.transfer(msg.sender, bal);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));

        // hookData = the authenticated user ⇒ TegridyV4Hook applies the premium discount.
        BalanceDelta delta = poolManager.swap(d.key, d.params, abi.encode(d.user));

        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();

        // Settle what the router owes, pulling from the user.
        if (a0 < 0) d.key.currency0.settle(poolManager, d.user, uint256(uint128(-a0)), false);
        if (a1 < 0) d.key.currency1.settle(poolManager, d.user, uint256(uint128(-a1)), false);

        // Take what the router is owed, to the recipient; track output for slippage.
        uint256 outAmt;
        if (a0 > 0) {
            d.key.currency0.take(poolManager, d.recipient, uint256(uint128(a0)), false);
            outAmt = uint256(uint128(a0));
        }
        if (a1 > 0) {
            d.key.currency1.take(poolManager, d.recipient, uint256(uint128(a1)), false);
            outAmt = uint256(uint128(a1));
        }
        if (outAmt < d.minOut) revert TooLittleReceived();

        return abi.encode(delta);
    }

    receive() external payable {}
}
