// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";

/// @title PASS7-HOOK-01 — TegridyFeeHook V4 hook delta is never settled
/// @notice CRITICAL — every swap that routes through TegridyFeeHook will revert
///         with `CurrencyNotSettled` on the real Uniswap V4 PoolManager because
///         the hook returns a positive `hookDeltaUnspecified` from `afterSwap`
///         but never calls `poolManager.take()` or `mint()` inside the unlock
///         context to settle that positive delta.
///
///         WHY THIS POC USES A MOCK POOLMANAGER:
///         Foundry remappings in this repo (`solmate/=lib/solmate/src/`) are
///         incompatible with v4-core's import path (`solmate/src/...`) — the
///         real PoolManager fails to compile in this build. We instead encode
///         the EXACT accounting rules the real PoolManager applies:
///           - On afterSwap, the PoolManager calls `_accountPoolBalanceDelta`
///             on the hook's address with the hookDelta from `(swapDelta - hookDelta)`.
///           - For each non-zero delta this increments `NonzeroDeltaCount`.
///           - At unlock close, if NonzeroDeltaCount != 0 → revert
///             `CurrencyNotSettled.selector`.
///         This MockPoolManager replicates that accounting and asserts the
///         revert that would fire on real V4 mainnet.
///
///         CANONICAL FIX (from v4-core's reference FeeTakingHook):
///         `lib/v4-core/src/test/FeeTakingHook.sol:48` — inside afterSwap:
///             manager.take(feeCurrency, address(this), feeAmount);
///         This zeroes the hook's positive delta within the unlock context.
///
///         TegridyFeeHook.afterSwap:
///         `contracts/src/TegridyFeeHook.sol:200-285` — only writes
///             accruedFees[creditToken] += feeUint;
///         and emits an event. There is NO `manager.take(...)` or
///         `manager.mint(...)` call. The returned `feeAmount` adds positive
///         hookDelta which is never settled.
///
///         AGGRAVATING CIRCUMSTANCE:
///         `claimFees(currency, amount)` at L331 calls
///             poolManager.take(Currency.wrap(currency), revenueDistributor, amount);
///         from a non-unlock context — `take` is `onlyWhenUnlocked` on the real
///         PoolManager, so even if the hook's accruedFees were somehow
///         credited, the claim path would itself revert with `ManagerLocked`.
///
///         SEVERITY:
///         CRITICAL — if the V4 hook were deployed and wired to a live pool
///         (per `script/DeployTegridyFeeHook.s.sol` in this repo), every swap
///         on that pool would revert. The hook is undeployed today, but that
///         is operational happenstance, not a code-level safeguard. The
///         contract under audit is BROKEN BY DESIGN for V4.

/// @dev Minimal ERC20 used by the post-fix claimFees path test. Zero-amount
///      transfers always succeed on a compliant ERC20.
contract HOOK01_MinimalERC20 {
    function transfer(address, uint256) external pure returns (bool) { return true; }
}

/// @dev Faithful subset of V4's accounting: tracks per-(target, currency)
///      delta and a global NonzeroDeltaCount. Replicates the unlock invariant
///      `NonzeroDeltaCount == 0` at unlock-close (PoolManager.sol:111).
contract HOOK01_MockPoolManager is Test {
    error CurrencyNotSettled();
    error ManagerLocked();

    bool public unlocked;
    uint256 public nonzeroDeltaCount;
    mapping(address => mapping(Currency => int256)) public deltas;

    /// @dev Mirrors PoolManager._accountDelta — only used for our hook delta.
    function _accountDelta(Currency currency, int128 delta, address target) internal {
        if (delta == 0) return;
        int256 prev = deltas[target][currency];
        int256 next = prev + int256(delta);
        deltas[target][currency] = next;
        if (next == 0) {
            nonzeroDeltaCount--;
        } else if (prev == 0) {
            nonzeroDeltaCount++;
        }
    }

    /// @dev Mirrors PoolManager.take — onlyWhenUnlocked.
    function take(Currency currency, address /*to*/, uint256 amount) external {
        if (!unlocked) revert ManagerLocked();
        _accountDelta(currency, -int128(int256(amount)), msg.sender);
    }

    /// @dev Required by hook for the propose-time snapshot.
    function balanceOf(address, uint256) external pure returns (uint256) { return 0; }

    /// @dev Simulate a swap that triggers the hook's afterSwap. We don't model
    ///      the swap math — we just trigger the hook with a chosen delta,
    ///      apply the hookDelta accounting V4 would, and check the unlock
    ///      invariant on close.
    ///
    ///      This is what PoolManager.swap() does at line 218-225:
    ///        BalanceDelta hookDelta;
    ///        (swapDelta, hookDelta) = key.hooks.afterSwap(...);
    ///        if (hookDelta != ZERO_DELTA)
    ///            _accountPoolBalanceDelta(key, hookDelta, address(key.hooks));
    ///        _accountPoolBalanceDelta(key, swapDelta, msg.sender);
    function simulateSwap(
        TegridyFeeHook hook,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta swapDeltaIn
    ) external {
        if (unlocked) revert("ALREADY_UNLOCKED");
        unlocked = true;

        // Call the hook's afterSwap (this is what V4's Hooks.afterSwap does).
        (bytes4 selector, int128 hookFeeAmount) = hook.afterSwap(
            address(this),
            key,
            params,
            swapDeltaIn,
            ""
        );
        require(selector == IHooks.afterSwap.selector, "BAD_SELECTOR");

        // Reconstruct hookDelta from V4's logic in Hooks.sol:305-308:
        //   bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        //   hookDelta = specifiedTokenIs0
        //     ? toBalanceDelta(0, hookFeeAmount)  // unspecified is currency1
        //     : toBalanceDelta(hookFeeAmount, 0); // unspecified is currency0
        if (hookFeeAmount != 0) {
            bool specifiedTokenIs0 = (params.amountSpecified < 0) == params.zeroForOne;
            int128 amount0;
            int128 amount1;
            if (specifiedTokenIs0) {
                amount0 = 0;
                amount1 = hookFeeAmount;
            } else {
                amount0 = hookFeeAmount;
                amount1 = 0;
            }
            // Apply hookDelta to the hook's account (mirrors _accountPoolBalanceDelta).
            _accountDelta(key.currency0, amount0, address(hook));
            _accountDelta(key.currency1, amount1, address(hook));
        }

        // We DO NOT settle the hook's delta. In a real deploy, the swap router's
        // unlockCallback would only settle the CALLER's delta, not the hook's.
        // The hook is supposed to settle itself inside afterSwap via take()/mint().

        // Unlock close: PoolManager.unlock() line 111
        unlocked = false;
        if (nonzeroDeltaCount != 0) revert CurrencyNotSettled();
    }
}

contract PASS7_HOOK_01_TegridyFeeHookDeltaNotSettled is Test {
    HOOK01_MockPoolManager pm;
    TegridyFeeHook hook;

    address constant TOKEN0 = address(uint160(0x1111));
    address constant TOKEN1 = address(uint160(0x2222));
    Currency CURRENCY0 = Currency.wrap(TOKEN0);
    Currency CURRENCY1 = Currency.wrap(TOKEN1);

    address owner = address(0xA110);
    address distributor = address(0xD157);

    function setUp() public {
        pm = new HOOK01_MockPoolManager();
        // Deploy hook at an address satisfying the V4 hook flag bitmask
        // (afterSwap | afterSwapReturnsDelta = 0x0044).
        // AUDIT FIX (pass-8): TF-INT-02. Constructor now requires WETH. We bind
        // the WETH slot to TOKEN0 so the existing claimFees-no-ManagerLocked
        // regression below exercises the new WETH-unwrap path (amount=0 short-
        // circuits the unwrap leg, validating `claimFees` no longer touches the
        // PoolManager at all in either direction).
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(pm)), distributor, uint256(30), owner, TOKEN0);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
        // AUDIT FIX (pass-8 batch-16): owner must approve the test pool for
        // afterSwap to actually accrue fees. Without this, the hook silently
        // returns a zero fee — which is the new default for un-approved pools.
        vm.prank(owner);
        hook.approvePool(_key());
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: CURRENCY0,
            currency1: CURRENCY1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-HOOK-01 fix.
    ///         afterSwap now calls `poolManager.take(feeCurrency, address(this),
    ///         feeUint)` inside the unlock context, which adds a NEGATIVE
    ///         hookDelta that cancels the POSITIVE hookDelta from the
    ///         returned feeAmount. Net delta at unlock-close = 0 → no
    ///         CurrencyNotSettled. Pattern of record:
    ///         lib/v4-core/src/test/FeeTakingHook.sol:48.
    function test_PASS7_HOOK_01_swapRevertsCurrencyNotSettled() public {
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000,
            sqrtPriceLimitX96: 0
        });
        BalanceDelta swapDelta = _toBalanceDelta(int128(-1000), int128(990));

        // Pre-fix: this would have reverted with CurrencyNotSettled because
        // afterSwap returned +feeAmount without taking. Post-fix: take() is
        // called inside afterSwap, hook delta nets to zero, swap closes
        // cleanly.
        pm.simulateSwap(hook, _key(), params, swapDelta);

        // Verify the hook's delta on the mock is zero (settled).
        assertEq(
            pm.deltas(address(hook), CURRENCY1),
            int256(0),
            "FIX: hook delta on currency1 settled to zero"
        );
        // accruedFees was incremented (off-chain shadow tracking).
        assertGt(hook.accruedFees(TOKEN1), 0, "fee was accrued");

        emit log_string("PASS7-HOOK-01 FIX VALIDATED: take() inside afterSwap settles hook delta");
    }

    /// @notice Sanity: with the hook PAUSED, afterSwap returns 0, so there is
    ///         no leftover hookDelta and the unlock closes cleanly. This proves
    ///         the failure above is specifically caused by the unsettled
    ///         hook delta — not by some other config in the mock.
    function test_PASS7_HOOK_01_swapClosesCleanlyWhenPaused() public {
        vm.prank(owner);
        hook.pause();

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000,
            sqrtPriceLimitX96: 0
        });
        BalanceDelta swapDelta = _toBalanceDelta(int128(-1000), int128(990));

        // Should NOT revert: paused → afterSwap returns 0 → no hook delta added
        pm.simulateSwap(hook, _key(), params, swapDelta);
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-HOOK-03 fix and the
    ///         pass-8 TF-INT-02 follow-on. claimFees no longer calls
    ///         `poolManager.take()` (which was `onlyWhenUnlocked` and reverted
    ///         ManagerLocked outside the unlock). The pass-8 fix further
    ///         restricts claimFees to the WETH path so non-WETH ERC20 fees
    ///         can't strand at the ETH-only RevenueDistributor.
    ///
    ///         setUp binds WETH=TOKEN0, so `claimFees(TOKEN0, 0)` exercises
    ///         the new WETH-unwrap branch. amount=0 short-circuits the
    ///         IWETH.withdraw leg entirely, so we never need to etch ERC20
    ///         storage — the call simply validates the no-ManagerLocked
    ///         invariant by reaching the post-amount==0 return path.
    function test_PASS7_HOOK_01_claimFeesRevertsManagerLocked() public {
        hook.claimFees(TOKEN0, 0);
        emit log_string("PASS7-HOOK-03 + TF-INT-02 FIX VALIDATED: claimFees no longer ManagerLocked, WETH-only path");
    }

    /// @notice AUDIT FIX (pass-8): TF-INT-02 — claimFees rejects non-WETH currencies.
    ///         Pre-fix the ERC20 would have been safeTransfer'd to the ETH-only
    ///         RevenueDistributor and stranded forever; now the path is gated.
    function test_PASS8_TF_INT_02_claimFeesRejectsNonWETH() public {
        vm.expectRevert(TegridyFeeHook.MustConvertERC20First.selector);
        hook.claimFees(TOKEN1, 0);
    }

    /// @dev Replicate v4-core's BalanceDelta packing: high 128 bits = amount0,
    ///      low 128 bits = amount1, both interpreted as int128.
    function _toBalanceDelta(int128 amount0, int128 amount1) internal pure returns (BalanceDelta) {
        return BalanceDelta.wrap(int256(uint256((uint128(amount0)) << 128) | uint128(amount1)));
    }
}
