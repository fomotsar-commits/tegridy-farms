// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";

/// @dev Minimal PoolManager stub — TegridyFeeHook only checks `msg.sender == poolManager`
///      in `afterSwap`. We don't exercise `take()` here; the hook logic under test only
///      computes feeAmount + accruedFees + return delta, all internal.
contract MockPoolManagerR031 {
    function take(Currency, address, uint256) external pure {}
}

/// @title R031 — TegridyFeeHook V4 hook semantics + sync cooldown
/// @notice DRIFT (RC10): the R031 design (uniform unspecified-leg derivation +
///         `deploymentTime` cooldown anchor) was deferred. The current contract
///         derives fee SIZE from input on exact-output / output on exact-input,
///         and CURRENCY from the unspecified leg. The cooldown anchors against
///         `lastSyncExecuted` only (no genesis floor). Tests below pin the
///         CURRENT behavior so future drift is caught.
contract R031_TegridyFeeHook is Test {
    TegridyFeeHook hook;
    MockPoolManagerR031 mockPM;

    address constant HOOK_ADDR = address(uint160(0xCAFE0044));

    address constant TOKEN0 = address(uint160(0x1111));
    address constant TOKEN1 = address(uint160(0x2222));
    Currency CURRENCY0 = Currency.wrap(TOKEN0);
    Currency CURRENCY1 = Currency.wrap(TOKEN1);

    address owner = address(0xA110);
    address distributor = address(0xD157);

    function setUp() public {
        mockPM = new MockPoolManagerR031();
        deployCodeTo(
            "TegridyFeeHook.sol:TegridyFeeHook",
            abi.encode(IPoolManager(address(mockPM)), distributor, uint256(30), owner),
            HOOK_ADDR
        );
        hook = TegridyFeeHook(payable(HOOK_ADDR));
    }

    function _mkKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: CURRENCY0,
            currency1: CURRENCY1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    // Exact-output, zeroForOne=true: input = currency0 (positive delta), output = currency1.
    // Current contract: fee size from |amount0|; credit currency = currency0 per its own
    // resolution (`specifiedIsZero = (false == true) = false` → creditCurrency = currency0).
    // i.e. the contract credits the INPUT (currency0) for exact-output ZFO=true.
    function test_afterSwap_ExactOutput_ZeroForOne_CreditsCurrentBehavior() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: int256(1_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(2_000_000), int128(-1_000_000));

        vm.prank(address(mockPM));
        (bytes4 sel, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(sel, IHooks.afterSwap.selector, "selector mismatch");
        assertEq(int256(feeAmount), int256(6_000), "fee size from |amount0|");
        // Per current contract resolution: credit goes to currency0 (input side).
        assertEq(hook.accruedFees(TOKEN0), 6_000, "credit on TOKEN0 (current contract)");
        assertEq(hook.accruedFees(TOKEN1), 0, "TOKEN1 not credited");
    }

    // Exact-output, zeroForOne=false: input = currency1, output = currency0.
    // specifiedIsZero = (false == false) = true → creditCurrency = currency1.
    function test_afterSwap_ExactOutput_OneForZero_CreditsCurrentBehavior() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: false,
            amountSpecified: int256(500_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(-500_000), int128(1_000_000));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(int256(feeAmount), int256(3_000), "fee size from |amount1|");
        assertEq(hook.accruedFees(TOKEN1), 3_000, "credit on TOKEN1 (current contract)");
        assertEq(hook.accruedFees(TOKEN0), 0, "TOKEN0 not credited");
    }

    // Exact-input, zeroForOne=true: input = currency0, output = currency1.
    // specifiedIsZero = (true == true) = true → creditCurrency = currency1.
    function test_afterSwap_ExactInput_ZeroForOne_CreditsCurrentBehavior() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(1_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(1_000_000), int128(-2_000_000));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(int256(feeAmount), int256(6_000), "fee size from |amount1|");
        assertEq(hook.accruedFees(TOKEN1), 6_000, "credit on TOKEN1 (output / unspecified)");
        assertEq(hook.accruedFees(TOKEN0), 0, "TOKEN0 not credited");
    }

    // First-ever sync: cooldown anchor is `lastSyncExecuted[TOKEN1] = 0`, so the
    // require is `block.timestamp >= 0 + 7 days = 7 days`. Foundry's default
    // chain start is block.timestamp = 1, so we must warp past 7 days first.
    // (Without the deferred `deploymentTime` anchor, this is the actual gate.)
    function test_executeSyncAccruedFees_FirstCallCurrentBehavior() public {
        // Warp past the 7-day floor before any state mutations so the propose timer
        // is fresh.
        vm.warp(7 days + 1);

        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(10_000_000), int128(-20_000_000));
        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 50_000);

        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);
        assertEq(hook.accruedFees(TOKEN1), 50_000, "sync landed");
        assertEq(hook.lastSyncExecuted(TOKEN1), block.timestamp, "lastSyncExecuted updated");
    }

    // Second sync MUST wait the 7-day cooldown after the first.
    function test_executeSyncAccruedFees_SecondCallRespectsCooldown() public {
        vm.warp(7 days + 1);

        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(10_000_000), int128(-20_000_000));
        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 50_000);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);

        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 40_000);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(owner);
        vm.expectRevert(bytes("SYNC_COOLDOWN"));
        hook.executeSyncAccruedFees(TOKEN1);

        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);
        assertEq(hook.accruedFees(TOKEN1), 40_000, "second sync after cooldown");
    }
}
