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
    // Tracks per-(holder, currencyId) credit balance the FeeHook reads via
    // `poolManager.balanceOf(...)` in DEEP-D-AMM-M4's propose-time snapshot.
    mapping(address => mapping(uint256 => uint256)) internal _bal;
    function take(Currency, address, uint256) external pure {}
    function balanceOf(address holder, uint256 id) external view returns (uint256) {
        return _bal[holder][id];
    }
    function setBalance(address holder, uint256 id, uint256 amount) external {
        _bal[holder][id] = amount;
    }
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
        // AUDIT FIX (pass-8): TF-INT-02. Constructor now requires WETH; pass a sentinel
        // — no test in this file exercises the WETH unwrap or convert paths.
        address wethSentinel = makeAddr("weth_r031");
        deployCodeTo(
            "TegridyFeeHook.sol:TegridyFeeHook",
            abi.encode(IPoolManager(address(mockPM)), distributor, uint256(30), owner, wethSentinel),
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

        // AUDIT FIX: DEEP-D-AMM-M4 — propose snapshots `poolManager.balanceOf(this, currencyId)`.
        // Seed the mock so the snapshot >= proposed actualCredit.
        uint256 currencyId = uint256(uint160(TOKEN1));
        mockPM.setBalance(address(hook), currencyId, 100_000);

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
        uint256 t0 = 7 days + 1;
        vm.warp(t0);

        PoolKey memory key = _mkKey();
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10_000_000),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(10_000_000), int128(-20_000_000));
        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        // AUDIT FIX: DEEP-D-AMM-M4 — seed mock balance for the snapshot cap.
        uint256 currencyId = uint256(uint160(TOKEN1));
        mockPM.setBalance(address(hook), currencyId, 100_000);

        // First sync
        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 50_000);
        uint256 t1 = t0 + 24 hours + 1;
        vm.warp(t1);
        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);
        // lastSyncExecuted[TOKEN1] is now t1.

        // Reseed accrued.
        vm.prank(address(mockPM));
        hook.afterSwap(address(0), key, params, delta, "");

        // Second propose
        vm.prank(owner);
        hook.proposeSyncAccruedFees(TOKEN1, 40_000);
        // Warp to satisfy the 24h timelock but NOT the 7d cooldown.
        uint256 t2 = t1 + 24 hours + 1;
        vm.warp(t2);
        vm.prank(owner);
        vm.expectRevert(bytes("SYNC_COOLDOWN"));
        hook.executeSyncAccruedFees(TOKEN1);

        // Now warp 7d past lastSyncExecuted = t1 → cooldown clears.
        uint256 t3 = t1 + 7 days + 1;
        if (t3 < t2) t3 = t2 + 1;
        vm.warp(t3);
        vm.prank(owner);
        hook.executeSyncAccruedFees(TOKEN1);
        assertEq(hook.accruedFees(TOKEN1), 40_000, "second sync after cooldown");
    }

    // ===== AUDIT FIX C-2: V4 BalanceDelta sign convention regression tests =====
    //
    // V4 PoolManager passes `delta` from the SWAPPER's perspective:
    //   negative delta = swapper paid (input)
    //   positive delta = swapper received (output)
    //
    // The hook fee must be computed from the UNSPECIFIED-side delta (the leg
    // PoolManager solved for, which is opposite to amountSpecified).
    //
    // Pre-fix the hook computed the fee from the WRONG side, which meant for a
    // decimals-mismatched pair like WETH→USDC the fee was sized in input raw
    // units (1e18 wei) but credited as output currency raw units (USDC at 6
    // decimals = $3 BILLION phantom credit) — causing PoolManager settlement
    // to revert and DoS'ing every swap in that direction.
    //
    // These tests use REAL V4-convention deltas to assert the fee is computed
    // off the unspecified-side delta in absolute terms.

    function test_C2_realV4_exactInput_zeroForOne_feeScalesWithOutput() public {
        PoolKey memory key = _mkKey();
        // WETH→USDC exact-input 1 WETH, ~3000 USDC out.
        // V4 convention: amount0 < 0 (paid), amount1 > 0 (received).
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(1 ether),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(-int256(1 ether)), int128(int256(3000e6)));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        // feeBps = 30 (0.3%). Fee should be 30 / 10000 of |output| = 9e6 USDC base units.
        // Pre-fix this would have been (1e18 * 30 / 10000) = 3e15 USDC base units
        // (~$3 billion phantom credit) — causing real PoolManager settlement to revert.
        assertEq(int256(feeAmount), int256(9e6), "fee = output * 30 / 10000");
        assertEq(hook.accruedFees(TOKEN1), 9e6, "credit on output currency (TOKEN1)");
        assertEq(hook.accruedFees(TOKEN0), 0, "input currency NOT credited");
    }

    function test_C2_realV4_exactInput_oneForZero_feeScalesWithOutput() public {
        PoolKey memory key = _mkKey();
        // USDC→WETH exact-input 3000 USDC, ~1 WETH out.
        // V4 convention: amount1 < 0 (paid), amount0 > 0 (received).
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: false,
            amountSpecified: -int256(3000e6),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(int256(1 ether)), int128(-int256(3000e6)));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        // Fee should be 30 / 10000 of |output WETH| = 3e15 wei.
        // Pre-fix this would have been (3000e6 * 30 / 10000) = 9e6 wei
        // — under-collecting by ~12 orders of magnitude.
        assertEq(int256(feeAmount), int256(3e15), "fee = output * 30 / 10000");
        assertEq(hook.accruedFees(TOKEN0), 3e15, "credit on output currency (TOKEN0)");
        assertEq(hook.accruedFees(TOKEN1), 0, "input currency NOT credited");
    }

    function test_C2_realV4_exactOutput_zeroForOne_feeScalesWithInput() public {
        PoolKey memory key = _mkKey();
        // Want EXACTLY 3000 USDC out (currency1), pay ~1 WETH in (currency0).
        // V4 convention: amount0 < 0 (paid), amount1 > 0 (received).
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: int256(3000e6),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(-int256(1 ether)), int128(int256(3000e6)));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        // For exact-output, the unspecified side is the INPUT (currency0).
        // Fee = 30 / 10000 of |input WETH| = 3e15 wei.
        assertEq(int256(feeAmount), int256(3e15), "fee = input * 30 / 10000");
        assertEq(hook.accruedFees(TOKEN0), 3e15, "credit on input currency (TOKEN0)");
        assertEq(hook.accruedFees(TOKEN1), 0, "output currency NOT credited");
    }

    function test_C2_realV4_exactOutput_oneForZero_feeScalesWithInput() public {
        PoolKey memory key = _mkKey();
        // Want EXACTLY 1 WETH out (currency0), pay ~3000 USDC in (currency1).
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: false,
            amountSpecified: int256(1 ether),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(int256(1 ether)), int128(-int256(3000e6)));

        vm.prank(address(mockPM));
        (, int128 feeAmount) = hook.afterSwap(address(0), key, params, delta, "");

        // Fee = 30 / 10000 of |input USDC| = 9e6 USDC base units.
        assertEq(int256(feeAmount), int256(9e6), "fee = input * 30 / 10000");
        assertEq(hook.accruedFees(TOKEN1), 9e6, "credit on input currency (TOKEN1)");
        assertEq(hook.accruedFees(TOKEN0), 0, "output currency NOT credited");
    }
}
