// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyFeeHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title PASS8 batch-16 — TegridyFeeHook PoolKey allowlist
/// @notice Validates the pass-8 batch-16 fix that closes the
///         "any-pool-can-attach-this-hook-and-credit-fake-fees" surface.
///         Pre-fix, an attacker could deploy a V4 pool with attacker-
///         controlled tokens, attach this hook (allowed by V4 since
///         the hook only enforces an address-bit pattern), and trigger
///         `afterSwap` to accrue `accruedFees[<malicious token>]`,
///         later draining via `convertERC20FeesToETH`. Post-fix, only
///         owner-approved PoolKeys actually accrue fees; un-approved
///         pools get a zero-fee return (the swap still completes).

// ─── Mocks ───────────────────────────────────────────────────────────

contract HOOKAL_MockPoolManager {
    /// @dev V4-shape `take` no-op so afterSwap's `poolManager.take(feeCurrency, hook, feeUint)`
    ///      call (post-batch-9 HOOK-01 settlement fix) doesn't revert in tests.
    function take(Currency, address, uint256) external pure {}
    function swap() external pure returns (bool) { return true; }
}

contract PASS8_HOOK_ALLOWLIST is Test {
    HOOKAL_MockPoolManager pm;
    TegridyFeeHook hook;

    address constant TOKEN0 = address(uint160(0x1111));
    address constant TOKEN1 = address(uint160(0x2222));
    address constant TOKEN_MAL = address(uint160(0x9999));
    address constant HOOK_ADDR = address(uint160(0x0044));

    address owner = address(0xA110);
    address distributor = address(0xD157);

    function setUp() public {
        pm = new HOOKAL_MockPoolManager();
        address wethSentinel = makeAddr("weth_hookal");
        bytes memory args = abi.encode(IPoolManager(address(pm)), distributor, uint256(30), owner, wethSentinel);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, HOOK_ADDR);
        hook = TegridyFeeHook(payable(HOOK_ADDR));
    }

    function _key(address t0, address t1) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(t0),
            currency1: Currency.wrap(t1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _params() internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
    }

    function _delta(int128 a0, int128 a1) internal pure returns (BalanceDelta) {
        return BalanceDelta.wrap(int256(uint256((uint128(a0)) << 128) | uint128(a1)));
    }

    /// @notice Un-approved pool: afterSwap returns 0 fee, no accrual.
    function test_hookAllowlist_unapprovedPool_returnsZero() public {
        PoolKey memory key = _key(TOKEN_MAL, TOKEN1);
        BalanceDelta swapDelta = _delta(int128(-1000000), int128(990000));

        vm.prank(address(pm));
        (bytes4 sel, int128 feeAmt) = hook.afterSwap(address(0), key, _params(), swapDelta, "");

        assertEq(sel, IHooks.afterSwap.selector, "selector still returned");
        assertEq(feeAmt, int128(0), "feeAmt is zero for unapproved pool");
        assertEq(hook.accruedFees(TOKEN_MAL), 0, "no accrual on unapproved pool");
        assertEq(hook.accruedFees(TOKEN1), 0, "no accrual on unapproved pool");
    }

    /// @notice Approved pool: afterSwap accrues fees normally.
    function test_hookAllowlist_approvedPool_accruesFees() public {
        PoolKey memory key = _key(TOKEN0, TOKEN1);
        vm.prank(owner);
        hook.approvePool(key);
        assertTrue(hook.approvedPools(keccak256(abi.encode(key))), "pool registered");

        BalanceDelta swapDelta = _delta(int128(-1000000), int128(990000));

        vm.prank(address(pm));
        (, int128 feeAmt) = hook.afterSwap(address(0), key, _params(), swapDelta, "");

        // Exact-input, zeroForOne=true → fee on output (currency1) = |990000| * 30 / 10000 = 2970
        assertGt(feeAmt, int128(0), "fee accrued on approved pool");
        assertGt(hook.accruedFees(TOKEN1), 0, "currency1 accrual non-zero");
    }

    /// @notice Revoked pool stops accruing on subsequent swaps.
    function test_hookAllowlist_revokedPool_stopsAccruing() public {
        PoolKey memory key = _key(TOKEN0, TOKEN1);
        vm.prank(owner);
        hook.approvePool(key);

        BalanceDelta swapDelta = _delta(int128(-1000000), int128(990000));
        vm.prank(address(pm));
        hook.afterSwap(address(0), key, _params(), swapDelta, "");
        uint256 accruedAfterFirst = hook.accruedFees(TOKEN1);
        assertGt(accruedAfterFirst, 0, "first swap accrued");

        vm.prank(owner);
        hook.revokePool(key);
        assertFalse(hook.approvedPools(keccak256(abi.encode(key))), "pool revoked");

        // Second swap on the revoked pool: zero fee.
        vm.prank(address(pm));
        (, int128 feeAmt) = hook.afterSwap(address(0), key, _params(), swapDelta, "");
        assertEq(feeAmt, int128(0), "no fee accrual after revoke");
        assertEq(hook.accruedFees(TOKEN1), accruedAfterFirst, "accrual unchanged after revoke");
    }

    /// @notice Approving and revoking each emit their respective events.
    function test_hookAllowlist_emitsEvents() public {
        PoolKey memory key = _key(TOKEN0, TOKEN1);
        bytes32 h = keccak256(abi.encode(key));

        vm.expectEmit(true, true, true, false);
        emit TegridyFeeHook.PoolApproved(h, TOKEN0, TOKEN1);
        vm.prank(owner);
        hook.approvePool(key);

        vm.expectEmit(true, false, false, false);
        emit TegridyFeeHook.PoolRevoked(h);
        vm.prank(owner);
        hook.revokePool(key);
    }

    /// @notice Non-owner approve/revoke reverts.
    function test_hookAllowlist_onlyOwner() public {
        PoolKey memory key = _key(TOKEN0, TOKEN1);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        hook.approvePool(key);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        hook.revokePool(key);
    }

    /// @notice Different PoolKeys hash to different slots — `fee` field
    ///         change alone changes the approval lookup.
    function test_hookAllowlist_differentFeeTier_distinctApproval() public {
        PoolKey memory keyA = _key(TOKEN0, TOKEN1);
        PoolKey memory keyB = _key(TOKEN0, TOKEN1);
        keyB.fee = 500; // different fee tier — different PoolKey

        vm.prank(owner);
        hook.approvePool(keyA);

        // keyA approved, keyB not.
        assertTrue(hook.approvedPools(keccak256(abi.encode(keyA))));
        assertFalse(hook.approvedPools(keccak256(abi.encode(keyB))));

        // afterSwap on keyB returns zero (not approved).
        BalanceDelta swapDelta = _delta(int128(-1000000), int128(990000));
        vm.prank(address(pm));
        (, int128 feeAmt) = hook.afterSwap(address(0), keyB, _params(), swapDelta, "");
        assertEq(feeAmt, int128(0), "different fee-tier PoolKey not approved");
    }
}
