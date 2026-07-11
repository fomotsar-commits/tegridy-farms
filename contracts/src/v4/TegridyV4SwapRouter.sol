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
    error TooMuchSpent();
    error NotPoolManager();
    error NativeInputUnderfunded();

    struct CallbackData {
        address user; // authenticated initiator → hookData (grants the discount)
        address recipient; // where output is delivered
        PoolKey key;
        SwapParams params;
        uint256 minOut;
        uint256 maxIn;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @param recipient destination for the output (address(0) ⇒ the caller).
    /// @param minOut    minimum output (slippage floor; matters for exact-input).
    /// @param maxIn     maximum input (slippage ceiling; matters for exact-output —
    ///                  M-1). Pass `type(uint256).max` to disable.
    function swap(
        PoolKey calldata key,
        SwapParams calldata params,
        uint256 minOut,
        uint256 maxIn,
        uint256 deadline,
        address recipient
    ) external payable nonReentrant returns (BalanceDelta delta) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        address to = recipient == address(0) ? msg.sender : recipient;
        // L-1: snapshot any pre-existing/stuck ETH so the refund below returns ONLY
        //      this call's unspent native, never balances that aren't the caller's.
        uint256 preBal = address(this).balance - msg.value;
        delta = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(msg.sender, to, key, params, minOut, maxIn))), (BalanceDelta)
        );
        uint256 bal = address(this).balance;
        // econ-batch-3 [Low]: enforce native-balance conservation. `CurrencySettler.settle`
        // sources native input from `address(this).balance` and IGNORES the payer arg — so a
        // native-input swap could otherwise be funded from pre-existing/stuck ETH the router
        // happens to hold (a caller passing msg.value < the native settled would drain it).
        // `bal < preBal` means exactly that: this call's settlement dipped below the caller's
        // own contribution (preBal = balance excluding msg.value). Forbid it. Honest swaps
        // satisfy bal >= preBal (exact-spend: bal == preBal; exact-output leftover: bal > preBal,
        // refunded below).
        if (bal < preBal) revert NativeInputUnderfunded();
        if (bal > preBal) CurrencyLibrary.ADDRESS_ZERO.transfer(msg.sender, bal - preBal);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));

        // hookData = the authenticated user ⇒ TegridyV4Hook applies the premium discount.
        BalanceDelta delta = poolManager.swap(d.key, d.params, abi.encode(d.user));

        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();

        // Settle what the router owes, pulling from the user; track input for slippage.
        // AUDIT 2026-05-31 [slither uninitialized-local FP]: default-0 is the intended value —
        // if neither currency is owed, `inAmt` stays 0 and the `inAmt > maxIn` ceiling passes
        // correctly (0 spent never exceeds the cap).
        // slither-disable-next-line uninitialized-local
        uint256 inAmt;
        if (a0 < 0) {
            d.key.currency0.settle(poolManager, d.user, uint256(uint128(-a0)), false);
            inAmt = uint256(uint128(-a0));
        }
        if (a1 < 0) {
            d.key.currency1.settle(poolManager, d.user, uint256(uint128(-a1)), false);
            inAmt = uint256(uint128(-a1));
        }

        // Take what the router is owed, to the recipient; track output for slippage.
        // AUDIT 2026-05-31 [slither uninitialized-local FP]: default-0 is the intended value —
        // if no output is owed, `outAmt` stays 0 and the `outAmt < minOut` floor correctly
        // reverts (received nothing → fails the slippage check).
        // slither-disable-next-line uninitialized-local
        uint256 outAmt;
        if (a0 > 0) {
            d.key.currency0.take(poolManager, d.recipient, uint256(uint128(a0)), false);
            outAmt = uint256(uint128(a0));
        }
        if (a1 > 0) {
            d.key.currency1.take(poolManager, d.recipient, uint256(uint128(a1)), false);
            outAmt = uint256(uint128(a1));
        }
        if (outAmt < d.minOut) revert TooLittleReceived(); // exact-input slippage floor
        if (inAmt > d.maxIn) revert TooMuchSpent(); // M-1: exact-output slippage ceiling

        return abi.encode(delta);
    }

    receive() external payable {}
}
