// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// AUDIT FIX 2026-05-23 M19-PORT (FeeHook follow-up): regression test for the
// `acceptOwnership` override on TegridyFeeHook — the 15th contract in the
// M19-PORT cluster. The other 14 are covered in
// `contracts/test/M19Port_AcceptOwnership_2026_05_21.t.sol`; TegridyFeeHook
// is split into its own file because the V4 hook constructor requires the
// deploy address to satisfy the lower-14-bit permission mask
// (`0x0044` = afterSwap | afterSwapReturnsDelta), which forces the
// `deployCodeTo("...:TegridyFeeHook", args, 0x0044)` harness used here
// (mirrors `contracts/test/TegridyFeeHook.t.sol::setUp`).
//
// Canonical pattern (TegridyLaunchpadV2.acceptOwnership, lines 426-438):
//   propose hostile value → transferOwnership → newOwner acceptOwnership →
//   assert `_executeAfter[KEY] == 0` AND pending-value slot zeroed AND
//   slot is re-proposable. This file asserts that for all FOUR static-keyed
//   timelock proposals on TegridyFeeHook simultaneously, plus per-key
//   isolation tests so a future regression localizes cleanly.

import "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/// @dev Minimal V4 PoolManager stub. The acceptOwnership flush path never
///      touches the manager so an empty contract suffices; matches the same
///      stand-in used by `TegridyFeeHook.t.sol::MockPoolManager`.
contract MockPoolManagerM19 {
    function balanceOf(address, uint256) external pure returns (uint256) { return 0; }
}

/// @dev Mock conversion router that satisfies the `proposeAddConversionRouter`
///      `code.length != 0 && != 23` and `router.WETH() == hook.WETH()` checks
///      so the timelock proposal slot can be set up via the real propose path
///      rather than `vm.store` hacking.
contract MockConversionRouterM19 {
    address public immutable _weth;
    constructor(address w) { _weth = w; }
    function WETH() external view returns (address) { return _weth; }
    function swapExactTokensForETH(uint256, uint256, address[] calldata, address, uint256)
        external pure returns (uint256[] memory amounts)
    {
        return new uint256[](0);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

contract M19PortFeeHook_AcceptOwnership_Test is Test {
    TegridyFeeHook public hook;
    MockPoolManagerM19 public poolManager;
    MockConversionRouterM19 public routerA; // staged for CONVERSION_ROUTER_ADD
    MockConversionRouterM19 public routerB; // staged for CONVERSION_ROUTER_REMOVE

    address public deployer;
    address public distributor = makeAddr("distributor");
    address public newOwner = makeAddr("newOwner");
    address public hostileAddr = makeAddr("hostile");
    address public weth = makeAddr("weth");

    uint256 public constant INITIAL_FEE = 30;
    uint256 public constant HOSTILE_FEE = 99; // ≤ MAX_FEE_BPS (100)

    function setUp() public {
        deployer = address(this);
        poolManager = new MockPoolManagerM19();

        // V4 hook permission mask: lower 14 bits == 0x0044
        // (afterSwap 0x0040 | afterSwapReturnsDelta 0x0004). Use deployCodeTo
        // rather than mining a CREATE2 salt — same trick used by every other
        // TegridyFeeHook test in this repo.
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(
            IPoolManager(address(poolManager)),
            distributor,
            INITIAL_FEE,
            deployer,
            weth
        );
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));

        routerA = new MockConversionRouterM19(weth);
        routerB = new MockConversionRouterM19(weth);
    }

    // ─── Helper: stage a pending CONVERSION_ROUTER_REMOVE proposal ──────────
    //
    // REMOVE requires the target router to already be allowlisted, which
    // requires a successful propose+execute ADD round-trip first. We do that
    // up front so the test body can stack all four pending proposals cleanly.
    function _allowlistRouterB() internal {
        hook.proposeAddConversionRouter(address(routerB));
        // CONVERSION_ROUTER_DELAY = 48h.
        vm.warp(block.timestamp + 48 hours);
        hook.executeAddConversionRouter();
        assertTrue(hook.allowedConversionRouter(address(routerB)), "setup: routerB not allowlisted");
        // executeAdd clears _executeAfter[CONVERSION_ROUTER_ADD] back to 0.
        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()),
            "setup: ADD slot not cleared after execute");
    }

    // ─── M19-PORT-FEEHOOK-MULTI ─ all 4 proposals flushed in one accept ─────

    function test_M19PORT_FEEHOOK_acceptOwnership_flushesAllFourStaticKeys() public {
        _allowlistRouterB();

        // Stage all four pending proposals as the outgoing (hostile) owner.
        hook.proposeRemoveConversionRouter(address(routerB));
        hook.proposeFeeChange(HOSTILE_FEE);
        hook.proposeDistributorChange(hostileAddr);
        hook.proposeAddConversionRouter(address(routerA));

        // Sanity: all four slots are pending pre-handoff.
        assertTrue(hook.hasPendingProposal(hook.FEE_CHANGE()),               "pre: FEE_CHANGE not pending");
        assertTrue(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()),       "pre: DISTRIBUTOR_CHANGE not pending");
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()),    "pre: ROUTER_ADD not pending");
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()), "pre: ROUTER_REMOVE not pending");
        assertEq(hook.pendingFee(),                  HOSTILE_FEE,         "pre: pendingFee mirror");
        assertEq(hook.pendingDistributor(),          hostileAddr,         "pre: pendingDistributor mirror");
        assertEq(hook.pendingConversionRouterAdd(),  address(routerA),    "pre: pendingConversionRouterAdd mirror");
        assertEq(hook.pendingConversionRouterRemove(), address(routerB),  "pre: pendingConversionRouterRemove mirror");

        // Hand off ownership; the override fires on acceptance.
        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();
        assertEq(hook.owner(), newOwner, "ownership did not transfer");

        // All four slots cleared.
        assertFalse(hook.hasPendingProposal(hook.FEE_CHANGE()),               "post: FEE_CHANGE not flushed");
        assertFalse(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()),       "post: DISTRIBUTOR_CHANGE not flushed");
        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()),    "post: ROUTER_ADD not flushed");
        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()), "post: ROUTER_REMOVE not flushed");
        assertEq(hook.pendingFee(),                    0,            "post: pendingFee not zero");
        assertEq(hook.pendingDistributor(),            address(0),   "post: pendingDistributor not zero");
        assertEq(hook.pendingConversionRouterAdd(),    address(0),   "post: pendingConversionRouterAdd not zero");
        assertEq(hook.pendingConversionRouterRemove(), address(0),   "post: pendingConversionRouterRemove not zero");

        // New owner can re-propose without `ExistingProposalPending`.
        vm.startPrank(newOwner);
        hook.proposeFeeChange(50);
        hook.proposeDistributorChange(makeAddr("safeDistributor"));
        hook.proposeAddConversionRouter(address(routerA));
        // routerB is still allowlisted from setup, so REMOVE is still valid.
        hook.proposeRemoveConversionRouter(address(routerB));
        vm.stopPrank();
        assertTrue(hook.hasPendingProposal(hook.FEE_CHANGE()),               "repropose: FEE_CHANGE");
        assertTrue(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()),       "repropose: DISTRIBUTOR_CHANGE");
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()),    "repropose: ROUTER_ADD");
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()), "repropose: ROUTER_REMOVE");
    }

    // ─── Per-key isolation tests ────────────────────────────────────────────

    function test_M19PORT_FEEHOOK_acceptOwnership_flushesFeeChange() public {
        hook.proposeFeeChange(HOSTILE_FEE);
        assertTrue(hook.hasPendingProposal(hook.FEE_CHANGE()));
        assertEq(hook.pendingFee(), HOSTILE_FEE);

        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();

        assertFalse(hook.hasPendingProposal(hook.FEE_CHANGE()));
        assertEq(hook.pendingFee(), 0);

        vm.prank(newOwner);
        hook.proposeFeeChange(50);
        assertTrue(hook.hasPendingProposal(hook.FEE_CHANGE()));
    }

    function test_M19PORT_FEEHOOK_acceptOwnership_flushesDistributorChange() public {
        hook.proposeDistributorChange(hostileAddr);
        assertTrue(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()));
        assertEq(hook.pendingDistributor(), hostileAddr);

        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();

        assertFalse(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()));
        assertEq(hook.pendingDistributor(), address(0));

        vm.prank(newOwner);
        hook.proposeDistributorChange(makeAddr("safeDistributor"));
        assertTrue(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()));
    }

    function test_M19PORT_FEEHOOK_acceptOwnership_flushesConversionRouterAdd() public {
        hook.proposeAddConversionRouter(address(routerA));
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()));
        assertEq(hook.pendingConversionRouterAdd(), address(routerA));

        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();

        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()));
        assertEq(hook.pendingConversionRouterAdd(), address(0));

        vm.prank(newOwner);
        hook.proposeAddConversionRouter(address(routerA));
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()));
    }

    function test_M19PORT_FEEHOOK_acceptOwnership_flushesConversionRouterRemove() public {
        _allowlistRouterB();
        hook.proposeRemoveConversionRouter(address(routerB));
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()));
        assertEq(hook.pendingConversionRouterRemove(), address(routerB));

        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();

        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()));
        assertEq(hook.pendingConversionRouterRemove(), address(0));

        // routerB still allowlisted (REMOVE never executed), so the new owner
        // can re-stage the same hostile-cancellation we just flushed.
        vm.prank(newOwner);
        hook.proposeRemoveConversionRouter(address(routerB));
        assertTrue(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()));
    }

    // ─── No-op safety ───────────────────────────────────────────────────────
    //
    // Override must be safe when no proposals are pending (no spurious events,
    // no reverts). Guards the `_executeAfter[KEY] != 0` short-circuit.

    function test_M19PORT_FEEHOOK_acceptOwnership_noPendingProposals_isNoop() public {
        assertFalse(hook.hasPendingProposal(hook.FEE_CHANGE()));
        assertFalse(hook.hasPendingProposal(hook.DISTRIBUTOR_CHANGE()));
        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_ADD()));
        assertFalse(hook.hasPendingProposal(hook.CONVERSION_ROUTER_REMOVE()));

        hook.transferOwnership(newOwner);
        vm.prank(newOwner);
        hook.acceptOwnership();

        assertEq(hook.owner(), newOwner);
        // Mirror slots remain zero — override didn't accidentally touch them.
        assertEq(hook.pendingFee(),                    0);
        assertEq(hook.pendingDistributor(),            address(0));
        assertEq(hook.pendingConversionRouterAdd(),    address(0));
        assertEq(hook.pendingConversionRouterRemove(), address(0));
    }
}
