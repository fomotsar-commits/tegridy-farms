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

/// @title R031 — TegridyFeeHook V4 hook semantics + first-sync cooldown
/// @notice Validates the H-1/H-2/M-3 fixes:
///         - afterSwap returns int128 in the UNSPECIFIED currency (V4 spec)
///         - accruedFees is keyed on the same UNSPECIFIED currency (no bucket drift)
///         - First-ever executeSyncAccruedFees still respects the 7-day cooldown
contract R031_TegridyFeeHook is Test {
    TegridyFeeHook hook;
    MockPoolManagerR031 mockPM;

    // CREATE2-mined hook addresses must satisfy `addr & 0x0044 == 0x0044`. We deploy via
    // `vm.etch` to a constant address with the right bit pattern instead of mining a salt.
    address constant HOOK_ADDR = address(uint160(0xCAFE0044));

    // Token addresses encoded as currencies. Currency0 < Currency1 by V4 convention.
    address constant TOKEN0 = address(uint160(0x1111));
    address constant TOKEN1 = address(uint160(0x2222));
    Currency CURRENCY0 = Currency.wrap(TOKEN0);
    Currency CURRENCY1 = Currency.wrap(TOKEN1);

    address owner = address(0xA110);
    address distributor = address(0xD157);

    function setUp() public {
        mockPM = new MockPoolManagerR031();
        // The TegridyFeeHook constructor enforces `uint160(address(this)) & 0x0044 == 0x0044`.
        // Use forge-std's `deployCodeTo` to deploy WITH constructor execution at HOOK_ADDR,
        // which has the right bit pattern. This runs the constructor at a target address
        // (combining vm.etch with constructor args) — the canonical V4 hook test pattern.
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

    // ─────────────────────────────────────────────────────────────────────
    // H-1 / H-2: fee returned + accrued in UNSPECIFIED currency for exact-output
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Exact-output, zeroForOne=true.
    ///   - amountSpecified > 0  → exact-output (specified leg = output = currency1)
    ///   - zeroForOne = true    → user pays currency0, receives currency1
    ///   - specifiedTokenIs0 = (false == true) = false → unspecified is currency0 (input)
    ///   - delta layout: amount0 < 0 (paid), amount1 > 0 (received specified amount)
    ///   - Fee SIZE must derive from |amount0| (unspecified leg)
    ///   - Fee CURRENCY (accruedFees key) must be currency0
    function test_afterSwap_ExactOutput_FeeAppliedToUnspecified() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: int256(1_000_000), // exact-output, want 1M of currency1
            sqrtPriceLimitX96: 0
        });
        // For exact-output zeroForOne: amount0 < 0 (paid), amount1 > 0 (received)
        // Use round numbers to make fee math obvious: |amount0|=2_000_000 → fee = 2M*30/10000 = 6_000
        BalanceDelta delta = toBalanceDelta(int128(-2_000_000), int128(1_000_000));

        vm.prank(address(mockPM));
        (bytes4 sel, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(sel, IHooks.afterSwap.selector, "selector mismatch");
        // Fee size: 6000 (2_000_000 * 30 / 10000)
        assertEq(int256(feeAmount), int256(6_000), "fee size must come from unspecified leg |amount0|");
        // Fee currency credited: TOKEN0 (the unspecified/input currency)
        assertEq(hook.accruedFees(TOKEN0), 6_000, "accruedFees must credit unspecified currency (TOKEN0)");
        assertEq(hook.accruedFees(TOKEN1), 0, "specified currency (TOKEN1) must NOT be credited");
    }

    /// @notice Exact-output, zeroForOne=false.
    ///   - amountSpecified > 0 → exact-output (specified leg = output = currency0)
    ///   - zeroForOne = false → user pays currency1, receives currency0
    ///   - specifiedTokenIs0 = (false == false) = true → unspecified is currency1 (input)
    ///   - delta layout: amount0 > 0 (received), amount1 < 0 (paid)
    ///   - Fee SIZE must derive from |amount1| (unspecified leg)
    ///   - Fee CURRENCY (accruedFees key) must be currency1
    function test_afterSwap_ExactOutput_AccruedFeesMatchPMDelta() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: false,
            amountSpecified: int256(500_000),
            sqrtPriceLimitX96: 0
        });
        // amount0 > 0 (received), amount1 < 0 (paid). |amount1| = 1_000_000 → fee = 3_000
        BalanceDelta delta = toBalanceDelta(int128(500_000), int128(-1_000_000));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(int256(feeAmount), int256(3_000), "fee size must come from |amount1|");
        assertEq(hook.accruedFees(TOKEN1), 3_000, "TOKEN1 (unspecified) credited");
        assertEq(hook.accruedFees(TOKEN0), 0, "TOKEN0 (specified) untouched");
        // Returned int128 == credited amount → PoolManager hookDeltaUnspecified will exactly
        // match what we tracked internally. No bucket drift.
    }

    /// @notice Sanity: exact-input still routes to unspecified (output) currency.
    ///   - amountSpecified < 0, zeroForOne=true: user pays currency0 (specified, exact),
    ///     receives currency1 (unspecified). amount0 = -|amountSpec|, amount1 > 0.
    ///   - specifiedTokenIs0 = (true == true) = true → unspecified is currency1.
    function test_afterSwap_ExactInput_StillCorrect() public {
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(1_000_000),
            sqrtPriceLimitX96: 0
        });
        // amount0 = -1_000_000 (paid exact), amount1 = 2_000_000 (received). Fee on |amount1|.
        BalanceDelta delta = toBalanceDelta(int128(-1_000_000), int128(2_000_000));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        assertEq(int256(feeAmount), int256(6_000), "exact-input fee on output");
        assertEq(hook.accruedFees(TOKEN1), 6_000, "TOKEN1 (output, unspecified) credited");
        assertEq(hook.accruedFees(TOKEN0), 0, "TOKEN0 (input, specified) untouched");
    }

    // ─────────────────────────────────────────────────────────────────────
    // M-3: First-ever executeSyncAccruedFees respects the 7-day cooldown
    // ─────────────────────────────────────────────────────────────────────

    function test_executeSyncAccruedFees_FirstCallRespectsCooldown() public {
        // Seed some accruedFees so the sync target is realistic.
        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(-10_000_000), int128(20_000_000));
        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        // accruedFees[TOKEN1] is now 60_000. Owner proposes a downward sync to 50_000.
        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 50_000);

        // Wait the 24h proposal delay only — first-ever sync MUST still revert on cooldown.
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(owner);
        vm.expectRevert(bytes("SYNC_COOLDOWN"));
        hook.executeSyncAccruedFees(TOKEN1);

        // Warp to deploymentTime + 7 days (the cooldown anchor). deploymentTime == setUp's
        // block.timestamp, so we need to be ≥ deploymentTime + 7d.
        uint256 deployTime = hook.deploymentTime();
        vm.warp(deployTime + 7 days);
        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);
        assertEq(hook.accruedFees(TOKEN1), 50_000, "sync should land after cooldown");
        assertEq(hook.lastSyncExecuted(TOKEN1), block.timestamp, "lastSyncExecuted updated");
    }
}
